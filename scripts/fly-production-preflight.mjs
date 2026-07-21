import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = resolve(REPOSITORY_ROOT, "deploy/fly.toml");
const LOCAL_PARSE_APP = "agent-bridge-contract-check";
const REQUIRED_RUNTIME_NAMES = ["AGENT_BRIDGE_RUNTIME_DATABASE_URL"];
const FORBIDDEN_NAMES = [
  "AGENT_BRIDGE_DATABASE_URL",
  "AGENT_BRIDGE_OPERATOR_DATABASE_URL",
  "AGENT_BRIDGE_RUNTIME_PASSWORD",
  "AGENT_BRIDGE_TOKEN",
  "AGENT_BRIDGE_GATEWAY_TOKEN",
  "AGENT_BRIDGE_BEARER_TOKEN",
  "SUPABASE_KEY",
];

function usage() {
  return `Usage: node scripts/fly-production-preflight.mjs [--config <path>] [--app <name>] [--json]

Checks the maintained Fly.io production contract without changing local or remote state.
Supplying --app also checks the current Fly account, app config, machines, and secret names.`;
}

function parseArguments(argv) {
  const options = { config: DEFAULT_CONFIG, json: false, app: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--app" || argument === "--config") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = argument === "--config" ? resolve(value) : value;
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

function environmentNames(text) {
  const lines = text.split(/\r?\n/u);
  const names = [];
  let inEnvironment = false;
  for (const line of lines) {
    if (/^\s*\[env\]\s*$/u.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (/^\s*\[/u.test(line)) inEnvironment = false;
    const match = inEnvironment ? line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/u) : undefined;
    if (match) names.push(match[1]);
  }
  return names;
}

function has(text, pattern) {
  return pattern.test(text);
}

function configuredDockerfile(configPath, text) {
  const match = text.match(/^\s*dockerfile\s*=\s*"([^"]+)"\s*$/mu);
  return match ? resolve(dirname(configPath), match[1]) : undefined;
}

function staticChecks(configPath) {
  if (!existsSync(configPath)) return [check("config.exists", false, "Fly config is missing")];
  const text = readFileSync(configPath, "utf8");
  const dockerfile = configuredDockerfile(configPath, text);
  const names = environmentNames(text);
  const checks = [
    check("node.version", Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.versions.node}`),
    check("dockerfile.exists", dockerfile !== undefined && existsSync(dockerfile), "configured Dockerfile exists"),
    check("config.no_app_name", !has(text, /^\s*app\s*=/mu), "app name is operator supplied"),
    check("config.no_release_command", !has(text, /\[deploy\]|release_command/mu), "migrations stay in an operator job"),
    check("config.https_service", has(text, /\[http_service\][\s\S]*?internal_port\s*=\s*8787[\s\S]*?force_https\s*=\s*true/mu), "HTTPS to internal port 8787"),
    check("config.readiness", has(text, /\[\[http_service\.checks\]\][\s\S]*?name\s*=\s*"ready"[\s\S]*?method\s*=\s*"GET"[\s\S]*?path\s*=\s*"\/readyz"/mu), "named GET /readyz check"),
    check("config.always_running", has(text, /auto_stop_machines\s*=\s*"off"/mu) && has(text, /min_machines_running\s*=\s*1/mu), "one always-running machine"),
    check("config.shutdown", has(text, /^kill_signal\s*=\s*"SIGTERM"/mu) && has(text, /^kill_timeout\s*=\s*"30s"/mu), "SIGTERM with 30-second budget"),
    check("config.vm", has(text, /\[\[vm\]\][\s\S]*?size\s*=\s*"shared-cpu-1x"[\s\S]*?memory\s*=\s*"512mb"/mu), "shared-cpu-1x with 512 MB"),
    check("config.static_environment", ["AGENT_BRIDGE_HOST", "AGENT_BRIDGE_PORT", "NODE_ENV"].every((name) => names.includes(name)), "required nonsecret names are present"),
    check("config.forbidden_environment", FORBIDDEN_NAMES.every((name) => !names.includes(name)) && !names.some((name) => /(?:BEARER|TOKEN|PASSWORD)/u.test(name)), "privileged and client credential names are absent"),
  ];
  return checks;
}

function executeFlyctl(args) {
  return spawnSync("flyctl", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function localFlyParse(configPath, execute) {
  const result = execute(["config", "show", "--local", "--app", LOCAL_PARSE_APP, "--config", configPath]);
  if (result.error?.code === "ENOENT") return check("fly.local_config", false, "flyctl is required for local config validation");
  return check(
    "fly.local_config",
    result.status === 0,
    result.status === 0 ? "Fly parser accepted the local config" : "Fly parser rejected the local config",
  );
}

function flyJson(args, execute) {
  const result = execute(args);
  if (result.error?.code === "ENOENT") throw new Error("flyctl is required when --app is supplied");
  if (result.status !== 0) throw new Error(`flyctl ${args[0]} failed with exit code ${result.status ?? "unknown"}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`flyctl ${args[0]} did not return JSON`);
  }
}

function optionalFlyText(args, execute) {
  const result = execute(args);
  if (result.error?.code === "ENOENT") throw new Error("flyctl is required when --app is supplied");
  return result.status === 0 ? result.stdout : undefined;
}

function secretNames(value) {
  const rows = Array.isArray(value) ? value : value?.secrets ?? [];
  return rows.map((row) => row.Name ?? row.name).filter((name) => typeof name === "string");
}

function machineRows(value) {
  return Array.isArray(value) ? value : value?.machines ?? [];
}

function remoteChecks(app, execute) {
  const account = flyJson(["auth", "whoami", "--json"], execute);
  const status = flyJson(["status", "--app", app, "--json"], execute);
  const config = optionalFlyText(["config", "show", "--app", app, "--toml"], execute);
  const machines = machineRows(flyJson(["machine", "list", "--app", app, "--json"], execute));
  const secretNameList = secretNames(flyJson(["secrets", "list", "--app", app, "--json"], execute));
  const configuredNameList = config === undefined ? [] : environmentNames(config);
  const names = [...new Set([...configuredNameList, ...secretNameList])];
  const observedName = status.Name ?? status.name ?? status.App?.Name ?? status.app?.name;
  return {
    checks: [
      check("fly.account", Boolean(account.email ?? account.Email ?? account.name ?? account.Name), "authenticated Fly account observed"),
      check("fly.app", observedName === app, "requested app observed"),
      check("fly.remote_config", config !== undefined && /8787/u.test(config) && /readyz/u.test(config), "remote config exposes the maintained service and readiness path"),
      check("fly.runtime_secret", REQUIRED_RUNTIME_NAMES.every((name) => secretNameList.includes(name)), "restricted runtime database authority is configured as a secret"),
      check("fly.forbidden_secrets", FORBIDDEN_NAMES.every((name) => !names.includes(name)) && !names.some((name) => /(?:BEARER|TOKEN)/u.test(name)), "privileged and client credential names are absent"),
      check("fly.running_machine", machines.some((machine) => ["started", "running"].includes(String(machine.state ?? machine.State).toLowerCase())), "at least one machine is running"),
    ],
    observations: { app, environmentNames: names.sort(), secretNames: secretNameList.sort(), machineCount: machines.length },
  };
}

export function createPreflightReport(options, execute = executeFlyctl) {
  const checks = staticChecks(options.config);
  if (existsSync(options.config)) checks.push(localFlyParse(options.config, execute));
  let observations;
  try {
    if (options.app) {
      const remote = remoteChecks(options.app, execute);
      checks.push(...remote.checks);
      observations = remote.observations;
    }
  } catch (error) {
    checks.push(check("fly.observation", false, error.message));
  }
  const ok = checks.every((entry) => entry.ok);
  return { schema: "agent-bridge-fly-preflight-v1", ok, config: options.config, checks, ...(observations ? { observations } : {}) };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = createPreflightReport(options);
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    for (const entry of report.checks) process.stdout.write(`${entry.ok ? "OK" : "ERROR"} ${entry.name}: ${entry.detail}\n`);
    process.stdout.write(`${report.ok ? "Fly production preflight passed" : "Fly production preflight failed"}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
