import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as proof from "../scripts/gateway-production-proof.mjs";

const execute = vi.fn();

function directory() {
  return mkdtempSync(join(tmpdir(), "agent-bridge-production-proof-test-"));
}

function options(root: string, phase: "publisher" | "consumer" | "verifier") {
  return {
    workspace: "proof-workspace",
    principal: phase === "publisher" ? "proof-sender" : "proof-receiver",
    receiver: "proof-receiver",
    instance: `${phase}-instance`,
    gateway: "https://bridge.example.test",
    edge: join(root, `${phase}.sqlite3`),
    cursor: join(root, `${phase}.cursor`),
    receipt: join(root, `${phase}.json`),
  };
}

function result(value: unknown) {
  return value;
}

const env = {
  AGENT_BRIDGE_TOKEN: "secret-bearer-value",
  AGENT_BRIDGE_PROOF_HOST_SALT: "test-host-salt-value",
  GITHUB_JOB: "receiver",
};

describe("gateway production proof", () => {
  beforeEach(() => execute.mockReset());

  it("queues offline, synchronizes, and replays one idempotency key", async () => {
    const root = directory();
    const input = options(root, "publisher");
    execute
      .mockReturnValueOnce(result({ created: true, disposition: "queued", authoritative: false, message: { id: "message-1" } }))
      .mockReturnValueOnce(result({ online: true, pending: 0, pushed: 1, deduplicated: 0 }))
      .mockReturnValueOnce(result({ created: false, disposition: "committed", authoritative: true, message: { id: "message-1" } }));

    const receipt = await proof.runPublisher(input, env, execute);

    expect(receipt.checks.map((check: { name: string }) => check.name)).toEqual([
      "offline.queued", "sync.authoritative", "idempotency.same-message",
    ]);
    expect(execute.mock.calls[0][0]).toContain(receipt.idempotencyKey);
    const messageIdIndex = execute.mock.calls[0][0].indexOf("--message-id");
    expect(execute.mock.calls[2][0][messageIdIndex + 1]).toBe(execute.mock.calls[0][0][messageIdIndex + 1]);
    expect(execute.mock.calls[0][0]).toContain("--queue-only");
    expect(execute.mock.calls[0][1].AGENT_BRIDGE_URL).toBe(input.gateway);
    expect(execute.mock.calls[0][1].AGENT_BRIDGE_WORKSPACE).toBe(input.workspace);
    expect(execute.mock.calls[1][1].AGENT_BRIDGE_URL).toBe(input.gateway);
    expect(execute.mock.calls[1][1].AGENT_BRIDGE_WORKSPACE).toBe(input.workspace);
    expect(readFileSync(input.receipt, "utf8")).not.toContain("secret-bearer-value");
    expect(readFileSync(input.receipt, "utf8")).not.toContain(input.edge);
  });

  it("requires a distinct host, exact message claim, and acknowledgment", async () => {
    const root = directory();
    const publisher = options(root, "publisher");
    execute
      .mockReturnValueOnce(result({ created: true, disposition: "queued", authoritative: false, message: { id: "message-2" } }))
      .mockReturnValueOnce(result({ online: true, pending: 0, pushed: 0, deduplicated: 1 }))
      .mockReturnValueOnce(result({ created: false, disposition: "committed", authoritative: true, message: { id: "message-2" } }));
    await proof.runPublisher(publisher, env, execute);
    const publisherReceipt = JSON.parse(readFileSync(publisher.receipt, "utf8"));
    publisherReceipt.hostEvidence.digest = "a".repeat(64);
    writeFileSync(publisher.receipt, JSON.stringify(publisherReceipt));

    const consumer = { ...options(root, "consumer"), publisher: publisher.receipt };
    execute.mockReset();
    execute
      .mockReturnValueOnce(result({ messages: [{ id: "message-2" }] }))
      .mockReturnValueOnce(result({ delivery: { id: "delivery-2", messageId: "message-2" }, leaseToken: "transient-lease-token" }))
      .mockReturnValueOnce(result({ id: "delivery-2", state: "acked" }));

    const receipt = proof.runConsumer(consumer, env, execute);

    expect(receipt.deliveryId).toBe("delivery-2");
    expect(execute.mock.calls[1][0]).toEqual(expect.arrayContaining(["--message-id", "message-2"]));
    expect(receipt.hostEvidence.digest).not.toBe(receipt.publisherHostEvidence.digest);
    expect(readFileSync(consumer.receipt, "utf8")).not.toContain("transient-lease-token");
  });

  it("uses a fresh edge and instance to verify message and settlement after an instance change", () => {
    const root = directory();
    const publisherPath = join(root, "publisher.json");
    const consumerPath = join(root, "consumer.json");
    const cyclePath = join(root, "cycle.json");
    const common = {
      schema: proof.RECEIPT_SCHEMA, version: 1, workspace: "proof-workspace", gatewayOrigin: "https://bridge.example.test",
      messageId: "message-3", idempotencyKey: "proof-key-3", checks: [{ name: "proof.ok", ok: true }],
    };
    writeFileSync(publisherPath, JSON.stringify({
      ...common, phase: "publisher", principal: "proof-sender", instance: "sender-instance", receiverPrincipal: "proof-receiver",
      hostEvidence: { algorithm: "sha256", digest: "a".repeat(64) }, queuedAt: new Date().toISOString(), synchronizedAt: new Date().toISOString(),
    }));
    writeFileSync(consumerPath, JSON.stringify({
      ...common, phase: "consumer", principal: "proof-receiver", instance: "consumer-instance", publisherPrincipal: "proof-sender",
      hostEvidence: { algorithm: "sha256", digest: "b".repeat(64) }, publisherHostEvidence: { algorithm: "sha256", digest: "a".repeat(64) },
      deliveryId: "delivery-3", claimedAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString(),
    }));
    writeFileSync(cyclePath, JSON.stringify({
      machineId: "machine-one", beforeStartEventTimestamp: 1_000, afterStartEventTimestamp: 2_000,
      cycledAt: new Date().toISOString(),
    }));
    execute
      .mockReturnValueOnce(result({ messages: [{ id: "message-3" }] }))
      .mockReturnValueOnce(result({ deliveries: [{ id: "delivery-3", messageId: "message-3", state: "acked" }] }));
    const verifier = { ...options(root, "verifier"), publisher: publisherPath, consumer: consumerPath, cycle: cyclePath };

    const receipt = proof.runVerifier(verifier, env, execute);

    expect(receipt.machineCycle).toMatchObject({
      machineId: "machine-one", beforeStartEventTimestamp: 1_000, afterStartEventTimestamp: 2_000,
    });
    expect(receipt.checks).toContainEqual({ name: "settlement.recorded", ok: true });
    expect(execute.mock.calls[0][1].AGENT_BRIDGE_EDGE_DB).toBe(verifier.edge);
  });

  it("rejects additive fields outside the versioned phase boundary", () => {
    expect(() => proof.validateReceipt({ phase: "publisher", bearer: "forbidden" }, "publisher"))
      .toThrow(/forbidden field bearer|unsupported receipt schema/u);
  });

  it("keeps the manual workflow pinned, gated, and free of input interpolation in shell source", () => {
    const workflow = readFileSync(new URL("../.github/workflows/gateway-production-proof.yml", import.meta.url), "utf8");
    const runBlocks = [...workflow.matchAll(/\n\s+run: \|\n((?:\s{10}.+(?:\n|$))*)/gu)]
      .map((match) => match[1])
      .join("\n");
    const actionRefs = [...workflow.matchAll(/uses: ([^\s#]+)/gu)].map((match) => match[1]);

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow.match(/environment: agent-bridge-production-proof/gu)).toHaveLength(4);
    expect(workflow).toContain("FLYCTL_VERSION: \"0.4.71\"");
    expect(workflow).toContain('.type == "start"');
    expect(workflow).toContain(".timestamp");
    expect(workflow.match(/install -d -m 700 "\$RUNNER_TEMP\/agent-bridge-proof"/gu)).toHaveLength(4);
    expect(workflow).not.toMatch(/--(?:edge|cursor) "\$RUNNER_TEMP\/(?!agent-bridge-proof\/)/u);
    expect(workflow).not.toContain("machine clone");
    expect(runBlocks).not.toContain("${{ inputs.");
    expect(runBlocks).not.toContain("--yes");
    expect(actionRefs.every((reference) => /@[0-9a-f]{40}$/u.test(reference))).toBe(true);
  });

  it("rejects credential-bearing and non-origin gateway URLs", () => {
    const credentialBearing = new URL("https://bridge.example.test");
    credentialBearing.username = "user";
    credentialBearing.password = "secret";
    for (const value of [
      "http://bridge.example.test",
      credentialBearing.href,
      "https://bridge.example.test/v2",
      "https://bridge.example.test?token=secret",
      "https://bridge.example.test/#fragment",
    ]) {
      expect(() => proof.normalizeGatewayOrigin(value)).toThrow();
    }
    expect(proof.normalizeGatewayOrigin("https://bridge.example.test/")).toBe("https://bridge.example.test");
  });

  it("rejects altered phase linkage and pre-existing verifier state", () => {
    const root = directory();
    const publisherPath = join(root, "publisher.json");
    const consumerPath = join(root, "consumer.json");
    const cyclePath = join(root, "cycle.json");
    const verifier = { ...options(root, "verifier"), publisher: publisherPath, consumer: consumerPath, cycle: cyclePath };
    const common = {
      schema: proof.RECEIPT_SCHEMA, version: 1, workspace: "proof-workspace", gatewayOrigin: "https://bridge.example.test",
      messageId: "message-4", idempotencyKey: "proof-key-4", checks: [{ name: "proof.ok", ok: true }],
    };
    writeFileSync(publisherPath, JSON.stringify({
      ...common, phase: "publisher", principal: "proof-sender", instance: "sender-instance", receiverPrincipal: "proof-receiver",
      hostEvidence: { algorithm: "sha256", digest: "a".repeat(64) }, queuedAt: new Date().toISOString(), synchronizedAt: new Date().toISOString(),
    }));
    writeFileSync(consumerPath, JSON.stringify({
      ...common, workspace: "altered-workspace", phase: "consumer", principal: "proof-receiver", instance: "consumer-instance",
      publisherPrincipal: "proof-sender", hostEvidence: { algorithm: "sha256", digest: "b".repeat(64) },
      publisherHostEvidence: { algorithm: "sha256", digest: "a".repeat(64) }, deliveryId: "delivery-4",
      claimedAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString(),
    }));
    writeFileSync(cyclePath, JSON.stringify({
      machineId: "machine-one", beforeStartEventTimestamp: 1_000, afterStartEventTimestamp: 2_000,
      cycledAt: new Date().toISOString(),
    }));

    expect(() => proof.runVerifier(verifier, env)).toThrow(/workspace and gateway/u);

    const consumer = JSON.parse(readFileSync(consumerPath, "utf8"));
    consumer.workspace = "proof-workspace";
    writeFileSync(consumerPath, JSON.stringify(consumer));
    writeFileSync(verifier.edge, "pre-existing state");
    expect(() => proof.runVerifier(verifier, env)).toThrow(/must not exist/u);
    expect(execute).not.toHaveBeenCalled();
  });
});
