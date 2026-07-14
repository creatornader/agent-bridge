function normalizeSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveAgentIdentity(
  requestedAgent: unknown,
  configuredAgent: unknown,
  field = "agent",
): string | undefined {
  const requested = normalizeSource(requestedAgent);
  const configured = normalizeSource(configuredAgent);

  if (requested && configured && requested !== configured) {
    throw new Error(
      `${field} must match AGENT_BRIDGE_AGENT (${configured}); got ${requested}`,
    );
  }

  return requested ?? configured;
}

export function resolvePostSource(
  requestedSource: unknown,
  configuredAgent: unknown,
): string | undefined {
  return resolveAgentIdentity(requestedSource, configuredAgent, "source");
}
