import { createHash, randomUUID } from "node:crypto";
import { hostname, platform, arch } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RECEIPT_SCHEMA = "agent-bridge-production-proof-v1";
export const RECEIPT_VERSION = 1;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/agent-bridge");
const PHASE_FIELDS = {
  publisher: new Set(["messageId", "idempotencyKey", "receiverPrincipal", "queuedAt", "synchronizedAt"]),
  consumer: new Set(["messageId", "idempotencyKey", "publisherPrincipal", "deliveryId", "claimedAt", "acknowledgedAt", "publisherHostEvidence"]),
  verifier: new Set(["messageId", "idempotencyKey", "publisherPrincipal", "receiverPrincipal", "deliveryId", "verifiedAt", "publisherHostEvidence", "consumerHostEvidence", "machineCycle"]),
};
const COMMON_FIELDS = new Set(["schema", "version", "phase", "workspace", "principal", "gatewayOrigin", "instance", "hostEvidence", "checks"]);
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function string(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) fail(`invalid ${name}`);
  return value;
}

function timestamp(value, name) {
  string(value, name);
  if (!Number.isFinite(Date.parse(value))) fail(`invalid ${name}`);
  return value;
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${name} contains forbidden field ${key}`);
}

function validateHostEvidence(value, name = "hostEvidence") {
  exactKeys(value, new Set(["algorithm", "digest"]), name);
  if (value.algorithm !== "sha256") fail(`${name}.algorithm must be sha256`);
  string(value.digest, `${name}.digest`, SHA256);
}

function sameHostEvidence(left, right) {
  return left.algorithm === right.algorithm && left.digest === right.digest;
}

export function normalizeGatewayOrigin(value, name = "gatewayOrigin") {
  string(value, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`invalid ${name}`);
  }
  if (url.protocol !== "https:") fail(`${name} must use HTTPS`);
  if (url.username || url.password) fail(`${name} must not include userinfo`);
  if (url.pathname !== "/") fail(`${name} must not include a path`);
  if (url.search) fail(`${name} must not include a query`);
  if (url.hash) fail(`${name} must not include a fragment`);
  return url.origin;
}

function validateChecks(value) {
  if (!Array.isArray(value) || value.length === 0) fail("checks must be a nonempty array");
  for (const entry of value) {
    exactKeys(entry, new Set(["name", "ok"]), "check");
    string(entry.name, "check.name", /^[a-z][a-z0-9_.-]{0,63}$/u);
    if (entry.ok !== true) fail(`check ${entry.name} did not pass`);
  }
}

function validateMachineCycle(value) {
  exactKeys(value, new Set(["machineId", "beforeInstanceId", "afterInstanceId", "cycledAt"]), "machineCycle");
  string(value.machineId, "machineCycle.machineId");
  string(value.beforeInstanceId, "machineCycle.beforeInstanceId");
  string(value.afterInstanceId, "machineCycle.afterInstanceId");
  if (value.beforeInstanceId === value.afterInstanceId) fail("machine cycle retained the prior instance ID");
  timestamp(value.cycledAt, "machineCycle.cycledAt");
}

export function validateReceipt(value, expectedPhase) {
  const phase = value?.phase;
  if (!PHASE_FIELDS[phase] || (expectedPhase && phase !== expectedPhase)) fail("unexpected receipt phase");
  exactKeys(value, new Set([...COMMON_FIELDS, ...PHASE_FIELDS[phase]]), `${phase} receipt`);
  if (value.schema !== RECEIPT_SCHEMA || value.version !== RECEIPT_VERSION) fail("unsupported receipt schema");
  for (const key of ["workspace", "principal", "gatewayOrigin", "instance", "messageId", "idempotencyKey"]) string(value[key], key);
  if (value.gatewayOrigin !== normalizeGatewayOrigin(value.gatewayOrigin)) fail("gatewayOrigin is not canonical");
  validateHostEvidence(value.hostEvidence);
  validateChecks(value.checks);
  if (phase === "publisher") {
    string(value.receiverPrincipal, "receiverPrincipal");
    timestamp(value.queuedAt, "queuedAt");
    timestamp(value.synchronizedAt, "synchronizedAt");
  } else if (phase === "consumer") {
    string(value.publisherPrincipal, "publisherPrincipal");
    string(value.deliveryId, "deliveryId");
    timestamp(value.claimedAt, "claimedAt");
    timestamp(value.acknowledgedAt, "acknowledgedAt");
    validateHostEvidence(value.publisherHostEvidence, "publisherHostEvidence");
    if (sameHostEvidence(value.publisherHostEvidence, value.hostEvidence)) fail("publisher and consumer host evidence must differ");
  } else {
    string(value.publisherPrincipal, "publisherPrincipal");
    string(value.receiverPrincipal, "receiverPrincipal");
    string(value.deliveryId, "deliveryId");
    timestamp(value.verifiedAt, "verifiedAt");
    validateHostEvidence(value.publisherHostEvidence, "publisherHostEvidence");
    validateHostEvidence(value.consumerHostEvidence, "consumerHostEvidence");
    validateMachineCycle(value.machineCycle);
    if (sameHostEvidence(value.hostEvidence, value.publisherHostEvidence) || sameHostEvidence(value.hostEvidence, value.consumerHostEvidence)) {
      fail("verifier host evidence must differ from publisher and consumer evidence");
    }
  }
  return value;
}

export function hostEvidence(env = process.env) {
  const salt = string(env.AGENT_BRIDGE_PROOF_HOST_SALT, "AGENT_BRIDGE_PROOF_HOST_SALT");
  const digest = createHash("sha256").update([salt, hostname(), platform(), arch()].join("\0")).digest("hex");
  return { algorithm: "sha256", digest };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail(`unexpected argument ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function proofEnv({ principal, instance, edge, cursor, gatewayOrigin, offline = false }, env = process.env) {
  return {
    ...env,
    AGENT_BRIDGE_PROVIDER: "gateway",
    AGENT_BRIDGE_AGENT: principal,
    AGENT_BRIDGE_INSTANCE: instance,
    AGENT_BRIDGE_EDGE_DB: resolve(edge),
    AGENT_BRIDGE_CURSOR: resolve(cursor),
    AGENT_BRIDGE_URL: offline ? "https://127.0.0.1:1" : gatewayOrigin,
  };
}

function cli(args, env) {
  const result = spawnSync(CLI, args, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) fail(`agent-bridge ${args[0]} failed (${result.status ?? "unknown"}): ${result.stderr.trim() || "no diagnostic"}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`agent-bridge ${args[0]} returned invalid JSON`);
  }
}

function readReceipt(path, phase) {
  return validateReceipt(JSON.parse(readFileSync(resolve(path), "utf8")), phase);
}

function publishArgs({ body, receiver, idempotencyKey }) {
  return ["send", body, "--type", "production-proof", "--target", receiver, "--delivery-mode", "leased", "--idempotency-key", idempotencyKey];
}

function assertSafeReceipt(receipt, env = process.env) {
  const serialized = JSON.stringify(receipt);
  const forbiddenNames = ["TOKEN", "PASSWORD", "DATABASE_URL", "EDGE_DB", "CURSOR", "content", "body", "leaseToken"];
  for (const name of forbiddenNames) if (serialized.includes(name)) fail(`receipt contains forbidden material marker ${name}`);
  const allowedValues = new Set([
    receipt.workspace,
    receipt.principal,
    receipt.gatewayOrigin,
    receipt.instance,
    receipt.receiverPrincipal,
    receipt.publisherPrincipal,
  ].filter((value) => typeof value === "string"));
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8 || allowedValues.has(value) || name === "AGENT_BRIDGE_PROOF_HOST_SALT") continue;
    if (serialized.includes(value)) fail(`receipt contains an environment value from ${name}`);
  }
}

function writeReceipt(path, receipt) {
  validateReceipt(receipt, receipt.phase);
  assertSafeReceipt(receipt);
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(path), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export function runPublisher(options, env = process.env, execute = cli) {
  const now = new Date().toISOString();
  const idempotencyKey = options["idempotency-key"] ?? `production-proof-${randomUUID()}`;
  const body = `Agent Bridge production proof ${idempotencyKey}`;
  const gatewayOrigin = normalizeGatewayOrigin(options.gateway, "--gateway");
  const common = { principal: options.principal, instance: options.instance, edge: options.edge, cursor: options.cursor, gatewayOrigin };
  const queued = execute(publishArgs({ body, receiver: options.receiver, idempotencyKey }), proofEnv({ ...common, offline: true }, env));
  if (queued.disposition !== "queued" || queued.authoritative !== false) fail("offline publication was not queued locally");
  const sync = execute(["sync", "--max-push", "10", "--max-pages", "1"], proofEnv(common, env));
  if (sync.pending !== 0 || sync.pushed + sync.deduplicated < 1) fail("queued publication did not synchronize");
  const replay = execute(publishArgs({ body, receiver: options.receiver, idempotencyKey }), proofEnv(common, env));
  if (replay.created !== false || replay.message?.id !== queued.message?.id) fail("idempotent replay did not return the queued message");
  const receipt = {
    schema: RECEIPT_SCHEMA, version: RECEIPT_VERSION, phase: "publisher", workspace: options.workspace,
    principal: options.principal, gatewayOrigin, instance: options.instance, hostEvidence: hostEvidence(env),
    messageId: queued.message.id, idempotencyKey, receiverPrincipal: options.receiver, queuedAt: now,
    synchronizedAt: new Date().toISOString(), checks: [
      { name: "offline.queued", ok: true }, { name: "sync.authoritative", ok: true }, { name: "idempotency.same-message", ok: true },
    ],
  };
  writeReceipt(options.receipt, receipt);
  return receipt;
}

export function runConsumer(options, env = process.env, execute = cli) {
  const publisher = readReceipt(options.publisher, "publisher");
  const gatewayOrigin = normalizeGatewayOrigin(options.gateway, "--gateway");
  if (publisher.workspace !== options.workspace || publisher.receiverPrincipal !== options.principal || publisher.gatewayOrigin !== gatewayOrigin) fail("publisher receipt does not match consumer boundary");
  const common = { principal: options.principal, instance: options.instance, edge: options.edge, cursor: options.cursor, gatewayOrigin };
  const history = execute(["inbox", "--source", publisher.principal, "--limit", "100"], proofEnv(common, env));
  if (!history.messages?.some((message) => message.id === publisher.messageId)) fail("consumer could not read the exact proof message");
  const claimedAt = new Date().toISOString();
  const claim = execute(["claim", "--message-id", publisher.messageId, "--lease-ms", "60000"], proofEnv(common, env));
  if (!claim || claim.delivery?.messageId !== publisher.messageId) fail("consumer did not claim the exact proof delivery");
  const settled = execute(["ack", "--delivery-id", claim.delivery.id, "--lease-token", claim.leaseToken], proofEnv(common, env));
  if (settled?.state !== "acked") fail("consumer delivery acknowledgment was not recorded");
  const receipt = {
    schema: RECEIPT_SCHEMA, version: RECEIPT_VERSION, phase: "consumer", workspace: options.workspace,
    principal: options.principal, gatewayOrigin, instance: options.instance, hostEvidence: hostEvidence(env),
    messageId: publisher.messageId, idempotencyKey: publisher.idempotencyKey, publisherPrincipal: publisher.principal,
    deliveryId: claim.delivery.id, claimedAt, acknowledgedAt: new Date().toISOString(), publisherHostEvidence: publisher.hostEvidence,
    checks: [{ name: "host.distinct", ok: true }, { name: "message.exact", ok: true }, { name: "delivery.claimed", ok: true }, { name: "delivery.acked", ok: true }],
  };
  writeReceipt(options.receipt, receipt);
  return receipt;
}

export function runVerifier(options, env = process.env, execute = cli) {
  const publisher = readReceipt(options.publisher, "publisher");
  const consumer = readReceipt(options.consumer, "consumer");
  const cycle = JSON.parse(readFileSync(resolve(options.cycle), "utf8"));
  validateMachineCycle(cycle);
  const gatewayOrigin = normalizeGatewayOrigin(options.gateway, "--gateway");
  if (publisher.workspace !== options.workspace || consumer.workspace !== publisher.workspace || publisher.gatewayOrigin !== gatewayOrigin || consumer.gatewayOrigin !== publisher.gatewayOrigin) fail("phase receipts do not share a workspace and gateway");
  if (consumer.publisherPrincipal !== publisher.principal || publisher.receiverPrincipal !== consumer.principal || !sameHostEvidence(consumer.publisherHostEvidence, publisher.hostEvidence)) fail("consumer receipt does not match publisher identity evidence");
  if (consumer.messageId !== publisher.messageId || consumer.idempotencyKey !== publisher.idempotencyKey) fail("phase receipts do not identify the same publication");
  if (consumer.principal !== options.principal) fail("verifier principal does not match the receiver");
  if (options.instance === consumer.instance) fail("verifier instance must be fresh");
  if (existsSync(resolve(options.edge)) || existsSync(resolve(options.cursor))) fail("verifier edge and cursor paths must not exist before verification");
  const verifierHostEvidence = hostEvidence(env);
  if (sameHostEvidence(verifierHostEvidence, publisher.hostEvidence) || sameHostEvidence(verifierHostEvidence, consumer.hostEvidence)) fail("verifier host evidence must differ from publisher and consumer evidence");
  const common = { principal: options.principal, instance: options.instance, edge: options.edge, cursor: options.cursor, gatewayOrigin };
  const history = execute(["inbox", "--source", publisher.principal, "--limit", "100"], proofEnv(common, env));
  if (!history.messages?.some((message) => message.id === publisher.messageId)) fail("immutable message was not readable after machine cycle");
  const deliveries = execute(["deliveries", "--message-id", publisher.messageId, "--state", "acked", "--limit", "10"], proofEnv(common, env));
  if (!deliveries.deliveries?.some((delivery) => delivery.id === consumer.deliveryId && delivery.state === "acked")) fail("prior settlement was not recorded after machine cycle");
  const receipt = {
    schema: RECEIPT_SCHEMA, version: RECEIPT_VERSION, phase: "verifier", workspace: options.workspace,
    principal: options.principal, gatewayOrigin, instance: options.instance, hostEvidence: verifierHostEvidence,
    messageId: publisher.messageId, idempotencyKey: publisher.idempotencyKey, publisherPrincipal: publisher.principal,
    receiverPrincipal: consumer.principal, deliveryId: consumer.deliveryId, verifiedAt: new Date().toISOString(),
    publisherHostEvidence: publisher.hostEvidence, consumerHostEvidence: consumer.hostEvidence, machineCycle: cycle,
    checks: [{ name: "edge.fresh", ok: true }, { name: "instance.fresh", ok: true }, { name: "cycle.changed", ok: true }, { name: "message.immutable-readable", ok: true }, { name: "settlement.recorded", ok: true }],
  };
  writeReceipt(options.receipt, receipt);
  return receipt;
}

function main() {
  const [phase, ...argv] = process.argv.slice(2);
  const options = parseArgs(argv);
  const required = ["workspace", "principal", "instance", "gateway", "edge", "cursor", "receipt"];
  if (phase === "publisher") required.push("receiver");
  else if (phase === "consumer") required.push("publisher");
  else if (phase === "verifier") required.push("publisher", "consumer", "cycle");
  else fail("phase must be publisher, consumer, or verifier");
  for (const key of required) string(options[key], `--${key}`);
  const receipt = phase === "publisher" ? runPublisher(options) : phase === "consumer" ? runConsumer(options) : runVerifier(options);
  process.stdout.write(`${JSON.stringify({ ok: true, phase: receipt.phase, receipt: resolve(options.receipt) })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`ERROR gateway-production-proof: ${error.message}\n`); process.exitCode = 1; }
}
