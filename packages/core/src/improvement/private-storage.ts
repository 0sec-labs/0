import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WindowsStorageAcl {
  currentUser: string;
  owner: string;
  hasDacl: boolean;
  reparsePoint: boolean;
  rules: Array<{ sid: string; allow: boolean; inheritOnly: boolean }>;
}

/** Windows mode bits do not represent NTFS permissions (nodejs.org/api/fs.html#fschmodpath-mode-callback). */
export function isPrivateWindowsAcl(acl: WindowsStorageAcl): boolean {
  const trusted = new Set([acl.currentUser, "S-1-5-18", "S-1-5-32-544"]); // user, SYSTEM, Administrators
  return /^S-1-/.test(acl.currentUser) && trusted.has(acl.owner) && acl.hasDacl === true && acl.reparsePoint === false
    && Array.isArray(acl.rules) && acl.rules.every(rule => rule.allow === false || trusted.has(rule.sid));
}

// Fixed script; indexed environment fields carry literal paths, never code.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('ACL_STAGE:start')
$count = [int]$env:ZERO_STORAGE_ACL_PATH_COUNT
if ($count -lt 1 -or $count -gt 64) { throw 'Invalid storage path count' }
[Console]::Error.WriteLine('ACL_STAGE:parsed')
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($userSid -notmatch '^S-[0-9]+(?:-[0-9]+)+$') { throw 'Invalid native user SID' }
[Console]::Error.WriteLine('ACL_STAGE:identity')
$records = [Collections.Generic.List[string]]::new()
for ($index = 0; $index -lt $count; $index++) {
  $path = [Environment]::GetEnvironmentVariable('ZERO_STORAGE_ACL_PATH_' + $index)
  if ([string]::IsNullOrEmpty($path)) { throw 'Missing storage path' }
  [Console]::Error.WriteLine('ACL_STAGE:item')
  $reparse = $false
  $cursor = $path
  for ($depth = 0; $null -ne $cursor -and $cursor.Length -gt 0; $depth++) {
    if ($depth -gt 128) { throw 'Storage ancestry is not bounded' }
    if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $reparse = $true }
    if ($cursor -eq [IO.Path]::GetPathRoot($cursor)) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  [Console]::Error.WriteLine('ACL_STAGE:acl')
  if ([IO.Directory]::Exists($path)) { $acl = [IO.Directory]::GetAccessControl($path) } else { $acl = [IO.File]::GetAccessControl($path) }
  [Console]::Error.WriteLine('ACL_STAGE:descriptor')
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $rules = [Collections.Generic.List[string]]::new()
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($sid -notmatch '^S-[0-9]+(?:-[0-9]+)+$') { throw 'Invalid native ACL SID' }
    $allow = ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow).ToString().ToLowerInvariant()
    $inheritOnly = (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0).ToString().ToLowerInvariant()
    $rules.Add('{"sid":"' + $sid + '","allow":' + $allow + ',"inheritOnly":' + $inheritOnly + '}')
  }
  [Console]::Error.WriteLine('ACL_STAGE:record')
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notmatch '^S-[0-9]+(?:-[0-9]+)+$') { throw 'Invalid native owner SID' }
  $hasDacl = ($null -ne $raw.DiscretionaryAcl).ToString().ToLowerInvariant()
  $reparseJson = $reparse.ToString().ToLowerInvariant()
  # SID strings originate from native SecurityIdentifier.Value (digits/hyphens), not path input.
  $records.Add('{"currentUser":"' + $userSid + '","owner":"' + $owner + '","hasDacl":' + $hasDacl + ',"reparsePoint":' + $reparseJson + ',"rules":[' + [string]::Join(',', $rules.ToArray()) + ']}')
}
[Console]::Error.WriteLine('ACL_STAGE:json')
[Console]::Out.Write('[' + [string]::Join(',', $records.ToArray()) + ']')
`;

/** Fresh read-only native ACL queries; one timeout-only retry, never cache mutable ACLs. */
export function assertPrivateStorage(entries: readonly { path: string; stat: Pick<Stats, "uid" | "mode"> }[]): void {
  if (process.platform !== "win32") {
    for (const { path, stat } of entries) {
      if ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error(`evolution storage must be owner-only: ${path}`);
    }
    return;
  }
  if (entries.length < 1 || entries.length > 64) throw new Error("Invalid storage ACL batch size");
  let validatingRecords = false;
  try {
    const pathFields = Object.fromEntries(entries.map((entry, index) => [`ZERO_STORAGE_ACL_PATH_${index}`, entry.path]));
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    let output: string;
    for (let attempt = 0; ; attempt++) {
      try {
        output = execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")], {
          env: { ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}), ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}), ...pathFields, ZERO_STORAGE_ACL_PATH_COUNT: String(entries.length), SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), TEMP: tmpdir(), TMP: tmpdir(), PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") }, cwd: systemRoot,
          encoding: "utf8", timeout: attempt === 0 ? 5_000 : 10_000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
        break;
      } catch (error) {
        // A fresh cold start gets one longer, still bounded opportunity.
        // Repeating this fixed script cannot perform an application mutation.
        // A failed ACL, malformed receipt or other launch failure is terminal.
        if (attempt === 0 && (error as { code?: unknown })?.code === "ETIMEDOUT") continue;
        throw error;
      }
    }
    validatingRecords = true;
    const records: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
    if (!Array.isArray(records) || records.length !== entries.length || !records.every(record => record && typeof record === "object" && isPrivateWindowsAcl(record as WindowsStorageAcl))) throw new Error("unsafe ACL");
  } catch (error) {
    // Only fixed codes/stages are public: native errors may contain paths or secrets.
    const native = error as { code?: unknown; status?: unknown; stderr?: unknown };
    const launch = native?.code === "ETIMEDOUT" ? "timeout"
      : native?.code === "EACCES" || native?.code === "EPERM" ? "access_denied"
      : native?.code === "ENOENT" ? "not_found"
      : typeof native?.status === "number" && native.status !== 0 ? "native_exit" : "unknown";
    const stages = new Set(["start", "parsed", "identity", "item", "acl", "descriptor", "record", "json"]);
    const observed = String(native?.stderr ?? "").match(/ACL_STAGE:[a-z]+/g)?.at(-1)?.slice(10);
    const diagnostic = validatingRecords ? "validation" : observed && stages.has(observed) ? observed : "startup";
    throw new Error("Evolution storage requires a private Windows ACL for the current user, SYSTEM and Administrators, with no reparse points. Unable to verify storage safely (native stage: " + diagnostic + "; launch: " + launch + ").");
  }
}
