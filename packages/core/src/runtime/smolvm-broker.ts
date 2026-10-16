import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import { isPublicRepositoryAddress } from "../agent/repository-acquisition.js";
import type { EvolutionExecution } from "../improvement/types.js";
import type { InteractiveExecutionChannel } from "./interactive.js";
import { resolveSmolvmImage } from "./smolvm.js";
import { runSmolvmDarwinProgram, type SmolvmDarwinOwnership } from "./smolvm-darwin.js";

const ADMISSION = "/run/0-workbench/admission.json";
const GUEST_ROOT = "/run/0-workbench/broker";
/** Guest-only scratch in each fresh sibling; never a host workspace mount. */
export const WORKBENCH_BROKER_WORKSPACE = "/tmp/0-workspace";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REFERENCE = /^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9_.:/-]*@sha256:[a-f0-9]{64})$/;
const POLL_MS = 15;
const RECORD_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 4096;
const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;

export interface WorkbenchBrokerProgram {
  profile: "offline" | "http";
  command: readonly string[];
  workspaceRoot: string;
  stdin?: string;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  maxOutputBytes: number;
  imageReference?: string;
  httpTarget?: string;
}
export interface WorkbenchBrokerLimits {
  maxJobs: number;
  maxRequests: number;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  maxOutputBytes: number;
  maxWorkspaceBytes: number;
  maxFiles: number;
  maxInputBytes: number;
}
export interface WorkbenchBrokerImage { reference: string; archive: string; digest: string; }
export interface WorkbenchBrokerAdmission {
  protocol: 1;
  root: string;
  runtimeId: string;
  imageDigest: string;
  allowHttp: boolean;
  approvedImages: Record<string, string>;
  limits: WorkbenchBrokerLimits;
}
export interface WorkbenchBrokerOptions {
  /** Private operator directory, NEVER mounted into the workbench. */
  root: string;
  imageArchive: string;
  imageDigest: string;
  runtimeId: string;
  /** Trusted host grant; never selected by the guest request. Defaults false. */
  allowHttp?: boolean;
  approvedImages?: readonly WorkbenchBrokerImage[];
  limits?: Partial<WorkbenchBrokerLimits>;
  binary?: string;
  ownership?: SmolvmDarwinOwnership;
  /** Host-selected import/scratch disk budget. Never taken from a guest request. */
  storageGb?: number;
}
export interface WorkbenchBrokerController {
  /** Only this dedicated directory is shared RW with the main guest. */
  guestRoot: string;
  admission: WorkbenchBrokerAdmission;
  close(): Promise<void>;
}
interface FileRecord { path: string; digest: string; data: string; mode: number; }
interface BrokerRequest extends Omit<WorkbenchBrokerProgram, "workspaceRoot"> {
  protocol: 1; id: string; runtimeId: string; interactive: boolean; files: FileRecord[];
}
interface StreamRecord { type: "ready" | "stdout" | "stderr" | "file" | "complete"; data?: string; file?: FileRecord; execution?: EvolutionExecution; }
export const DEFAULT_WORKBENCH_BROKER_LIMITS: Readonly<WorkbenchBrokerLimits> = Object.freeze({
  maxJobs: 2, maxRequests: 256, timeoutMs: 600000, memoryMb: 2048, cpus: 2,
  maxOutputBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 256, maxInputBytes: 1024 * 1024,
});
function hash(data: Buffer): string { return `sha256:${createHash("sha256").update(data).digest("hex")}`; }
function problem(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safePath(path: unknown): path is string {
  return typeof path === "string" && Buffer.byteLength(path) <= 512 && !/[\x00-\x1f\x7f\\]/.test(path) && !/[\uD800-\uDFFF]/u.test(path)
    && !isAbsolute(path) && path.split("/").every(part => part !== "" && part !== "." && part !== ".." && Buffer.byteLength(part) <= 255);
}
function checkedLimits(input: Partial<WorkbenchBrokerLimits> = {}): WorkbenchBrokerLimits {
  const limits = { ...DEFAULT_WORKBENCH_BROKER_LIMITS, ...input };
  for (const [key, maximum] of Object.entries(DEFAULT_WORKBENCH_BROKER_LIMITS)) {
    const value = limits[key as keyof WorkbenchBrokerLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid broker limit: ${key}`);
  }
  if (limits.memoryMb < 32 || limits.timeoutMs < 100 || limits.maxOutputBytes < 256) throw new Error("Broker resource limits are below runtime minimums");
  return limits;
}
function mounted(path: string, readonly: boolean): boolean {
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
  return mounts.some(line => {
    const [left, right] = line.split(" - ");
    const fields = left?.split(" ");
    return fields?.[4] === path && fields[5]?.split(",").includes(readonly ? "ro" : "rw")
      && right?.split(" ")[0] === "virtiofs";
  });
}
let immutableAdmission: WorkbenchBrokerAdmission | undefined;
function admission(): WorkbenchBrokerAdmission {
  if (immutableAdmission) return immutableAdmission;
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Sibling sandbox broker requires an admitted non-root SmolVM workbench");
  // Checkout files and environment cannot manufacture the immutable virtiofs
  // admission grant. The native launcher reserves and supplies this identity.
  if (!mounted("/run/0-workbench", true) || !mounted(GUEST_ROOT, false)) throw new Error("Missing immutable SmolVM workbench admission mounts");
  const fd = openSync(ADMISSION, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid!() || info.size > 65536 || (info.mode & 0o222) !== 0 || info.nlink !== 1) throw new Error("Invalid workbench admission file");
    const marker = JSON.parse(readFileSync(fd, "utf8")) as { schemaVersion?: unknown; profile?: unknown; runtimeId?: unknown; broker?: WorkbenchBrokerAdmission };
    const broker = marker.broker;
    if (marker.schemaVersion !== 1 || marker.profile !== "smolvm-workbench" || !broker || broker.protocol !== 1 || broker.root !== GUEST_ROOT
      || typeof marker.runtimeId !== "string" || !/^[a-f0-9]{64}$/.test(marker.runtimeId)
      || broker.runtimeId !== marker.runtimeId
      || !DIGEST.test(broker.imageDigest) || typeof broker.allowHttp !== "boolean" || !broker.approvedImages || typeof broker.approvedImages !== "object") throw new Error("Workbench broker admission identity mismatch");
    broker.limits = Object.freeze(checkedLimits(broker.limits));
    for (const [reference, digest] of Object.entries(broker.approvedImages)) if (!REFERENCE.test(reference) || !DIGEST.test(digest)) throw new Error("Invalid admitted image catalog");
    return immutableAdmission = broker;
  } finally { closeSync(fd); }
}
export function isAdmittedSmolvmWorkbench(): boolean {
  if (immutableAdmission) return true;
  if (process.platform !== "linux") return false;
  try { lstatSync(ADMISSION); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  // A present but malformed workbench surface is a refusal, not permission to
  // fall back to Docker or raw local execution in a credential-bearing guest.
  admission();
  return true;
}
/** Host-declared sibling capacity, not the main guest's ambient RAM/CPU. */
export function getWorkbenchBrokerLimits(): Readonly<WorkbenchBrokerLimits> {
  return admission().limits;
}
/** An archive identity, never a host archive path or mutable image lookup. */
export function resolveWorkbenchBrokerImage(reference?: string): string {
  const grant = admission();
  if (reference === undefined || reference === grant.imageDigest) return grant.imageDigest;
  const digest = Object.hasOwn(grant.approvedImages, reference) ? grant.approvedImages[reference] : undefined;
  if (!digest) throw new Error(`Sandbox image is not explicitly approved: ${reference}`);
  return digest;
}
async function regularBytes(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new Error("Broker accepts only bounded regular files without links");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Broker file changed during handoff");
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Broker file changed during handoff");
    return bytes;
  } finally { await file.close(); }
}
async function jsonFile(path: string, maximum = RECORD_BYTES): Promise<unknown> { return JSON.parse((await regularBytes(path, maximum)).toString("utf8")); }
async function atomicJson(root: string, name: string, value: unknown, maximum = RECORD_BYTES): Promise<void> {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > maximum) throw new Error("Broker record exceeds its byte limit");
  const temporary = join(root, `${name}.${randomBytes(12).toString("hex")}.tmp`);
  try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, join(root, name)); }
  finally { await rm(temporary, { force: true }); }
}
async function snapshot(root: string, limits: WorkbenchBrokerLimits): Promise<FileRecord[]> {
  if (!isAbsolute(root) || resolve(root) !== await realpath(root) || !(await lstat(root)).isDirectory()) throw new Error("Broker workspace must be a real absolute directory without symlink ancestors");
  const files: FileRecord[] = [];
  let bytes = 0, entries = 0;
  async function walk(directory: string): Promise<void> {
    const names = await readdir(directory);
    if ((entries += names.length) > limits.maxFiles * 4) throw new Error("Broker workspace has too many filesystem entries");
    for (const name of names.sort()) {
      const path = join(directory, name), relativePath = relative(root, path).split(sep).join("/");
      if (!safePath(relativePath)) throw new Error("Invalid broker workspace path");
      const info = await lstat(path);
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new Error("Broker workspace contains a link or special file");
      if (files.length >= limits.maxFiles || bytes + info.size > limits.maxWorkspaceBytes) throw new Error("Broker workspace exceeds its file/byte limits");
      const content = await regularBytes(path, limits.maxWorkspaceBytes - bytes);
      bytes += content.length;
      files.push({ path: relativePath, digest: hash(content), data: content.toString("base64"), mode: info.mode & 0o111 ? 0o700 : 0o600 });
    }
  }
  await walk(root);
  return files;
}
function validateFiles(raw: unknown, limits: WorkbenchBrokerLimits): FileRecord[] {
  if (!Array.isArray(raw) || raw.length > limits.maxFiles) throw new Error("Invalid broker file manifest");
  const seen = new Set<string>();
  let bytes = 0;
  return raw.map(value => {
    if (!value || typeof value !== "object") throw new Error("Invalid broker file record");
    const file = value as FileRecord;
    if (!safePath(file.path) || seen.has(file.path) || !DIGEST.test(file.digest) || typeof file.data !== "string"
      || file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data)
      || ![0o600, 0o700].includes(file.mode)) throw new Error("Invalid broker file path, mode or encoding");
    const padding = file.data.indexOf("=");
    if (padding !== -1 && (padding < file.data.length - 2 || !/^={1,2}$/.test(file.data.slice(padding)))) {
      throw new Error("Invalid broker base64 padding");
    }
    seen.add(file.path);
    const content = Buffer.from(file.data, "base64");
    if ((bytes += content.length) > limits.maxWorkspaceBytes || hash(content) !== file.digest) throw new Error("Broker file manifest digest/size mismatch");
    return { path: file.path, digest: file.digest, data: file.data, mode: file.mode };
  });
}
async function materialize(root: string, files: FileRecord[]): Promise<void> {
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(file.data, "base64"), { flag: "wx", mode: file.mode });
  }
}
function checkedProgram(raw: unknown, grant: WorkbenchBrokerAdmission, expectedId: string): BrokerRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid broker request");
  const request = raw as BrokerRequest;
  const keys: Record<string, true> = { protocol: true, id: true, runtimeId: true, profile: true, command: true, stdin: true,
    timeoutMs: true, memoryMb: true, cpus: true, maxOutputBytes: true, imageReference: true, httpTarget: true, interactive: true, files: true };
  if (Object.keys(raw).some(key => !Object.hasOwn(keys, key)) || request.protocol !== 1 || request.id !== expectedId || request.runtimeId !== grant.runtimeId
    || !["offline", "http"].includes(request.profile) || typeof request.interactive !== "boolean") throw new Error("Invalid broker request identity or fields");
  if (!Array.isArray(request.command) || !request.command[0] || request.command.length > (request.profile === "http" ? 160 : 128)
    || request.command.some(arg => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 8192)
    || Buffer.byteLength(JSON.stringify(request.command)) > (request.profile === "http" ? 96 * 1024 : 65536)) throw new Error("Invalid bounded broker argv");
  for (const [key, minimum] of [["timeoutMs", 100], ["memoryMb", 32], ["cpus", 1], ["maxOutputBytes", 256]] as const) {
    if (!Number.isSafeInteger(request[key]) || request[key] < minimum) throw new Error(`Invalid broker ${key}`);
    request[key] = Math.min(request[key], grant.limits[key]);
  }
  if (request.stdin !== undefined && (typeof request.stdin !== "string" || Buffer.byteLength(request.stdin) > grant.limits.maxInputBytes)) throw new Error("Broker stdin exceeds its limit");
  if (request.imageReference !== undefined && (typeof request.imageReference !== "string" || !REFERENCE.test(request.imageReference))) throw new Error("Broker image reference must be immutable and explicitly approved");
  if (request.profile === "offline" && request.httpTarget !== undefined) throw new Error("Offline sandbox cannot grant an HTTP target");
  if (request.profile === "http" && !grant.allowHttp) throw new Error("The workbench operator did not grant HTTP sandbox networking");
  request.files = validateFiles(request.files, grant.limits);
  return request;
}
async function httpCommand(request: BrokerRequest, signal: AbortSignal): Promise<string[]> {
  if (request.interactive || typeof request.httpTarget !== "string" || Buffer.byteLength(request.httpTarget) > 8192) throw new Error("HTTP broker requires a bounded declarative request, not an interactive program");
  const url = new URL(request.httpTarget);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !host || /^(?:localhost|.*\.localhost)$/i.test(host)) throw new Error("HTTP broker requires a public HTTP(S) URL without userinfo");
  const argv = request.command;
  const prefix = ["curl", "--disable", "--globoff", "--silent", "--show-error", "--request"];
  if (!prefix.every((arg, index) => argv[index] === arg) || !/^[A-Za-z]{1,32}$/.test(argv[6] ?? "")) throw new Error("HTTP broker permits only declarative curl requests");
  const fixed = ["--max-time", argv[8]!, "--proto", "=http,https", "--proto-redir", "=http,https", "--max-redirs", "0", "--noproxy", "*", "--output", "-", "--write-out", "%{stderr}\n__ZERO_HTTP_STATUS__:%{http_code}\n"];
  if (!fixed.every((arg, index) => argv[index + 7] === arg) || !/^[0-9]+(?:\.[0-9]+)?$/.test(argv[8] ?? "")
    || Number(argv[8]) <= 0 || Number(argv[8]) > request.timeoutMs / 1000) throw new Error("HTTP broker curl policy mismatch");
  let index = 21, headerBytes = 0, headers = 0;
  while (argv[index] === "--header") {
    const header = argv[index + 1];
    if (typeof header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[^\r\n\0]*$/.test(header)
      || ++headers > 64 || (headerBytes += Buffer.byteLength(header)) > 65536) throw new Error("Invalid bounded HTTP header");
    index += 2;
  }
  if (argv[index] === "--data-binary" && argv[index + 1] === "@-") index += 2;
  if (argv[index] !== "--" || argv[index + 1] !== request.httpTarget || argv.length !== index + 2) throw new Error("HTTP broker rejects additional curl flags, files, redirects or destinations");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: Array<{ address: string; family: number }>) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("HTTP broker DNS resolution exceeded its deadline")), Math.min(5000, request.timeoutMs));
    const abort = () => finish(new Error("HTTP broker DNS resolution cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else void lookup(host, { all: true }).then(result => finish(undefined, result), error => finish(error));
  });
  if (!addresses.length || addresses.some(({ address }) => !isPublicRepositoryAddress(address))) throw new Error("HTTP broker refuses private, loopback, reserved or mixed DNS destinations");
  if (isIP(host)) return [...argv];
  const address = addresses[0]!;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const pinned = address.family === 6 ? `[${address.address}]` : address.address;
  return [...argv.slice(0, index), "--resolve", `${host}:${port}:${pinned}`, ...argv.slice(index)];
}

// This transport program executes ONLY in the fresh sibling VM. Its output is
// untrusted: the host verifies every frame/path/hash before writing handoffs.
// The source/control mounts are RO; scratch is fresh non-root guest-owned /tmp.
const SIBLING_TRANSPORT = String.raw`
const fs = require('node:fs'), p = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync('/control/program.json', 'utf8'));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const digest = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const workspace = ${JSON.stringify(WORKBENCH_BROKER_WORKSPACE)};
// A fresh guest must not contain this path, including a dangling symlink.
fs.mkdirSync(workspace,{mode:0o700});
const workspaceInfo = fs.lstatSync(workspace);
for (const file of cfg.files) {
 const destination = p.join(workspace,file.path);
 fs.mkdirSync(p.dirname(destination),{recursive:true,mode:0o700});
 fs.copyFileSync(p.join('/snapshot',file.blob),destination,fs.constants.COPYFILE_EXCL);
 fs.chmodSync(destination,file.mode);
}
const child = cp.spawn(cfg.command[0],cfg.command.slice(1),{cwd:workspace,env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/tmp',LANG:'C.UTF-8',TMPDIR:'/tmp'},stdio:['pipe','pipe','pipe']});
let count=0, input=0, pending='', failed=false;
const fail = msg => { if(!failed){failed=true;send({type:'transportError',error:msg});child.kill('SIGKILL');} };
for(const [stream,type] of [[child.stdout,'stdout'],[child.stderr,'stderr']]) stream.on('data', b=>{ count+=b.length; if(count>cfg.maxOutputBytes) return fail('sandbox output limit exceeded'); for(let off=0;off<b.length;off+=32768) send({type,data:b.subarray(off,off+32768).toString('base64')}); });
child.stdin.on('error',e=>{if(e.code!=='EPIPE')fail('sandbox stdin failed');});
process.stdin.setEncoding('utf8');
process.stdin.on('data',s=>{pending+=s;if(pending.length>131072)return fail('sandbox input record too large');let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const v=JSON.parse(line);if(v.type==='end'){child.stdin.end();continue;}if(v.type!=='input'||typeof v.data!=='string')throw Error();const b=Buffer.from(v.data,'base64');input+=b.length;if(input>cfg.maxInputBytes)throw Error();child.stdin.write(b);}catch{fail('invalid sandbox input record');}}});
child.on('error',e=>fail('sandbox command unavailable: '+e.message));
child.on('spawn',()=>send({type:'ready'}));
child.on('close',(code,signal)=>{
 let bytes=0,files=0,entries=0;
 try {
  const current = fs.lstatSync(workspace);
  if(!current.isDirectory()||current.dev!==workspaceInfo.dev||current.ino!==workspaceInfo.ino)throw Error('sandbox workspace was replaced');
  const walk=dir=>{const names=fs.readdirSync(dir).sort();entries+=names.length;if(entries>cfg.maxFiles*4)throw Error('sandbox artifact entry limit');for(const name of names){const path=p.join(dir,name), rel=p.relative(workspace,path),st=fs.lstatSync(path);if(st.isDirectory()){walk(path);continue;}if(!st.isFile()||st.nlink!==1)throw Error('sandbox artifact is not a regular unlinked file');if(++files>cfg.maxFiles||bytes+st.size>cfg.maxWorkspaceBytes)throw Error('sandbox artifact limit');const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let b;try{const a=fs.fstatSync(fd);b=fs.readFileSync(fd);const z=fs.fstatSync(fd);if(!a.isFile()||a.nlink!==1||a.size!==z.size||a.mtimeMs!==z.mtimeMs||b.length!==a.size)throw Error('sandbox artifact changed');}finally{fs.closeSync(fd);}bytes+=b.length;send({type:'file',file:{path:rel,digest:digest(b),data:b.toString('base64'),mode:st.mode&0o111?448:384}});}};
  walk(workspace); send({type:'done',exitCode:code,error:failed?'sandbox transport failed':signal?'sandbox process signalled '+signal:undefined});
 } catch(e) { send({type:'done',exitCode:code,error:e.message}); }
 process.stdin.destroy();
});
`;

/** No sockets, host service, guest host paths, environment or image archives. */
export async function startWorkbenchBroker(options: WorkbenchBrokerOptions): Promise<WorkbenchBrokerController> {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() === 0) throw new Error("Host sibling broker requires the qualified non-root Apple Silicon backend");
  if (!isAbsolute(options.root) || !/^[a-f0-9]{64}$/.test(options.runtimeId) || !DIGEST.test(options.imageDigest)) throw new Error("Invalid trusted broker startup identity");
  const limits = checkedLimits(options.limits);
  const storageGb = options.storageGb ?? 20;
  if (!Number.isSafeInteger(storageGb) || storageGb < 1 || storageGb > 64) throw new Error("Invalid trusted broker storage budget");
  if (options.approvedImages && (!Array.isArray(options.approvedImages) || options.approvedImages.length > 32)) throw new Error("Broker catalog exceeds its approved image limit");
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  if (resolve(options.root) !== await realpath(options.root)) throw new Error("Broker private root cannot traverse symlinks");
  const rootInfo = await lstat(options.root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid!() || (rootInfo.mode & 0o077)) throw new Error("Broker root must be private and operator-owned");
  const privateRoot = await mkdtemp(join(options.root, "broker-"));
  const guestRoot = join(privateRoot, "requests");
  const images = new Map<string, { archive: string; digest: string }>();
  const approvedImages: Record<string, string> = Object.create(null) as Record<string, string>;
  let closing = false, failedCleanup = false, requests = 0;
  const jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  const seen = new Set<string>();
  let polling: Promise<void>;
  try {
    await mkdir(guestRoot, { mode: 0o700 });
    async function approve(archive: string, digest: string, index: number): Promise<string> {
      if (!DIGEST.test(digest) || !isAbsolute(archive) || resolve(archive) !== await realpath(archive)) throw new Error("Invalid trusted broker image archive");
      // The native executor copies and verifies this immutable approved input
      // again per run. The catalog never reads a path supplied by a guest.
      const file = join(privateRoot, `image-${index}.tar`);
      const info = await lstat(archive);
      if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > 8 * 1024 ** 3) throw new Error("Invalid approved broker archive file");
      await copyFile(archive, file, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(file, 0o400);
      if (await resolveSmolvmImage(file) !== digest) throw new Error("Approved broker archive copy identity mismatch");
      return file;
    }
    const defaultArchive = await approve(options.imageArchive, options.imageDigest, 0);
    images.set(options.imageDigest, { archive: defaultArchive, digest: options.imageDigest });
    for (const [index, image] of (options.approvedImages ?? []).entries()) {
      if (!REFERENCE.test(image.reference) || images.has(image.reference)) throw new Error("Broker catalog needs distinct immutable image references");
      const archive = await approve(image.archive, image.digest, index + 1);
      images.set(image.reference, { archive, digest: image.digest });
      images.set(image.digest, { archive, digest: image.digest });
      approvedImages[image.reference] = image.digest;
      approvedImages[image.digest] = image.digest;
    }
    const grant: WorkbenchBrokerAdmission = { protocol: 1, root: GUEST_ROOT, runtimeId: options.runtimeId, imageDigest: options.imageDigest,
      allowHttp: options.allowHttp === true, approvedImages, limits };
    async function execute(id: string, raw: unknown, abort: AbortController): Promise<void> {
      let sequence = 0, sentBytes = 0, recordCount = 0, queue: StreamRecord[] = [];
      let writerDone = false, writerError: unknown, workspace: string | undefined;
      const emit = (record: StreamRecord) => {
        const bytes = Buffer.byteLength(JSON.stringify(record));
        if (++recordCount > MAX_RECORDS || (sentBytes += bytes) > MAX_PROTOCOL_BYTES || queue.length >= 256) throw new Error("Broker stream exceeds its bounded capacity");
        queue.push(record);
      };
      const flush = (async () => {
        while (!writerDone || queue.length) {
          const record = queue.shift();
          if (record) {
            // Large artifacts have already been bounded. Each occupies one
            // bounded response file; stdout/stdin use small ordered records.
            await atomicJson(guestRoot, `${id}.output.${sequence++}.json`, record, MAX_REQUEST_BYTES);
          } else await delay(POLL_MS);
        }
      })().catch(error => { writerError = error; abort.abort(error); });
      let execution: EvolutionExecution = { exitCode: null, stdout: "", stderr: "", durationMs: 0, timedOut: false };
      const start = performance.now();
      try {
        const request = checkedProgram(raw, grant, id);
        let cancelled = false;
        try { await regularBytes(join(guestRoot, `${id}.cancel.json`), 1024); cancelled = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (cancelled || abort.signal.aborted) throw new Error("Workbench sandbox cancelled before VM admission");
        const image = images.get(request.imageReference ?? options.imageDigest);
        if (!image) throw new Error(`Sandbox image is not explicitly approved: ${request.imageReference}`);
        const command = request.profile === "http" ? await httpCommand(request, abort.signal) : [...request.command];
        workspace = await mkdtemp(join(privateRoot, "job-"));
        const source = join(workspace, "source"), control = join(workspace, "control");
        await mkdir(source, { mode: 0o700 }); await mkdir(control, { mode: 0o700 });
        // Guest names are never materialized on macOS: APFS can fold case and
        // Unicode normalization. Opaque RO blobs preserve Linux POSIX identity.
        const manifest: Array<{ path: string; mode: number; blob: string }> = [];
        for (const [index, file] of request.files.entries()) {
          const blob = `${index}.blob`;
          await writeFile(join(source, blob), Buffer.from(file.data, "base64"), { flag: "wx", mode: 0o400 });
          manifest.push({ path: file.path, mode: file.mode, blob });
        }
        await writeFile(join(control, "program.json"), JSON.stringify({ command, files: manifest, maxOutputBytes: request.maxOutputBytes,
          maxInputBytes: limits.maxInputBytes, maxWorkspaceBytes: limits.maxWorkspaceBytes, maxFiles: limits.maxFiles }), { flag: "wx", mode: 0o400 });
        const returned: FileRecord[] = [];
        const returnedPaths = new Set<string>();
        let returnedBytes = 0;
        let pending = "", protocolError: unknown, ready = false, done: { exitCode: number | null; error?: string } | undefined;
        let stdoutBytes = 0, stderrBytes = 0, inputSequence = 0, inputBytes = 0;
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let writeInput: ((data: string) => void) | undefined;
        const ingest = (chunk: string) => {
          pending += chunk;
          // File frames can be larger than stdio frames, but never unbounded.
          if (Buffer.byteLength(pending) > MAX_REQUEST_BYTES) throw new Error("Sibling transport frame exceeds its byte limit");
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            const frame = JSON.parse(line) as { type: string; data?: string; file?: FileRecord; exitCode?: number | null; error?: string };
            if (frame.type === "ready" && !ready && !done) { ready = true; emit({ type: "ready" }); }
            else if ((frame.type === "stdout" || frame.type === "stderr") && ready && !done && typeof frame.data === "string") {
              const data = Buffer.from(frame.data, "base64");
              if (data.length > 32768) throw new Error("Sibling stdio frame exceeds its byte limit");
              if (frame.type === "stdout") { stdoutBytes += data.length; stdout.push(data); }
              else { stderrBytes += data.length; stderr.push(data); }
              if (stdoutBytes + stderrBytes > request.maxOutputBytes) throw new Error("Sibling stdio exceeded its byte limit");
              emit({ type: frame.type, data: data.toString("base64") });
            } else if (frame.type === "file" && ready && !done) {
              const file = validateFiles([frame.file], limits)[0]!;
              if (returnedPaths.has(file.path) || returned.length >= limits.maxFiles
                || (returnedBytes += Buffer.byteLength(file.data, "base64")) > limits.maxWorkspaceBytes) throw new Error("Sibling artifact manifest exceeds its limits or repeats a path");
              returnedPaths.add(file.path); returned.push(file);
            } else if (frame.type === "done" && ready && !done && (frame.exitCode === null || (Number.isInteger(frame.exitCode) && frame.exitCode! >= 0 && frame.exitCode! <= 255))
              && (frame.error === undefined || typeof frame.error === "string" && Buffer.byteLength(frame.error) <= 8192)) {
              done = { exitCode: frame.exitCode!, ...(frame.error ? { error: frame.error } : {}) };
            } else throw new Error("Invalid or out-of-order sibling transport frame");
          }
        };
        let inputDone = false;
        const inputPump = (async () => {
          while (!inputDone && !abort.signal.aborted) {
            if (writeInput) {
              try {
                const path = join(guestRoot, `${id}.input.${inputSequence}.json`);
                const rawInput = await jsonFile(path) as { type?: unknown; data?: unknown };
                if (rawInput.type !== "input" || typeof rawInput.data !== "string" || Object.keys(rawInput).length !== 2) throw new Error("Invalid broker stdin record");
                const data = Buffer.from(rawInput.data, "base64");
                if ((inputBytes += data.length) > limits.maxInputBytes || ++inputSequence > MAX_RECORDS) throw new Error("Broker stdin exceeds its bounded capacity");
                writeInput(JSON.stringify({ type: "input", data: data.toString("base64") }) + "\n");
                await rm(path, { force: true });
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            }
            try { await regularBytes(join(guestRoot, `${id}.cancel.json`), 1024); abort.abort(new Error("Workbench sandbox cancelled")); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            await delay(POLL_MS);
          }
        })().catch(error => { protocolError = error; abort.abort(error); });
        try {
          const nativeOptions = { imageArchive: image.archive, imageDigest: image.digest, binary: options.binary,
            command: ["node", "--eval", SIBLING_TRANSPORT], mounts: [{ source, target: "/snapshot" }, { source: control, target: "/control" }],
            timeoutMs: request.timeoutMs, memoryMb: request.memoryMb, cpus: request.cpus,
            storageGb, maxOutputBytes: MAX_PROTOCOL_BYTES, signal: abort.signal,
            channel: { onReady(writer: (data: string) => void) {
              writeInput = writer;
              if (request.stdin) {
                const bytes = Buffer.from(request.stdin); inputBytes += bytes.length;
                for (let offset = 0; offset < bytes.length; offset += 32768) writer(JSON.stringify({ type: "input", data: bytes.subarray(offset, offset + 32768).toString("base64") }) + "\n");
              }
              if (!request.interactive) writer('{"type":"end"}\n');
            }, onData(chunk: string) { try { ingest(chunk); } catch (error) { protocolError = error; abort.abort(error); } } },
          };
          const native = await runSmolvmDarwinProgram(nativeOptions, request.profile === "http", options.ownership);
          execution = { ...native, stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"), stderr: Buffer.concat(stderr, stderrBytes).toString("utf8") };
          if (native.cleanupFailed) {
            failedCleanup = true; closing = true;
            for (const job of jobs.values()) job.abort.abort(new Error("Sibling VM teardown was not confirmed"));
          }
          if (protocolError) execution.error = problem(protocolError);
          else if (done && !native.error) { execution.exitCode = done.exitCode; if (done.error) execution.error = done.error; }
          else execution.error ??= "Sibling VM did not complete its bounded handoff protocol";
          if (pending) execution.error ??= "Sibling VM left an incomplete transport record";
          if (!execution.error && !execution.cleanupFailed) for (const file of returned) emit({ type: "file", file });
        } finally { inputDone = true; await inputPump; }
      } catch (error) { execution.error = problem(error); }
      finally {
        execution.durationMs = performance.now() - start;
        if (workspace && !execution.cleanupFailed) {
          try { await rm(workspace, { recursive: true, force: true }); }
          catch (error) {
            execution.cleanupFailed = true;
            execution.error = `${execution.error ? `${execution.error}; ` : ""}Broker private handoff cleanup failed`;
            failedCleanup = true; closing = true;
            for (const job of jobs.values()) job.abort.abort(error);
          }
        }
        try { emit({ type: "complete", execution }); } catch (error) { writerError ??= error; }
        writerDone = true;
        await flush;
        if (writerError) { failedCleanup = true; closing = true; for (const job of jobs.values()) job.abort.abort(writerError); }
      }
    }
    polling = (async () => {
      while (!closing) {
        const entries = await readdir(guestRoot);
        if (entries.length > MAX_RECORDS * limits.maxJobs + 512) throw new Error("Broker request share exceeds its entry limit");
        for (const name of entries) {
          const match = /^([a-f0-9]{48})\.request\.json$/.exec(name);
          if (!match) continue;
          const id = match[1]!;
          if (seen.has(id)) continue;
          if (jobs.size >= limits.maxJobs) continue;
          if (requests >= limits.maxRequests) {
            await atomicJson(guestRoot, `${id}.output.0.json`, { type: "complete", execution: {
              exitCode: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, error: "Broker lifetime request admission limit reached",
            } });
            closing = true;
            for (const job of jobs.values()) job.abort.abort(new Error("Broker lifetime request admission limit reached"));
            break;
          }
          seen.add(id);
          const abort = new AbortController();
          requests++;
          const raw = await jsonFile(join(guestRoot, name), MAX_REQUEST_BYTES).catch(error => ({ invalid: problem(error) }));
          if (closing) break;
          const done = execute(id, raw, abort).catch(error => {
            failedCleanup = true; closing = true;
            for (const job of jobs.values()) job.abort.abort(error);
          }).finally(() => { jobs.delete(id); });
          jobs.set(id, { abort, done });
        }
        await delay(POLL_MS);
      }
    })().catch(error => { closing = true; failedCleanup = true; for (const job of jobs.values()) job.abort.abort(error); });
    let closePromise: Promise<void> | undefined;
    return { guestRoot, admission: grant, close() {
      return closePromise ??= (async () => {
        closing = true;
        for (const job of jobs.values()) job.abort.abort(new Error("Workbench broker controller closed"));
        await polling;
        await Promise.all([...jobs.values()].map(job => job.done));
        if (failedCleanup) throw new Error(`Sibling broker teardown was not confirmed; retained private root ${privateRoot}`);
        await rm(privateRoot, { recursive: true, force: true });
      })();
    } };
  } catch (error) { await rm(privateRoot, { recursive: true, force: true }); throw error; }
}

/** Guest-only client. Host paths are not part of the wire protocol. */
export async function runWorkbenchBrokerProgram(options: WorkbenchBrokerProgram, signal?: AbortSignal, channel?: InteractiveExecutionChannel): Promise<EvolutionExecution> {
  const grant = admission();
  signal?.throwIfAborted();
  const id = randomBytes(24).toString("hex");
  const initial = channel ? channel.initialInput : options.stdin;
  const { workspaceRoot: _workspaceRoot, ...program } = options;
  const request = checkedProgram({ ...program, protocol: 1, id, runtimeId: grant.runtimeId, interactive: Boolean(channel), files: [],
    ...(initial !== undefined ? { stdin: initial } : {}) }, grant, id);
  const files = await snapshot(options.workspaceRoot, grant.limits);
  request.files = files;
  const root = grant.root;
  let inputSequence = 0, outputSequence = 0, inputBytes = Buffer.byteLength(initial ?? ""), outputBytes = 0, pendingInputs: string[] = [];
  let complete = false, ready = false, inputFailure: unknown, callbackFailure: unknown;
  const returned: FileRecord[] = [];
  const returnedPaths = new Set<string>();
  let returnedBytes = 0;
  const stdoutDecoder = new StringDecoder("utf8");
  const deadline = Date.now() + request.timeoutMs + 30000;
  const inputPump = (async () => {
    while (!complete) {
      const data = pendingInputs.shift();
      if (data !== undefined) await atomicJson(root, `${id}.input.${inputSequence++}.json`, { type: "input", data });
      else await delay(POLL_MS);
    }
  })().catch(error => { inputFailure = error; });
  async function cancel(): Promise<void> { await atomicJson(root, `${id}.cancel.json`, { cancel: true }, 1024); }
  const abort = () => { void cancel().catch(error => { inputFailure ??= error; }); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await atomicJson(root, `${id}.request.json`, request, MAX_REQUEST_BYTES);
    if (signal?.aborted) abort();
    let cancellationSent = false;
    while (Date.now() < deadline) {
      if (signal?.aborted || inputFailure || callbackFailure) {
        if (!cancellationSent) { cancellationSent = true; await cancel(); }
      }
      let raw: unknown;
      const path = join(root, `${id}.output.${outputSequence}.json`);
      try { raw = await jsonFile(path, MAX_REQUEST_BYTES); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await delay(POLL_MS); continue; } throw error; }
      if (++outputSequence > MAX_RECORDS || (outputBytes += Buffer.byteLength(JSON.stringify(raw))) > MAX_PROTOCOL_BYTES) throw new Error("Broker output exceeds its bounded capacity");
      await rm(path, { force: true });
      const record = raw as StreamRecord;
      if (!record || typeof record !== "object") throw new Error("Invalid broker output record");
      if (record.type === "ready" && !ready) {
        ready = true;
        try { channel?.onReady(data => {
          if (complete || signal?.aborted) return;
          const bytes = Buffer.from(data);
          if ((inputBytes += bytes.length) > grant.limits.maxInputBytes || pendingInputs.length + Math.ceil(bytes.length / 32768) > 256 || inputSequence > MAX_RECORDS) throw new Error("Broker channel stdin exceeds its bounded capacity");
          for (let offset = 0; offset < bytes.length; offset += 32768) pendingInputs.push(bytes.subarray(offset, offset + 32768).toString("base64"));
        }); } catch (error) { callbackFailure = error; }
      } else if ((record.type === "stdout" || record.type === "stderr") && ready && typeof record.data === "string") {
        const bytes = Buffer.from(record.data, "base64");
        if (bytes.length > 32768) throw new Error("Invalid broker stdio record");
        if (record.type === "stdout" && channel && !callbackFailure) {
          try { channel.onData(stdoutDecoder.write(bytes)); } catch (error) { callbackFailure = error; }
        }
      } else if (record.type === "file" && ready) {
        const file = validateFiles([record.file], grant.limits)[0]!;
        if (returnedPaths.has(file.path) || returned.length >= grant.limits.maxFiles
          || (returnedBytes += Buffer.byteLength(file.data, "base64")) > grant.limits.maxWorkspaceBytes) throw new Error("Broker artifact manifest exceeds its limits or repeats a path");
        returnedPaths.add(file.path); returned.push(file);
      }
      else if (record.type === "complete" && record.execution) {
        const execution = record.execution;
        // Native limits count raw bytes; invalid UTF-8 can expand each byte to
        // a three-byte replacement character when represented as a string.
        if (typeof execution.stdout !== "string" || typeof execution.stderr !== "string" || typeof execution.timedOut !== "boolean"
          || Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr) > request.maxOutputBytes * 3
          || execution.error !== undefined && (typeof execution.error !== "string" || Buffer.byteLength(execution.error) > 8192)
          || execution.cleanupFailed !== undefined && typeof execution.cleanupFailed !== "boolean"
          || !Number.isFinite(execution.durationMs) || execution.durationMs < 0 || (execution.exitCode !== null && (!Number.isInteger(execution.exitCode) || execution.exitCode < 0 || execution.exitCode > 255))) throw new Error("Invalid broker completion proof");
        complete = true;
        const trailing = stdoutDecoder.end();
        if (trailing && channel && !callbackFailure) {
          try { channel.onData(trailing); } catch (error) { callbackFailure = error; }
        }
        if (callbackFailure || inputFailure) execution.error = problem(callbackFailure ?? inputFailure);
        if (!execution.error && !execution.cleanupFailed) {
          // A staging sibling avoids writing through generated symlinks. Verify
          // the original guest directory again before replacing its contents.
          const current = await snapshot(options.workspaceRoot, grant.limits);
          if (JSON.stringify(current) !== JSON.stringify(files)) throw new Error("Guest workspace changed while sibling VM was executing");
          const stage = await mkdtemp(join(dirname(options.workspaceRoot), ".0-handoff-"));
          try {
            await materialize(stage, returned);
            await chmod(stage, 0o700);
            const old = `${stage}-old`;
            await rename(options.workspaceRoot, old);
            try { await rename(stage, options.workspaceRoot); }
            catch (error) { await rename(old, options.workspaceRoot); throw error; }
            await rm(old, { recursive: true, force: true });
          } finally { await rm(stage, { recursive: true, force: true }); }
        }
        return execution;
      } else throw new Error("Invalid or out-of-order broker output record");
    }
    await cancel();
    return { exitCode: null, stdout: "", stderr: "", durationMs: request.timeoutMs + 30000, timedOut: true, cleanupFailed: true, error: "Broker completion/teardown proof did not arrive before the bounded deadline" };
  } finally {
    const acknowledged = complete;
    if (!acknowledged) await cancel().catch(() => {});
    complete = true;
    signal?.removeEventListener("abort", abort);
    await inputPump;
    // Do not remove an unacknowledged cancellation: a queued host request must
    // observe it before admitting a VM. Flat acknowledged files only.
    if (acknowledged) for (const name of await readdir(root)) if (name.startsWith(`${id}.`)) await rm(join(root, name), { force: true }).catch(() => {});
  }
}
