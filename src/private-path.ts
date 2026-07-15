import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type PrivatePathKind = "file" | "directory";

export class PrivatePathError extends Error {}

interface PrivatePathDependencies {
  platform: NodeJS.Platform;
  execute(command: string, args: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  inspect(path: string): {
    dev: number;
    ino: number;
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
  };
}

const defaults: PrivatePathDependencies = {
  platform: process.platform,
  execute: (command, args, env) => spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    env,
  }),
  inspect: (path) => lstatSync(path),
};

function windowsScript(kind: PrivatePathKind, apply: boolean): string {
  const flags = kind === "directory"
    ? "[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'"
    : "[System.Security.AccessControl.InheritanceFlags]::None";
  const pathInfo = kind === "directory"
    ? "[System.IO.DirectoryInfo]::new($p)"
    : "[System.IO.FileInfo]::new($p)";
  return [
    "$p=$env:AGENT_BRIDGE_PRIVATE_PATH",
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$sid=$identity.User",
    "$tokenOwner=$identity.Owner",
    `$pathInfo=${pathInfo}`,
    "$pathInfo.Refresh()",
    "if(($pathInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){exit 25}",
    `$flags=${flags}`,
    "$sections=[System.Security.AccessControl.AccessControlSections]([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)",
    "$before=$pathInfo.GetAccessControl($sections)",
    "$beforeOwner=$before.GetOwner([System.Security.Principal.SecurityIdentifier])",
    "$beforeMatchesUser=$false",
    "$beforeMatchesToken=$false",
    "if($null -ne $beforeOwner){$beforeMatchesUser=$beforeOwner.Equals($sid);if($null -ne $tokenOwner){$beforeMatchesToken=$beforeOwner.Equals($tokenOwner)}}",
    "if(-not $beforeMatchesUser -and -not $beforeMatchesToken){Write-Output (\"explicit owner present {0}; matches user {1}; matches token {2}\" -f ($null -ne $beforeOwner),$beforeMatchesUser,$beforeMatchesToken);exit 24}",
    ...(apply ? [
      "$acl=$before",
      "$acl.SetAccessRuleProtection($true,$false)",
      "$existingRules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
      "foreach($existing in $existingRules){$acl.RemoveAccessRuleSpecific($existing)}",
      "$acl.SetOwner($sid)",
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
      "$acl.AddAccessRule($rule)",
      "$pathInfo.SetAccessControl($acl)",
    ] : []),
    `$checkPathInfo=${pathInfo}`,
    "$checkPathInfo.Refresh()",
    "if(($checkPathInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){exit 25}",
    "$check=$checkPathInfo.GetAccessControl($sections)",
    "$owner=$check.GetOwner([System.Security.Principal.SecurityIdentifier])",
    "$ownerMatches=$false",
    "if($null -ne $owner){$ownerMatches=$owner.Equals($sid)}",
    "$rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
    "$ruleMatches=$false",
    "$ruleInherited=$true",
    "$ruleAllow=$false",
    "$rightsExact=$false",
    "$inheritanceExact=$false",
    "$propagationExact=$false",
    "if($rules.Count -eq 1){$ruleSid=$rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]);$ruleMatches=$ruleSid.Equals($sid);$ruleInherited=$rules[0].IsInherited;$ruleAllow=$rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow;$rightsExact=$rules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl;$inheritanceExact=$rules[0].InheritanceFlags -eq $flags;$propagationExact=$rules[0].PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None}",
    "if(-not $ownerMatches -or -not $check.AreAccessRulesProtected -or $rules.Count -ne 1 -or -not $ruleMatches -or $ruleInherited -or -not $ruleAllow -or -not $rightsExact -or -not $inheritanceExact -or -not $propagationExact){Write-Output (\"final owner {0}; protected {1}; rules {2}; sid {3}; inherited {4}; allow {5}; rights {6}; inheritance {7}; propagation {8}\" -f $ownerMatches,$check.AreAccessRulesProtected,$rules.Count,$ruleMatches,$ruleInherited,$ruleAllow,$rightsExact,$inheritanceExact,$propagationExact);exit 23}",
  ].join(";");
}

