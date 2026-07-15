export function createBoundedToolOutput(maximumBytes: number): {
  push(chunk: Buffer): void;
  read(): { bytes: Buffer; truncated: boolean };
} {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("tool output capture limit is invalid");
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      const remaining = maximumBytes - capturedBytes;
      if (remaining > 0) {
        const captured = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
      if (chunk.length > remaining) truncated = true;
    },
    read() {
      return { bytes: Buffer.concat(chunks, capturedBytes), truncated };
    },
  };
}
