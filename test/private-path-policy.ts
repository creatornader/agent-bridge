import { it, type TestOptions } from "vitest";
import {
  createInProcessPrivatePathPolicy,
  withPrivatePathPolicy,
} from "../src/private-path.js";

const policy = createInProcessPrivatePathPolicy();

export function privatePathIt(
  name: string,
  handler: () => unknown,
  options?: number | TestOptions,
): void {
  it(name, () => withPrivatePathPolicy(policy, handler), options);
}
