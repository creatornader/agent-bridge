export function formatContractArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeContractArtifact(contents: string): string {
  return contents.replace(/\r\n?/g, "\n");
}
