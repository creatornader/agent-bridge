import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("Failed to start agent-bridge MCP server:", err);
  process.exit(1);
});
