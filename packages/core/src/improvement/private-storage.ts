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

// Fixed script; filesystem paths arrive as JSON on stdin, never as PowerShell code.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$paths = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$records = @()
foreach ($path in $paths) {
  $item = Get-Item -LiteralPath $path -Force
  $reparse = $false
  $cursor = $item
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $reparse = $true }
    if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
  }
  $acl = Get-Acl -LiteralPath $path
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow); inheritOnly = (($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) }
  })
  $records += @{ currentUser = $userSid; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; hasDacl = ($null -ne $raw.DiscretionaryAcl); reparsePoint = $reparse; rules = $rules }
}
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
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), TEMP: tmpdir(), TMP: tmpdir(), PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") }, cwd: systemRoot,
      input: JSON.stringify(entries.map(entry => entry.path)), encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const records: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
    if (!Array.isArray(records) || records.length !== entries.length || !records.every(record => record && typeof record === "object" && isPrivateWindowsAcl(record as WindowsStorageAcl))) throw new Error("unsafe ACL");
  } catch {
    throw new Error("Evolution storage requires a private Windows ACL for the current user, SYSTEM and Administrators, with no reparse points. Unable to verify storage safely.");
  }
}
