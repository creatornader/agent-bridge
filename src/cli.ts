import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import type { MessageDraft } from "./bridge-domain.js";
import { resolveClientConfig, type ClientConfig } from "./client-config.js";
import { createClientRuntime } from "./client-runtime.js";
import { loadMigrationPlan, runMigrations } from "./migrations.js";
import { reconcileLegacyProjects } from "./legacy-project-reconciliation.js";
import { legacyContextMetadata, legacyNumericMessageId } from "./legacy-compat.js";
import { BridgeHttpError } from "./http-bridge-store.js";
import { LegacySupabaseError } from "./legacy-supabase-store.js";
import { installClient, type InstallableRuntime } from "./client-installer.js";
import { capabilityDocument, operationForCli, parseCliResponse, validateRequest } from "./contracts/registry.js";
import { runOwnerCommand, type OwnerOptions } from "./owner-control.js";
import { ArchiveCommandError, runArchiveCommand } from "./archive-cli.js";
import { runDrCommand } from "./dr-cli.js";
import { NativeDrCommandError } from "./sqlite-native-dr.js";
import { securePrivatePath, verifyPrivatePathAccess } from "./private-path.js";

type Options = Record<string, string | boolean | string[]>;
const SUPPORTED_OPTIONS = new Set([
  "agent", "as", "atrib-receipt-id", "category", "causation-id", "config",
  "content", "content-type", "correlation-id", "cursor", "data", "db", "dead",
  "delivery-id", "delivery-max-attempts", "delivery-mode", "delivery-policy",
  "disposition", "error", "expires-at", "force", "idempotency-key", "ids",
  "informed-by", "instance", "interval-ms", "json", "key", "kind", "lease-ms",
  "lease-token", "limit", "max-attempts", "max-interval-ms", "message-id",
  "metadata", "not-before", "payload", "payload-ciphertext", "payload-mime", "payload-ref",
  "polls", "priority", "project", "provider", "reply-to-id", "since", "source",
  "target", "target-agent", "target-agents", "thread-id", "token", "type",
  "unacked-by", "url", "workspace", "mailbox", "receipt-state",
  "identity", "command", "scope",
  "recipient", "retry-base-ms", "retry-jitter", "retry-max-ms", "role", "runtime", "capability", "state",
  "max-pages", "max-push",
  "latest",
  "apply",
  "display-name", "enrollment-file",
  "credential-id", "gateway-url", "grace-until", "invalidate-immediately", "label",
  "reason", "request-id", "resume", "runtime-type", "recover-lock",
  "scope-set", "workspace-name",
]);
const BOOLEAN_OPTIONS = new Set(["apply", "dead", "force", "invalidate-immediately", "json", "latest", "recover-lock"]);
function parse(argv: string[]): { command: string; options: Options; positionals: string[] } {
  const command = argv[0] ?? "help"; const options: Options = {}; const positionals: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2); const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      if (!BOOLEAN_OPTIONS.has(key)) throw new Error(`--${key} requires a value`);
      options[key] = true;
    }
    else { i++; const previous = options[key]; options[key] = previous === undefined ? next : Array.isArray(previous) ? [...previous, next] : [String(previous), next]; }
  }
  return { command, options, positionals };
}
function one(options: Options, key: string): string | undefined { const value = options[key]; return Array.isArray(value) ? value[value.length - 1] : typeof value === "string" ? value : undefined; }
function list(options: Options, key: string): string[] { const value = options[key]; return (Array.isArray(value) ? value : value ? [String(value)] : []).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean); }
function boolean(options: Options, key: string): boolean {
  const value = options[key];
  const selected = Array.isArray(value) ? value[value.length - 1] : value;
  if (selected === undefined) return false;
  if (selected === true || selected === "true") return true;
  if (selected === false || selected === "false") return false;
  throw new Error(`--${key} must be true or false`);
}
function integer(options: Options, key: string, fallback: number): number { const raw = one(options, key); const result = raw === undefined ? fallback : Number(raw); if (!Number.isSafeInteger(result) || result < 0) throw new Error(`--${key} must be a non-negative integer`); return result; }
function json(options: Options, key: string): unknown {
  const raw = one(options, key);
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { throw new Error(`--${key} must be valid JSON`); }
}
function since(options: Options): string | undefined {
  const raw = one(options, "since");
  if (!raw) return undefined;
  const relative = raw.match(/^(\d+)(h|d)$/);
  if (!relative) return raw;
  const amount = Number(relative[1]);
  const milliseconds = amount * (relative[2] === "h" ? 3_600_000 : 86_400_000);
  return new Date(Date.now() - milliseconds).toISOString();
}
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function cliOutput(
  operationId: string,
  value: unknown,
  invocation?: { command: string; optionNames?: readonly string[] },
): void { output(parseCliResponse(operationId, value, invocation)); }
function failedClientStatus(
  config: ClientConfig,
  error: unknown,
  failure: { component: "local-store" | "remote"; remoteAttempted?: boolean },
): void {
  const schemaVersion = config.provider === "legacy-supabase"
    ? "legacy-v1"
    : config.provider === "gateway" ? "postgres-v2" : "local-v2";
  const remote = config.provider === "local" || !failure.remoteAttempted ? null : false;
  const localHealthy = failure.component !== "local-store";
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "diagnostics_failed";
  cliOutput("client_status", {
    status: "failed",
    localHealthy,
    connected: false,
    remoteReachable: remote,
    provider: config.provider,
    workspace: config.principal.workspace,
    agent: config.principal.agent,
    instance: config.principal.instance ?? null,
    schemaVersion,
    endpoint: config.url ?? null,
    database: config.provider === "local" ? config.databasePath : null,
    cursorPath: config.cursorPath,
    lastCursor: cursor(config.cursorPath) ?? null,
    queue: { schemaVersion, deliverySupported: false, pending: null, claimed: null, retrying: null, dead: null },
    checks: [{ name: failure.component, status: "failed", message: `${failure.component} diagnostics failed (${code})` }],
  });
}
function cursor(path: string): string | undefined { try { return readFileSync(path, "utf8").trim() || undefined; } catch { return undefined; } }
function preparePrivateOutput(path: string): void {
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed || basename(directory) === ".agent-bridge") securePrivatePath(directory, "directory");
  else verifyPrivatePathAccess(directory, "directory");
  if (existsSync(path)) verifyPrivatePathAccess(path, "file");
}

