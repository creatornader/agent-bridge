const raw = process.argv[2];
if (raw === undefined) process.exit(1);

let result;
try {
  result = JSON.parse(raw);
} catch {
  process.exit(1);
}

const version = Array.isArray(result) ? result[0] : result;
if (typeof version !== "string" || version.length === 0) process.exit(1);
process.stdout.write(version);
