import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [secretName, modulePath, ...moduleArguments] = process.argv.slice(2);

if (!secretName || !modulePath) {
  throw new Error("secret entrypoint requires a secret name and module path");
}
if (secretName !== "postgres_password" && secretName !== "runtime_password") {
  throw new Error("unsupported Agent Bridge secret name");
}
if (process.getuid?.() !== 0) {
  throw new Error("Agent Bridge secret entrypoint must start as root");
}

const secret = readFileSync(`/run/secrets/${secretName}`, "utf8").replace(/[\r\n]+$/u, "");
if (!secret) throw new Error("Agent Bridge database password is empty");
process.env.PGPASSWORD = secret;

process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
if (process.getuid() !== 1000 || process.getgid() !== 1000) {
  throw new Error("Agent Bridge secret entrypoint did not drop privileges");
}

const absoluteModulePath = resolve(modulePath);
process.argv = [process.execPath, absoluteModulePath, ...moduleArguments];
await import(pathToFileURL(absoluteModulePath).href);