function saveCursor(path: string, value: string | undefined): void {
  if (!value) return;
  preparePrivateOutput(path);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    securePrivatePath(temporary, "file");
    renameSync(temporary, path);
    verifyPrivatePathAccess(path, "file");
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
function watchCursorPath(path: string, project: string | undefined): string {
  if (!project) return path;
  const scope = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return `${path}.project-${scope}`;
}
function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version) throw new Error("package version is unavailable");
  return manifest.version;
}
function help(): void { process.stdout.write(`agent-bridge: provider-neutral agent messaging\n\nCommands:\n  init, doctor, status, capabilities, pending, migrate, reconcile-legacy-projects, sync, demo, join, presence\n  send (post), inbox (get), sent, history, acknowledge, claim, extend, ack, nack, watch\n  deliveries, dead-letters, delivery-events, cancel, requeue\n  owner <provision|inventory|rotate|revoke>\n  archive <export|verify|import>\n  dr <backup|verify|restore>\n  clients install <codex|claude-code|claude-desktop> --identity <name>\n\nOptions:\n  -V, --version  Print the installed package version\n  -h, --help     Show this help\n`); }
function rejectUnknownOptions(options: Options): void {
  const unknown = Object.keys(options).filter((key) => !SUPPORTED_OPTIONS.has(key));
  if (unknown.length) throw new Error(`unknown option: --${unknown[0]}`);
}
function rejectOptionsOutside(options: Options, allowed: ReadonlySet<string>, command: string): void {
  const invalid = Object.keys(options).find((key) => !allowed.has(key));
  if (invalid) throw new Error(`--${invalid} is not valid for ${command}`);
}

const CLI_CONTEXT_OPTIONS = new Set([
  "agent", "as", "config", "db", "instance", "json", "key", "provider",
  "token", "url", "workspace",
]);

function validateCanonicalCommandOptions(command: string, options: Options, config: ClientConfig): void {
  const contract = operationForCli(command, config.provider, Object.keys(options));
  if (!contract?.cli) return;
  const allowed = new Set([...CLI_CONTEXT_OPTIONS, ...contract.cli.options]);
  const invalid = Object.keys(options).find((key) => !allowed.has(key));
  if (invalid) throw new Error(`--${invalid} is not valid for ${command}`);
}

