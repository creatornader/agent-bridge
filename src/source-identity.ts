function normalizeSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePostSource(
  requestedSource: unknown,
  configuredAgent: unknown
): string | undefined {
  const source = normalizeSource(requestedSource);
  const configured = normalizeSource(configuredAgent);

  if (source && configured && source !== configured) {
    throw new Error(
      `source must match AGENT_BRIDGE_AGENT (${configured}); got ${source}`
    );
  }

  return source ?? configured;
}
