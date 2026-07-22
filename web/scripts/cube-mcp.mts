// Stdio MCP server for the cube wiki (local dev).
// Register with: claude mcp add cube-wiki -- npx tsx web/scripts/cube-mcp.mts
// Writes are attributed to the CUBE_MCP_USER name (default "mcp-agent").

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { createCube } from "cube";
import { createCubeMcpServer } from "cube/mcp";
import { hpComponents } from "../src/cube/schemas";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres:///curator",
  statement_timeout: 15_000,
});

const cube = createCube({ db: { pool }, components: hpComponents });
const server = createCubeMcpServer(cube, {
  user: { id: 0, name: process.env.CUBE_MCP_USER ?? "mcp-agent", roles: ["moderator"] },
});

await server.connect(new StdioServerTransport());
