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

// Fixed script; paths arrive as JSON in a dedicated environment field, never as code.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('ACL_STAGE:start')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$paths = @($env:ZERO_STORAGE_ACL_PATHS | ConvertFrom-Json)
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[Console]::Error.WriteLine('ACL_STAGE:identity')
$records = @()
foreach ($path in $paths) {
  [Console]::Error.WriteLine('ACL_STAGE:item')
  $item = Get-Item -LiteralPath $path -Force
  $reparse = $false
  $cursor = $item
  for ($depth = 0; $null -ne $cursor; $depth++) {
    if ($depth -gt 128) { throw 'Storage ancestry is not bounded' }
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $reparse = $true }
    if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
  }
  [Console]::Error.WriteLine('ACL_STAGE:acl')
  $acl = Get-Acl -LiteralPath $path
  [Console]::Error.WriteLine('ACL_STAGE:descriptor')
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow); inheritOnly = (($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) }
  })
  [Console]::Error.WriteLine('ACL_STAGE:record')
  $records += @{ currentUser = $userSid; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; hasDacl = ($null -ne $raw.DiscretionaryAcl); reparsePoint = $reparse; rules = $rules }
}
[Console]::Error.WriteLine('ACL_STAGE:json')
ConvertTo-Json -InputObject $records -Depth 5 -Compress
`;

/** One bounded native ACL query per storage operation; never cache mutable ACLs. */
export function assertPrivateStorage(entries: readonly { path: string; stat: Pick<Stats, "uid" | "mode"> }[]): void {
  if (process.platform !== "win32") {
    for (const { path, stat } of entries) {
      if ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error(`evolution storage must be owner-only: ${path}`);
    }
    return;
  }
  try {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")], {
      env: { ZERO_STORAGE_ACL_PATHS: JSON.stringify(entries.map(entry => entry.path)), SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), TEMP: tmpdir(), TMP: tmpdir(), PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") }, cwd: systemRoot,
      encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const records: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
    if (!Array.isArray(records) || records.length !== entries.length || !records.every(record => record && typeof record === "object" && isPrivateWindowsAcl(record as WindowsStorageAcl))) throw new Error("unsafe ACL");
  } catch (error) {
    // Emit only fixed stage names, never native exception text or path data.
    const diagnostic = String((error as { stderr?: unknown }).stderr ?? "").match(/ACL_STAGE:[a-z]+/g)?.at(-1)?.slice(10) ?? "startup";
    throw new Error("Evolution storage requires a private Windows ACL for the current user, SYSTEM and Administrators, with no reparse points. Unable to verify storage safely (native stage: " + diagnostic + ").");
  }
}