async function initialize(options: Options): Promise<void> {
  const home = process.env.HOME ?? homedir();
  const configPath = one(options, "config") ?? process.env.AGENT_BRIDGE_CONFIG ?? join(home, ".agent-bridge", "config");
  if (existsSync(configPath) && !boolean(options, "force")) {
    throw new Error(`Config already exists at ${configPath}; pass --force to replace it`);
  }
  const provider = one(options, "provider") ?? process.env.AGENT_BRIDGE_PROVIDER ?? "local";
  if (one(options, "instance")) {
    throw new Error("--instance is client-scoped; set it in the active client process");
  }
  const values: Record<string, string | undefined> = {
    AGENT_BRIDGE_PROVIDER: provider,
    AGENT_BRIDGE_WORKSPACE: one(options, "workspace") ?? process.env.AGENT_BRIDGE_WORKSPACE ?? (provider === "legacy-supabase" || provider === "legacy" || provider === "supabase" ? "*" : "default"),
    AGENT_BRIDGE_DB: one(options, "db") ?? process.env.AGENT_BRIDGE_DB,
    AGENT_BRIDGE_EDGE_DB: process.env.AGENT_BRIDGE_EDGE_DB,
    AGENT_BRIDGE_URL: one(options, "url") ?? process.env.AGENT_BRIDGE_URL,
    AGENT_BRIDGE_KEY: one(options, "key") ?? process.env.AGENT_BRIDGE_KEY,
  };
  const verificationToken = one(options, "token") ?? process.env.AGENT_BRIDGE_TOKEN;
  for (const value of Object.values(values)) {
    if (value?.includes("\n") || value?.includes("\r")) throw new Error("config values cannot contain newlines");
  }
  preparePrivateOutput(configPath);
  const temporary = `${configPath}.${process.pid}.tmp`;
  let config: ClientConfig;
  try {
    writeFileSync(
      temporary,
      Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
      { mode: 0o600 },
    );
    securePrivatePath(temporary, "file");
    config = resolveClientConfig(
      {
        HOME: home,
        AGENT_BRIDGE_CONFIG: temporary,
        AGENT_BRIDGE_TOKEN: verificationToken,
      },
      "agent-bridge-init",
    );
    const runtime = await createClientRuntime(config);
    try {
      if (config.provider === "gateway") await runtime.store.verifyRemote?.();
    } finally {
      await runtime.close();
    }
    renameSync(temporary, configPath);
    verifyPrivatePathAccess(configPath, "file");
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  output({ status: "ok", config: configPath, provider: config.provider, workspace: config.principal.workspace, identity: "process-scoped", database: config.provider === "local" ? config.databasePath : null });
}

function configFor(options: Options, command: string): ClientConfig {
  const explicit = command === "send"
    ? one(options, "source") ?? one(options, "agent")
    : command === "acknowledge" || (command === "ack" && Boolean(one(options, "ids")))
      ? one(options, "agent")
      : one(options, "as");
  const environment = {
    ...process.env,
    ...(one(options, "config") ? { AGENT_BRIDGE_CONFIG: one(options, "config") } : {}),
    ...(one(options, "provider") ? { AGENT_BRIDGE_PROVIDER: one(options, "provider") } : {}),
    ...(one(options, "db") ? { AGENT_BRIDGE_DB: one(options, "db") } : {}),
    ...(one(options, "url") ? { AGENT_BRIDGE_URL: one(options, "url") } : {}),
    ...(one(options, "key") ? { AGENT_BRIDGE_KEY: one(options, "key") } : {}),
    ...(one(options, "token") ? { AGENT_BRIDGE_TOKEN: one(options, "token") } : {}),
    ...(one(options, "instance") ? { AGENT_BRIDGE_INSTANCE: one(options, "instance") } : {}),
  };
  const config = resolveClientConfig(environment, explicit);
  const assertedWorkspace = one(options, "workspace");
  if (config.provider === "gateway" && assertedWorkspace && assertedWorkspace !== config.principal.workspace) {
    throw new Error("--workspace must match the workspace bound to the gateway credential");
  }
  if (config.provider === "legacy-supabase" && assertedWorkspace && assertedWorkspace !== "*") {
    throw new Error("--workspace is not supported by the global legacy Supabase schema");
  }
  if (config.provider === "local" && assertedWorkspace && assertedWorkspace !== config.principal.workspace) {
    return resolveClientConfig(
      { ...environment, AGENT_BRIDGE_WORKSPACE: assertedWorkspace },
      explicit,
    );
  }
  return config;
}
function draft(options: Options, positionals: string[]): MessageDraft {
  const content = one(options, "content") ?? positionals.join(" ");
  const metadataInput = json(options, "metadata");
  if (metadataInput !== undefined && (
    metadataInput === null || typeof metadataInput !== "object" || Array.isArray(metadataInput)
  )) throw new Error("--metadata must be a JSON object");
  const metadata = (metadataInput ?? {}) as Record<string, unknown>;
  const envelope = typeof metadata.message_envelope === "object" && metadata.message_envelope
    ? { ...metadata.message_envelope as Record<string, unknown> }
    : {};
  if (one(options, "payload-ref")) envelope.payload_ref = one(options, "payload-ref");
  if (one(options, "payload-ciphertext")) envelope.payload_ciphertext = one(options, "payload-ciphertext");
  if (Object.keys(envelope).length) metadata.message_envelope = envelope;
  const deliveryMode = one(options, "delivery-mode");
  const deliveryTuning = ["delivery-max-attempts", "retry-base-ms", "retry-max-ms", "retry-jitter", "not-before"]
    .some((key) => one(options, key) !== undefined);
  if (deliveryTuning && !deliveryMode) throw new Error("--delivery-mode is required with delivery policy flags");
  if (deliveryMode === "mailbox" && deliveryTuning) throw new Error("mailbox delivery mode does not accept retry or scheduling flags");
  return {
    project: one(options, "project"),
    type: one(options, "type") ?? one(options, "kind") ?? one(options, "category") ?? "operational", content,
    targets: [...list(options, "target"), ...list(options, "target-agent"), ...list(options, "target-agents")],
    priority: one(options, "priority") as MessageDraft["priority"], threadId: one(options, "thread-id"), replyToId: one(options, "reply-to-id"),
    correlationId: one(options, "correlation-id"), causationId: one(options, "causation-id"),
    id: one(options, "message-id"), idempotencyKey: one(options, "idempotency-key"), expiresAt: one(options, "expires-at"),
    contentType: one(options, "content-type") ?? one(options, "payload-mime"), atribReceiptId: one(options, "atrib-receipt-id"), informedBy: list(options, "informed-by"),
    data: (json(options, "data") ?? json(options, "payload")) as MessageDraft["data"],
    metadata: metadata as MessageDraft["metadata"],
    deliveryPolicy: (json(options,"delivery-policy") ?? (deliveryMode ? deliveryMode === "mailbox" ? { mode: "mailbox" } : { mode: deliveryMode, maxAttempts: integer(options,"delivery-max-attempts",5), retryBaseDelayMs: integer(options,"retry-base-ms",1000), retryMaxDelayMs: integer(options,"retry-max-ms",60000), retryJitterRatio: Number(one(options,"retry-jitter") ?? .2), notBefore: one(options,"not-before") } : undefined)) as MessageDraft["deliveryPolicy"],
  };
}

async function localDemo(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-demo-")); const databasePath = join(directory, "demo.sqlite3");
  securePrivatePath(directory, "directory");
  const base = { provider: "local" as const, databasePath, edgeDatabasePath: join(directory, "edge.sqlite3"), cursorPath: join(directory, "cursor"), configPath: join(directory, "config"), credential: undefined, url: undefined };
  let sender: Awaited<ReturnType<typeof createClientRuntime>> | undefined;
  let worker: Awaited<ReturnType<typeof createClientRuntime>> | undefined;
  try {
    sender = await createClientRuntime({ ...base, principal: { workspace: "demo", agent: "demo-sender", instance: "sender-1" } });
    const sent = await sender.service.publish(sender.config.principal, { type: "request", content: "deterministic local task", targets: ["demo-worker"], idempotencyKey: "demo-task-v1" });
    await sender.close();
    sender = undefined;
    worker = await createClientRuntime({ ...base, principal: { workspace: "demo", agent: "demo-worker", instance: "worker-1" } });
    const history = await worker.service.history(worker.config.principal);
    const claim = await worker.service.claim(worker.config.principal, { leaseMs: 5_000 });
    if (!claim) throw new Error("demo claim failed");
    const acked = await worker.service.ack(worker.config.principal, claim.delivery.id, claim.leaseToken);
    output({ status: "ok", principals: ["demo-sender", "demo-worker"], sent: sent.created, read: history.messages.length === 1, claimed: claim.delivery.state === "claimed", acknowledged: acked?.state === "acked" });
  } finally {
    await worker?.close();
    await sender?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "archive") {
    output(await runArchiveCommand(argv.slice(1), process.env));
    return;
  }
  if (argv[0] === "dr") {
    output(await runDrCommand(argv.slice(1)));
    return;
  }
  const { command: raw, options, positionals } = parse(argv); const command = ({ post: "send", get: "inbox", receipt: "acknowledge" } as Record<string, string>)[raw] ?? raw;
  if (["-V", "--version"].includes(command)) { process.stdout.write(`${packageVersion()}\n`); return; }
  if (["help", "-h", "--help"].includes(command)) { help(); return; }
  rejectUnknownOptions(options);
  if (command === "owner") {
    if (positionals.length !== 1) {
      throw new Error("usage: agent-bridge owner <provision|inventory|rotate|revoke>");
    }
    const ownerOptions: OwnerOptions = {};
    for (const [key, value] of Object.entries(options)) {
      if (Array.isArray(value)) throw new Error("--" + key + " may only be provided once");
      ownerOptions[key] = value;
    }
    output(await runOwnerCommand(positionals[0], ownerOptions, process.env));
    return;
  }
  if (command === "clients") {
    if (positionals.length !== 2 || positionals[0] !== "install" || !positionals[1]) {
      throw new Error("usage: agent-bridge clients install <runtime> --identity <name>");
    }
    rejectOptionsOutside(options, new Set([
      "identity", "command", "scope", "instance", "token", "enrollment-file", "recover-lock",
    ]), "clients install");
    const runtime = positionals[1] as InstallableRuntime | undefined;
    if (runtime && !["codex", "claude-code", "claude-desktop"].includes(runtime)) {
      throw new Error(`unsupported install runtime: ${runtime}`);
    }
    const scope = one(options, "scope");
    if (scope && !["local", "user", "project"].includes(scope)) {
      throw new Error("--scope must be local, user, or project");
    }
    output(installClient(runtime, one(options, "identity") ?? "", {
      command: one(options, "command"),
      scope: scope as "local" | "user" | "project" | undefined,
      instance: one(options, "instance"),
      token: one(options, "token"),
      enrollmentFile: one(options, "enrollment-file"),
      recoverLock: boolean(options, "recover-lock"),
      env: process.env,
    }));
    return;
  }
  if (command === "demo") { await localDemo(); return; }
  if (command === "init") { await initialize(options); return; }
  if (command === "migrate") {
    const databaseUrl = process.env.AGENT_BRIDGE_DATABASE_URL;
    if (!databaseUrl) throw new Error("AGENT_BRIDGE_DATABASE_URL is required");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const applied = await runMigrations(
        pool,
        fileURLToPath(new URL("../sql/migrations", import.meta.url)),
      );
      output({ status: "ok", applied });
    } finally { await pool.end(); }
    return;
  }
  if (command === "reconcile-legacy-projects") {
    const databaseUrl = process.env.AGENT_BRIDGE_DATABASE_URL;
    if (!databaseUrl) throw new Error("AGENT_BRIDGE_DATABASE_URL is required");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const directory = fileURLToPath(new URL("../sql/migrations", import.meta.url));
      const migration = (await loadMigrationPlan(directory)).find((entry) => entry.version === 8);
      if (!migration || migration.name !== "message_projects") {
        throw new Error("migration 008_message_projects is missing from the migration plan");
      }
      output(await reconcileLegacyProjects(pool, {
        apply: boolean(options, "apply"),
        migrationChecksum: migration.checksum,
      }));
    }
    finally { await pool.end(); }
    return;
  }
  const config = configFor(options, command);
  validateCanonicalCommandOptions(raw, options, config);
  const assertedUnackedBy = one(options, "unacked-by");
  if (assertedUnackedBy !== undefined && assertedUnackedBy !== config.principal.agent) throw new Error("--unacked-by must equal the configured principal");
  if (command === "capabilities") {
    validateRequest("capabilities", {});
    cliOutput("capabilities", capabilityDocument({ surface: "cli", provider: config.provider }));
    return;
  }
  let runtime: Awaited<ReturnType<typeof createClientRuntime>>;
  try {
    runtime = await createClientRuntime(config, {
      autoSync: command !== "doctor" && command !== "status",
      initializationMode: command === "status" ? "passive" : "active",
    });
  } catch (error) {
    if (command !== "doctor" && command !== "status") throw error;
    const remoteInitialization = command === "doctor" && config.provider === "legacy-supabase";
    failedClientStatus(config, error, {
      component: remoteInitialization ? "remote" : "local-store",
      remoteAttempted: remoteInitialization,
    });
    process.exitCode = 1;
    return;
  }
  try {
    if (command === "doctor" || command === "status") {
      validateRequest("client_status", {});
      const active = command === "doctor";
      try {
        const diagnostics = await runtime.store.diagnostics?.(config.principal, { mode: active ? "probe" : "snapshot" }) ?? { schemaVersion: config.provider === "legacy-supabase" ? "legacy-v1" as const : "local-v2" as const, deliverySupported: false, pending: null, claimed: null, retrying: null, dead: null };
        const remoteReachable = "remoteReachable" in diagnostics
          ? diagnostics.remoteReachable ?? null
          : active && config.provider === "legacy-supabase" ? true : null;
        type CheckStatus = "ok" | "unknown" | "degraded" | "failed";
        const checks: Array<{ name: string; status: CheckStatus; message: string }> = [{
          name: "local-store",
          status: "ok",
          message: "local diagnostics are readable",
        }];
        if (config.provider !== "local") {
          const provider = config.provider === "gateway" ? "gateway" : "legacy provider";
          const remoteError = "remoteError" in diagnostics && typeof diagnostics.remoteError === "string"
            ? diagnostics.remoteError
            : undefined;
          checks.push({
            name: "remote",
            status: remoteReachable === false ? "degraded" : remoteError ? "failed" : remoteReachable === true ? "ok" : "unknown",
            message: remoteReachable === false ? `${provider} is unreachable` : remoteError ? `${provider} rejected diagnostics (${remoteError})` : remoteReachable === true ? `${provider} is reachable` : `${provider} reachability has not been checked`,
          });
        }
        const blocked = "outboxBlocked" in diagnostics ? Number(diagnostics.outboxBlocked ?? 0) : 0;
        checks.push({ name: "blocked-outbox", status: blocked > 0 ? "degraded" : "ok", message: blocked > 0 ? `${blocked} outbound message(s) require intervention` : "no blocked outbound messages" });
        const expired = Number(diagnostics.expiredLeases ?? 0);
        checks.push({ name: "expired-leases", status: expired > 0 ? "degraded" : "ok", message: expired > 0 ? `${expired} delivery lease(s) are expired` : "no expired delivery leases" });
        const dead = Number(diagnostics.dead ?? 0);
        checks.push({ name: "dead-deliveries", status: dead > 0 ? "degraded" : "ok", message: dead > 0 ? `${dead} dead delivery/deliveries are visible` : "no dead deliveries" });
        const status: CheckStatus = checks.some((check) => check.status === "failed")
          ? "failed"
          : checks.some((check) => check.status === "degraded")
            ? "degraded"
            : checks.some((check) => check.status === "unknown") ? "unknown" : "ok";
        const remoteError = "remoteError" in diagnostics && typeof diagnostics.remoteError === "string";
        const connected = config.provider === "local" ? true : remoteReachable === true && !remoteError;
        const queue = { ...diagnostics } as Record<string, unknown>;
        delete queue.syncLoopState;
        delete queue.syncLoopError;
        cliOutput("client_status", { status, localHealthy: true, connected, remoteReachable, provider: config.provider, workspace: config.principal.workspace, agent: config.principal.agent, instance: config.principal.instance ?? null, schemaVersion: diagnostics.schemaVersion, endpoint: config.url ?? null, database: config.provider === "local" ? config.databasePath : null, cursorPath: config.cursorPath, lastCursor: cursor(config.cursorPath) ?? null, queue, checks });
        if (active && status !== "ok") process.exitCode = status === "failed" ? 1 : 2;
      } catch (error) {
        failedClientStatus(config, error, { component: "local-store" });
        process.exitCode = 1;
      }
      return;
    }
    if (command === "pending") {
      const diagnostics = await runtime.store.diagnostics?.(config.principal, {
        mode: config.provider === "gateway" ? "probe" : "snapshot",
      });
      const page = await runtime.service.history(config.principal, {
        limit: 1,
        project: one(options, "project"),
        receiptState: "unread",
      });
      const pendingDeliveries = diagnostics?.pending ?? 0;
      const retryingDeliveries = diagnostics?.retrying ?? 0;
      const oldest = diagnostics?.oldestAvailableAt
        ? Date.parse(diagnostics.oldestAvailableAt)
        : Number.POSITIVE_INFINITY;
      const deliveryAvailable = pendingDeliveries > 0 ||
        (retryingDeliveries > 0 && oldest <= Date.now());
      const unread = page.messages.length > 0;
      const available = deliveryAvailable || unread;
      const diagnosticsAuthoritative = !diagnostics || !("remoteReachable" in diagnostics) ||
        diagnostics.remoteReachable === true;
      const pageAuthority = page as typeof page & {
        source?: "remote" | "cache";
        stale?: boolean;
        acknowledgements?: "authoritative" | "unknown";
      };
      const historyAuthoritative = pageAuthority.acknowledgements !== "unknown" &&
        pageAuthority.source !== "cache" && pageAuthority.stale !== true;
      const authoritative = diagnosticsAuthoritative && historyAuthoritative;
      output({
        available,
        unread,
        deliveryAvailable,
        pending: pendingDeliveries,
        retrying: retryingDeliveries,
        authoritative,
        state: available ? "available" : authoritative ? "empty" : "unknown",
      });
      if (!available) process.exitCode = authoritative ? 1 : 2;
      return;
    }
    if (command === "send") { const message = draft(options, positionals); validateRequest("publish_message", { ...message, source: one(options, "source") }); cliOutput("publish_message", await runtime.service.publish(config.principal, message)); return; }
    if (command === "join") { const input = validateRequest("heartbeat", { leaseMs: integer(options, "lease-ms", 60_000), runtimeType: one(options, "runtime"), capabilities: list(options, "capability") }); cliOutput("heartbeat", await runtime.service.heartbeat(config.principal, input)); return; }
    if (command === "presence") { validateRequest("presence", {}); cliOutput("presence", { agents: await runtime.service.presence(config.principal) }); return; }
    if (command === "sync") {
      if (!runtime.store.sync) throw new Error("sync is available only with the gateway provider");
      const input = validateRequest("sync", {
        maxPush: integer(options, "max-push", integer(options, "limit", 100)),
        maxPages: integer(options, "max-pages", 20),
      });
      cliOutput("sync", await runtime.store.sync(input));
      return;
    }
    if (command === "history" || command === "inbox" || command === "sent") { const query = validateRequest("history", { cursor: one(options, "cursor"), limit: integer(options, "limit", 20), types: list(options, "type").concat(list(options, "category")), source: one(options, "source"), project: one(options, "project"), since: since(options), mailbox: command === "inbox" ? "inbox" : command === "sent" ? "sent" : one(options, "mailbox") as any, receiptState: one(options, "receipt-state") as any, unacknowledgedBy: assertedUnackedBy, threadId: one(options, "thread-id"), latest: raw === "get" || boolean(options, "latest") }); const page = await runtime.service.history(config.principal, query); if (raw === "get") { cliOutput("history", page.messages.map((message) => ({ id: config.provider === "legacy-supabase" ? Number(message.sequence) : message.id, source: message.source, category: message.type, content: message.content, priority: message.priority, project: message.project ?? null, metadata: legacyContextMetadata(message), created_at: message.createdAt })), { command: raw, optionNames: Object.keys(options) }); } else cliOutput("history", page); return; }
    if (command === "acknowledge" || (command === "ack" && one(options, "ids"))) {
      const rawIds = list(options, "ids");
      validateRequest("record_receipt", { messageIds: rawIds });
      const acknowledged = config.provider === "legacy-supabase" &&
          runtime.store.recordLegacyReceipt && rawIds.every((id) => /^\d+$/.test(id))
        ? await runtime.store.recordLegacyReceipt(rawIds, config.principal.agent)
        : await runtime.service.acknowledge(
            config.principal,
            rawIds.map(legacyNumericMessageId),
          );
      cliOutput("record_receipt", { acknowledged, agent: config.principal.agent }, {
        command: raw,
        optionNames: Object.keys(options),
      });
      return;
    }
    if (command === "claim") { const input = validateRequest("claim_delivery", { leaseMs: integer(options, "lease-ms", 30_000), maxAttempts: one(options,"max-attempts")===undefined?undefined:integer(options,"max-attempts",5) }); cliOutput("claim_delivery", await runtime.service.claim(config.principal, input)); return; }
    if(command==="deliveries"||command==="dead-letters"){const input=validateRequest("list_deliveries",{cursor:one(options,"cursor"),limit:integer(options,"limit",50),role:one(options,"role") as any,messageId:one(options,"message-id"),recipient:one(options,"recipient"),states:command==="dead-letters"?["dead"]:list(options,"state") as any});cliOutput("list_deliveries",await runtime.service.deliveries(config.principal,input));return;}
    if(command==="delivery-events"){const input=validateRequest("list_delivery_events",{deliveryId:one(options,"delivery-id")??positionals[0],cursor:one(options,"cursor"),limit:integer(options,"limit",50)});cliOutput("list_delivery_events",await runtime.service.deliveryEvents(config.principal,String(input.deliveryId),input));return;}
    if(command==="cancel"){const input=validateRequest("cancel_delivery",{deliveryId:one(options,"delivery-id")??positionals[0]});cliOutput("cancel_delivery",await runtime.service.cancel(config.principal,String(input.deliveryId)));return;}
    if(command==="requeue"){const input=validateRequest("requeue_delivery",{deliveryId:one(options,"delivery-id")??positionals[0]});cliOutput("requeue_delivery",await runtime.service.requeue(config.principal,String(input.deliveryId)));return;}
    const deliveryId = one(options, "delivery-id") ?? positionals[0]; const leaseToken = one(options, "lease-token") ?? positionals[1];
    if (!deliveryId || !leaseToken) { if (["extend", "ack", "nack"].includes(command)) throw new Error("--delivery-id and --lease-token are required"); }
    if (command === "extend") { const input=validateRequest("extend_delivery",{deliveryId,leaseToken,leaseMs:integer(options,"lease-ms",30_000)}); cliOutput("extend_delivery",await runtime.service.extend(config.principal,String(input.deliveryId),String(input.leaseToken),input.leaseMs as number)); return; }
    if (command === "ack") { const input=validateRequest("acknowledge_delivery",{deliveryId,leaseToken}); cliOutput("acknowledge_delivery",await runtime.service.ack(config.principal,String(input.deliveryId),String(input.leaseToken))); return; }
    if (command === "nack") { const disposition=one(options,"disposition")??(boolean(options,"dead")?"dead":"retry"); const input=validateRequest("negative_acknowledge_delivery",{deliveryId,leaseToken,error:one(options,"error")??"negative acknowledgment",disposition}); cliOutput("negative_acknowledge_delivery",await runtime.service.nack(config.principal,String(input.deliveryId),String(input.leaseToken),String(input.error),input.disposition as "retry"|"dead")); return; }
    if (command === "watch") {
      const polls = one(options, "polls") === undefined ? Number.POSITIVE_INFINITY : integer(options, "polls", 0);
      const baseInterval = Math.min(integer(options, "interval-ms", 1_000), 60_000);
      const maxInterval = Math.max(baseInterval, Math.min(integer(options, "max-interval-ms", 30_000), 300_000));
      let interval = baseInterval;
      const project = one(options, "project");
      const checkpointPath = watchCursorPath(config.cursorPath, project);
      let current = cursor(checkpointPath);
      let seen = 0;
      for (let i = 0; i < polls; i++) {
        try {
          const page = await runtime.service.history(config.principal, {
            cursor: current,
            limit: integer(options, "limit", 50),
            project,
          });
          for (const message of page.messages) output(message);
          seen += page.messages.length;
          current = page.cursor;
          saveCursor(checkpointPath, current);
          interval = page.messages.length ? baseInterval : Math.min(maxInterval, Math.max(baseInterval, interval * 2));
        } catch (error) {
          const status = error instanceof BridgeHttpError || error instanceof LegacySupabaseError
            ? error.status
            : undefined;
          const retryable = status !== undefined &&
            (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500);
          if (!retryable) throw error;
          interval = Math.min(maxInterval, Math.max(baseInterval, interval * 2));
        }
        if (i + 1 < polls) {
          const jittered = Math.round(interval * (0.9 + Math.random() * 0.2));
          await new Promise((resolve) => setTimeout(resolve, jittered));
        }
      }
      if (!seen && boolean(options, "json")) output({ status: "ok", messages: 0, cursor: current ?? null });
      return;
    }
    throw new Error(`Unknown command: ${raw}`);
  } finally { await runtime.close(); }
}

