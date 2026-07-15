import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePrivateSqliteLocation, securePrivatePath, verifyPrivatePathAccess } from "../src/private-path.js";

function result(status: number) {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status,
    signal: null,
  };
}

function fileIdentity(symbolic = false, inode = 10) {
  return {
    dev: 1,
    ino: inode,
    isSymbolicLink: () => symbolic,
    isFile: () => true,
    isDirectory: () => false,
  };
}

function directoryIdentity(symbolic = false, inode = 20) {
  return {
    dev: 1,
    ino: inode,
    isSymbolicLink: () => symbolic,
    isFile: () => false,
    isDirectory: () => true,
  };
}

describe("private path policy", () => {
  it("accepts the user or token owner before binding a Windows path to the user SID", () => {
    let script = "";
    securePrivatePath("C:\\private\\credential.config", "file", {
      platform: "win32",
      execute: (_command, args) => {
        script = args.at(-1)!;
        return result(0);
      },
      inspect: () => fileIdentity(),
    });
    expect(script).toContain("$tokenOwner=$identity.Owner");
    expect(script).toContain("$pathInfo=[System.IO.FileInfo]::new($p)");
    expect(script).toContain("$pathInfo.Refresh()");
    expect(script).toContain("[System.Security.AccessControl.AccessControlSections]::Owner");
    expect(script).toContain("[System.Security.AccessControl.AccessControlSections]::Access");
    expect(script).toContain("$before=$pathInfo.GetAccessControl($sections)");
    expect(script).toContain("$beforeOwner=$before.GetOwner([System.Security.Principal.SecurityIdentifier])");
    expect(script).toContain("$beforeMatchesUser=$beforeOwner.Equals($sid)");
    expect(script).toContain("$beforeMatchesToken=$beforeOwner.Equals($tokenOwner)");
    expect(script).toContain("$checkPathInfo=[System.IO.FileInfo]::new($p)");
    expect(script).toContain("$check=$checkPathInfo.GetAccessControl($sections)");
    expect(script).toContain("$ownerMatches=$owner.Equals($sid)");
    expect(script).toContain("$ruleSid=$rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])");
    expect(script).toContain("$ruleMatches=$ruleSid.Equals($sid)");
    expect(script).toContain("explicit owner present");
    expect(script.indexOf("if(-not $beforeMatchesUser -and -not $beforeMatchesToken)")).toBeLessThan(script.indexOf("$pathInfo.SetAccessControl($acl)"));
    expect(script).toContain("$acl=$before");
    expect(script).toContain("$existingRules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))");
    expect(script).toContain("$acl.RemoveAccessRuleSpecific($existing)");
    expect(script).toContain("$acl.SetOwner($sid)");
    expect(script).toContain("$owner=$check.GetOwner([System.Security.Principal.SecurityIdentifier])");
    expect(script).toContain("$rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))");
    expect(script).toContain("AreAccessRulesProtected");
    expect(script).toContain("$rules[0].IsInherited");
    expect(script).toContain("FullControl");
    expect(script).toContain("$rightsExact=$rules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl");
    expect(script).toContain("$inheritanceExact=$rules[0].InheritanceFlags -eq $flags");
    expect(script).toContain("$propagationExact=$rules[0].PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None");
    expect(script).toContain("final owner {0}; protected {1}; rules {2}");
    expect(script).not.toContain("Get-Acl");
    expect(script).not.toContain("Set-Acl");
    expect(script).not.toContain("RawSecurityDescriptor");
    expect(script.match(/ReparsePoint/g)).toHaveLength(2);

    securePrivatePath("C:\\private", "directory", {
      platform: "win32",
      execute: (_command, args) => {
        script = args.at(-1)!;
        return result(0);
      },
      inspect: () => directoryIdentity(),
    });
    expect(script).toContain("$pathInfo=[System.IO.DirectoryInfo]::new($p)");
  });

  it.skipIf(process.platform !== "win32")("applies and verifies native Windows file and directory ACLs", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-bridge-private-native-"));
    try {
      securePrivatePath(directory, "directory");
      verifyPrivatePathAccess(directory, "directory");
      const file = join(directory, "credential.config");
      writeFileSync(file, "private", { mode: 0o600 });
      securePrivatePath(file, "file");
      verifyPrivatePathAccess(file, "file");
      const database = join(directory, "bridge.sqlite");
      const wal = `${database}-wal`;
      writeFileSync(wal, "pending", { mode: 0o600 });
      expect(() => verifyPrivatePathAccess(wal, "file")).toThrow();
      preparePrivateSqliteLocation(database);
      verifyPrivatePathAccess(wal, "file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when Windows reports a foreign owner or invalid private ACL", () => {
    expect(() => verifyPrivatePathAccess("C:\\private\\enrollment.json", "file", {
      platform: "win32",
      execute: () => result(24),
      inspect: () => fileIdentity(),
    })).toThrow(/existing owner is not trusted/);
    expect(() => securePrivatePath("C:\\private", "directory", {
      platform: "win32",
      execute: () => result(23),
      inspect: () => directoryIdentity(),
    })).toThrow(/final ACL verification failed/);
  });

  it("rejects a persistent backend reparse path before DACL changes", () => {
    let executed = false;
    expect(() => securePrivatePath("C:\\private\\credential.config", "file", {
      platform: "win32",
      execute: () => {
        executed = true;
        return result(0);
      },
      inspect: () => fileIdentity(true),
    })).toThrow(/symlinks, junctions, or reparse objects/);
    expect(executed).toBe(false);
  });

  it("rejects native reparse attributes and post-policy identity swaps", () => {
    expect(() => verifyPrivatePathAccess("C:\\private\\credential.config", "file", {
      platform: "win32",
      execute: () => result(25),
      inspect: () => fileIdentity(),
    })).toThrow(/path is a reparse object/);

    let reads = 0;
    expect(() => securePrivatePath("C:\\private\\credential.config", "file", {
      platform: "win32",
      execute: () => result(0),
      inspect: () => fileIdentity(false, reads++ === 0 ? 10 : 11),
    })).toThrow(/identity changed/);
  });
});
