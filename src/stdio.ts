import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@/server";
import { closeDb } from "./be/db";
import { wireIntegrations } from "./be/wiring.ts";

async function main() {
  wireIntegrations();
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  await server.sendLoggingMessage({
    level: "info",
    data: "MCP server connected via stdio",
  });
}

main()
  .catch(console.error)
  .finally(() => {
    closeDb();
  });