export function formatCliError(error: unknown, argv = process.argv.slice(2)): string {
  const message = error instanceof Error ? error.message : String(error);
  if (argv[0] === "archive") {
    return JSON.stringify({
      schemaVersion: 1,
      status: "error",
      operation: argv[1] ?? null,
      error: {
        code: error instanceof ArchiveCommandError ? error.code : "ARCHIVE_COMMAND_ERROR",
        message: error instanceof ArchiveCommandError ? error.message : "archive command failed",
        ...(error instanceof ArchiveCommandError && error.details ? { details: error.details } : {}),
      },
    }) + "\n";
  }
  if (argv[0] === "dr") {
    return JSON.stringify({
      schemaVersion: 1,
      status: "error",
      operation: argv[1] ?? null,
      error: {
        code: error instanceof NativeDrCommandError ? error.code : "DR_COMMAND_ERROR",
        message: error instanceof NativeDrCommandError ? error.message : "DR command failed",
        ...(error instanceof NativeDrCommandError && error.details ? { details: error.details } : {}),
      },
    }) + "\n";
  }
  if (argv[0] === "owner") {
    return JSON.stringify({
      schemaVersion: 1,
      status: "error",
      operation: argv[1] ?? null,
      error: { code: "OWNER_COMMAND_ERROR", message },
    }) + "\n";
  }
  return `Error: ${message}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli().catch((error) => {
  process.stderr.write(formatCliError(error));
  process.exitCode = 1;
});
