#!/usr/bin/env node
// DeskDock MCP server entry: stdio transport, used by Claude Code / Claude Desktop / Cursor / Cline / Cherry Studio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Helper } from "./helper.js";
import { PolicyStore, policyPath } from "./policy.js";
import { Audit } from "./audit.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

export function createServer(deps?: { helper?: Helper; policy?: PolicyStore; audit?: Audit }): { server: McpServer; helper: Helper } {
  const helper = deps?.helper ?? new Helper();
  const policy = deps?.policy ?? new PolicyStore();
  const audit = deps?.audit ?? new Audit();
  const server = new McpServer(
    { name: "deskdock", version: VERSION },
    {
      instructions: [
        "DeskDock lets you operate Windows desktop apps.",
        "Workflow: list_windows -> focus_window -> read_window (preferred) or screenshot -> click / type / key -> read_window again to verify.",
        "Refs from read_window expire on the next read_window. Coordinates are physical screen pixels.",
        `Some apps are read-only or blocked by the user's policy (${policyPath()}); when a tool is denied, tell the user plainly and ask them to do that step.`,
        "Never type passwords or payment details; ask the user to enter those themselves.",
      ].join(" "),
    },
  );
  registerTools(server, { helper, policy, audit });
  return { server, helper };
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    process.stderr.write("DeskDock only runs on Windows.\n");
    process.exit(1);
  }
  const policy = new PolicyStore();
  policy.ensureFile();
  const { server, helper } = createServer({ policy });
  const transport = new StdioServerTransport();
  const shutdown = () => { helper.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(transport);
  process.stderr.write(`DeskDock ${VERSION} ready (policy: ${policyPath()})\n`);
}

const isMain = process.argv[1] && /index\.(js|ts)$/.test(process.argv[1]);
if (isMain) main().catch((e) => { process.stderr.write(`DeskDock failed: ${(e as Error).stack ?? e}\n`); process.exit(1); });
