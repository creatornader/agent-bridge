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
  return [
    "$p=$env:AGENT_BRIDGE_PRIVATE_PATH",
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$sid=$identity.User",
    "$tokenOwner=$identity.Owner",
    "$beforeItem=Get-Item -Force -LiteralPath $p",
    "if(($beforeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){exit 25}",
    "$before=Get-Acl -LiteralPath $p",
    "$beforeOwner=$before.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "if($beforeOwner -ne $sid.Value -and ($null -eq $tokenOwner -or $beforeOwner -ne $tokenOwner.Value)){exit 24}",
    ...(apply ? [
      "$acl=$before",
      "$acl.SetAccessRuleProtection($true,$false)",
      "foreach($existing in @($acl.Access)){$acl.RemoveAccessRuleSpecific($existing)}",
      "$acl.SetOwner($sid)",
      `$flags=${flags}`,
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
      "$acl.AddAccessRule($rule)",
      "Set-Acl -LiteralPath $p -AclObject $acl",
    ] : []),
    "$check=Get-Acl -LiteralPath $p",
    "$afterItem=Get-Item -Force -LiteralPath $p",
    "if(($afterItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){exit 25}",
    "$owner=$check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$rules=@($check.Access)",
    "if($owner -ne $sid.Value -or -not $check.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 23}",
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
      ? "final ACL verification failed"
      : result.status === 24
        ? "the existing owner is not trusted"
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
    if (existsSync(candidate)) verifyPrivatePathAccess(candidate, "file");
  }
  return target;
}
