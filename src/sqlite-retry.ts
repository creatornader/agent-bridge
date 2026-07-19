function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqlite = error as Error & { errcode?: number };
  return sqlite.errcode === 5 || /database is (?:locked|busy)/i.test(error.message);
}

export const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 15_000;

export async function retrySqliteBusy<T>(
  operation: () => T,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + Math.max(1, Math.trunc(timeoutMs));
  let delayMs = 5;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 50);
    }
  }
}
