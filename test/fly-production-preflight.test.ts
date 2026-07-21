import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPreflightReport } from "../scripts/fly-production-preflight.mjs";

const roots: string[] = [];
const configPath = resolve("deploy/fly.toml");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function result(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

describe("Fly production preflight", () => {
  it("accepts the maintained static contract", () => {
    const report = createPreflightReport({ config: configPath }, () => result(0));

    expect(report.ok).toBe(true);
    expect(report.checks.every((entry: { ok: boolean }) => entry.ok)).toBe(true);
  });

  it("rejects a configured Dockerfile that does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-fly-test-"));
    roots.push(root);
    const config = join(root, "fly.toml");
    writeFileSync(config, readFileSync(configPath, "utf8").replace(
      'dockerfile = "../Dockerfile"',
      'dockerfile = "missing.Dockerfile"',
    ));

    const report = createPreflightReport({ config }, () => result(0));

    expect(report.ok).toBe(false);
    expect(report.checks.find((entry: { name: string }) => entry.name === "dockerfile.exists")?.ok).toBe(false);
  });

  it("rejects privileged authority in the long-running config", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-fly-test-"));
    roots.push(root);
    const config = join(root, "fly.toml");
    writeFileSync(config, readFileSync(configPath, "utf8").replace(
      "[env]",
      "[env]\n  AGENT_BRIDGE_DATABASE_URL = \"forbidden\"",
    ));

    const report = createPreflightReport({ config }, () => result(0));

    expect(report.ok).toBe(false);
    expect(report.checks.find((entry: { name: string }) => entry.name === "config.forbidden_environment")?.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("forbidden\"");
  });

  it("rejects a structurally matching config that Fly's parser rejects", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-fly-test-"));
    roots.push(root);
    const config = join(root, "fly.toml");
    const parserSecret = "parser-secret-must-stay-hidden";
    writeFileSync(config, `${readFileSync(configPath, "utf8")}\nfly_invalid_for_test = true\n`);

    const report = createPreflightReport({ config }, () => result(1, "", parserSecret));

    expect(report.checks.find((entry: { name: string }) => entry.name === "config.readiness")?.ok).toBe(true);
    expect(report.checks.find((entry: { name: string }) => entry.name === "fly.local_config")?.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(parserSecret);
  });

  it("uses read-only Fly observations and emits names without values", () => {
    const calls: string[] = [];
    const execute = (args: string[]) => {
      calls.push(args.join(" "));
      const command = args.slice(0, 2).join(" ");
      if (command === "config show" && args.includes("--local")) return result(0);
      if (command === "auth whoami") return result(0, '{"email":"operator@example.test"}');
      if (command === "status --app") return result(0, '{"Name":"contract-app"}');
      if (command === "config show") return result(0, [
        "[env]",
        '  AGENT_BRIDGE_HOST = "0.0.0.0"',
        "[http_service]",
        "  internal_port = 8787",
        "[[http_service.checks]]",
        '  path = "/readyz"',
      ].join("\n"));
      if (command === "machine list") return result(0, '[{"state":"started"}]');
      if (command === "secrets list") return result(0, '[{"Name":"AGENT_BRIDGE_RUNTIME_DATABASE_URL","Value":"do-not-print-me"}]');
      return result(2);
    };

    const report = createPreflightReport({ config: configPath, app: "contract-app" }, execute);

    expect(report.ok).toBe(true);
    expect(report.observations?.secretNames).toEqual(["AGENT_BRIDGE_RUNTIME_DATABASE_URL"]);
    expect(JSON.stringify(report)).not.toContain("do-not-print-me");
    expect(calls).toContain("config show --local --app agent-bridge-contract-check --config " + configPath);
    expect(calls).toContain("auth whoami --json");
    expect(calls).toContain("status --app contract-app --json");
    expect(calls).toContain("config show --app contract-app --toml");
    expect(calls).toContain("machine list --app contract-app --json");
    expect(calls).toContain("secrets list --app contract-app --json");
    expect(calls.join("\n")).not.toMatch(/^(?:deploy|scale|set|unset|restart|update)\b/mu);
  });

  it("reports an undeployed app through named remote checks", () => {
    const execute = (args: string[]) => {
      const command = args.slice(0, 2).join(" ");
      if (command === "config show" && args.includes("--local")) return result(0);
      if (command === "auth whoami") return result(0, '{"email":"operator@example.test"}');
      if (command === "status --app") return result(0, '{"Name":"contract-app","Status":"suspended"}');
      if (command === "config show") return result(1, "", "No machines configured for this app");
      if (command === "machine list") return result(0, "[]");
      if (command === "secrets list") return result(0, "[]");
      return result(2);
    };

    const report = createPreflightReport({ config: configPath, app: "contract-app" }, execute);

    expect(report.ok).toBe(false);
    expect(report.checks.find((entry: { name: string }) => entry.name === "fly.app")?.ok).toBe(true);
    expect(report.checks.find((entry: { name: string }) => entry.name === "fly.remote_config")?.ok).toBe(false);
    expect(report.checks.find((entry: { name: string }) => entry.name === "fly.runtime_secret")?.ok).toBe(false);
    expect(report.checks.find((entry: { name: string }) => entry.name === "fly.running_machine")?.ok).toBe(false);
    expect(report.checks.some((entry: { name: string }) => entry.name === "fly.observation")).toBe(false);
    expect(report.observations?.machineCount).toBe(0);
    expect(JSON.stringify(report)).not.toContain("No machines configured");
  });
});
