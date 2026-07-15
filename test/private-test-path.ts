import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securePrivatePath } from "../src/private-path.js";

export function privateTestDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  securePrivatePath(path, "directory");
  return path;
}

export function secureTestFile(path: string): void { securePrivatePath(path, "file"); }
