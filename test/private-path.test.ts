import { describe, expect, it } from "vitest";
import { securePrivatePath, verifyPrivatePathAccess } from "../src/private-path.js";

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
    expect(script).toContain("$before.GetOwner([System.Security.Principal.SecurityIdentifier])");
    expect(script).toContain("$beforeOwner -ne $sid.Value -and ($null -eq $tokenOwner -or $beforeOwner -ne $tokenOwner.Value)");
    expect(script.indexOf("$beforeOwner -ne $sid.Value")).toBeLessThan(script.indexOf("Set-Acl"));
    expect(script).toContain("$acl=$before");
    expect(script).toContain("$acl.RemoveAccessRuleSpecific($existing)");
    expect(script).toContain("$acl.SetOwner($sid)");
    expect(script).toContain("$check.GetOwner([System.Security.Principal.SecurityIdentifier])");
    expect(script).toContain("AreAccessRulesProtected");
    expect(script).toContain("FullControl");
    expect(script.match(/ReparsePoint/g)).toHaveLength(2);
  });

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