function windowsPrivatePath(
  path: string,
  kind: PrivatePathKind,
  apply: boolean,
  dependencies: PrivatePathDependencies,
): void {
  const before = dependencies.inspect(path);
  if (before.isSymbolicLink()
    || (kind === "file" ? !before.isFile() : !before.isDirectory())) {
    throw new PrivatePathError("private Windows paths cannot be symlinks, junctions, or reparse objects");
  }
  const result = dependencies.execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", windowsScript(kind, apply),
  ], { ...process.env, AGENT_BRIDGE_PRIVATE_PATH: path });
  if (result.status !== 0) {
    const phase = result.status === 23
      ? `final ACL verification failed${result.stdout.trim() ? ` (${result.stdout.trim()})` : ""}`
      : result.status === 24
        ? `the existing owner is not trusted${result.stdout.trim() ? ` (${result.stdout.trim()})` : ""}`
        : result.status === 25
          ? "the path is a reparse object"
          : "the native ACL command failed";
    throw new PrivatePathError(`${apply
      ? "cannot apply"
      : "path does not satisfy"} the current-user private path policy: ${phase}`);
  }
  const after = dependencies.inspect(path);
  if (after.isSymbolicLink()
    || (kind === "file" ? !after.isFile() : !after.isDirectory())
    || after.dev !== before.dev || after.ino !== before.ino) {
    throw new PrivatePathError("private Windows path identity changed during policy validation");
  }
}

function posixPrivatePath(path: string, kind: PrivatePathKind, apply: boolean): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink()
    || (kind === "file" ? !details.isFile() : !details.isDirectory())) {
    throw new PrivatePathError("private path has the wrong file type");
  }
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new PrivatePathError("private path must be owned by the current user");
  }
  const mode = kind === "file" ? 0o600 : 0o700;
  if (apply) chmodSync(path, mode);
  const secured = lstatSync(path);
  if ((secured.mode & 0o777) !== mode) {
    throw new PrivatePathError("private path permissions are not owner-only");
  }
}

export function securePrivatePath(
  path: string,
  kind: PrivatePathKind,
  dependencies: PrivatePathDependencies = defaults,
): void {
  if (dependencies.platform === "win32") windowsPrivatePath(path, kind, true, dependencies);
  else posixPrivatePath(path, kind, true);
}

export function verifyPrivatePathAccess(
  path: string,
  kind: PrivatePathKind,
  dependencies: PrivatePathDependencies = defaults,
): void {
  if (dependencies.platform === "win32") windowsPrivatePath(path, kind, false, dependencies);
  else posixPrivatePath(path, kind, false);
}

/** Prepare an immediate parent and reject link-like file locations before use. */
export function preparePrivateFileLocation(path: string, createParent = false): string {
  const target = resolve(path);
  const parent = dirname(target);
  const parentExisted = existsSync(parent);
  if (createParent && !parentExisted) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existsSync(parent)) throw new PrivatePathError("private path parent does not exist");
  if (!parentExisted) securePrivatePath(parent, "directory");
  verifyPrivatePathAccess(parent, "directory");
  if (existsSync(target)) verifyPrivatePathAccess(target, "file");
  return target;
}

/** Apply and verify owner-only policy for a SQLite database and live sidecars. */
export function securePrivateSqliteFiles(path: string): void {
  if (path === ":memory:") return;
  const target = resolve(path);
  verifyPrivatePathAccess(dirname(target), "directory");
  for (const candidate of [target, `${target}-wal`, `${target}-shm`]) {
    if (!existsSync(candidate)) continue;
    securePrivatePath(candidate, "file");
    verifyPrivatePathAccess(candidate, "file");
  }
}

export function preparePrivateSqliteLocation(path: string, createParent = false): string {
  if (path === ":memory:") return path;
  const target = preparePrivateFileLocation(path, createParent);
  for (const candidate of [`${target}-wal`, `${target}-shm`]) {
    if (existsSync(candidate)) securePrivatePath(candidate, "file");
  }
  return target;
}
