#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const SUPPORTED_MAJORS = ["15", "16", "17", "18"];
const PREFLIGHT_LABEL = "agent-bridge.preflight=postgres";
const STALE_CONTAINER_AGE_MS = 2 * 60 * 60 * 1_000;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let activeContainer;

function usage() {
  return `Usage: node scripts/postgres-preflight.mjs [options]

Options:
  --major <15|16|17|18>  Test one major. Repeat to test more than one.
  --full                  Run the full test suite instead of the PostgreSQL contract.
  --help                  Show this help.

Without --major, the preflight tests PostgreSQL 15 through 18 in order. Each run uses
a new container and an automatically assigned loopback port.`;
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr ?? "");
      process.stderr.write(result.stdout ?? "");
    }
    throw new Error(`${commandName} ${args.join(" ")} exited with status ${result.status}`);
  }
  return options.capture ? (result.stdout ?? "").trim() : "";
}

function cleanup() {
  if (!activeContainer) return;
  spawnSync("docker", ["rm", "--force", activeContainer], { stdio: "ignore" });
  activeContainer = undefined;
}

function pruneStaleContainers() {
  const containerIds = command(
    "docker",
    ["ps", "--all", "--quiet", "--filter", `label=${PREFLIGHT_LABEL}`],
    { capture: true },
  ).split(/\s+/u).filter(Boolean);
  for (const containerId of containerIds) {
    const inspected = spawnSync(
      "docker",
      ["inspect", "--format", "{{.Created}}", containerId],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (inspected.status !== 0) continue;
    const createdAt = Date.parse(inspected.stdout.trim());
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < STALE_CONTAINER_AGE_MS) continue;
    process.stdout.write(`Removing stale PostgreSQL preflight container ${containerId.slice(0, 12)}\n`);
    const removed = spawnSync("docker", ["rm", "--force", containerId], { stdio: "ignore" });
    if (removed.status !== 0) {
      const stillExists = spawnSync("docker", ["inspect", containerId], { stdio: "ignore" });
      if (stillExists.status === 0) {
        throw new Error(`could not remove stale PostgreSQL preflight container ${containerId}`);
      }
    }
  }
}

function parseArguments(args) {
  const majors = [];
  let full = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help") return { help: true, full, majors };
    if (value === "--full") {
      full = true;
      continue;
    }
    if (value === "--major") {
      const major = args[index + 1];
      if (!major || !SUPPORTED_MAJORS.includes(major)) {
        throw new Error("--major must be one of 15, 16, 17, or 18");
      }
      majors.push(major);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${value}`);
  }
  return { help: false, full, majors: majors.length > 0 ? [...new Set(majors)] : SUPPORTED_MAJORS };
}

async function waitForPostgres(containerName) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = spawnSync(
      "docker",
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", containerName],
      { encoding: "utf8" },
    );
    if (state.status === 0 && state.stdout.trim() === "healthy") return;
    await delay(1_000);
  }
  command("docker", ["logs", containerName]);
  throw new Error(`PostgreSQL container ${containerName} did not become healthy`);
}

async function runMajor(major, full) {
  const containerName = `agent-bridge-pg-preflight-${major}-${randomUUID().slice(0, 8)}`;
  activeContainer = containerName;
  try {
    command("docker", [
      "run", "--detach", "--rm", "--name", containerName,
      "--label", PREFLIGHT_LABEL,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env", "POSTGRES_DB=agent_bridge_test",
      "--publish", "127.0.0.1::5432",
      "--health-cmd", "pg_isready -U postgres -d agent_bridge_test",
      "--health-interval", "1s", "--health-timeout", "2s", "--health-retries", "30",
      `postgres:${major}`,
    ], { capture: true });
    await waitForPostgres(containerName);
    const port = command("docker", [
      "inspect", "--format",
      "{{(index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}",
      containerName,
    ], { capture: true });
    if (!/^[1-9][0-9]*$/u.test(port)) throw new Error(`Docker returned an invalid PostgreSQL port: ${port}`);
    const env = {
      ...process.env,
      AGENT_BRIDGE_TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/agent_bridge_test`,
    };
    process.stdout.write(`\nPostgreSQL ${major}: ${full ? "full suite" : "integration contract"}\n`);
    if (full) {
      command(npm, ["run", "test:built"], { env });
    } else {
      command(npm, ["run", "test:postgres:contract"], { env });
    }
  } finally {
    cleanup();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  command("docker", ["info"], { capture: true });
  pruneStaleContainers();
  command(npm, ["run", "build"]);
  for (const major of options.majors) await runMajor(major, options.full);
}

process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

main().catch((error) => {
  cleanup();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
