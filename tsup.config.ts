import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/client-config.ts", "src/client-runtime.ts", "src/server.ts", "src/bridge.ts", "src/sqlite.ts", "src/gateway.ts", "src/gateway-main.ts", "src/contracts/generate.ts"],
  format: ["esm"],
  target: "es2020",
  platform: "node",
  external: ["node:sqlite"],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
