// `deskdock setup`: write DeskDock into each installed MCP client's config. `--remove` undoes it, `--dry-run` only prints.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SetupOptions { remove?: boolean; dryRun?: boolean; lang?: "zh" | "en"; /** limit to these client ids (claude-code, claude-desktop, cursor, cline, cline-cursor, windsurf) */ clients?: string[] }
export const CLIENT_IDS: Record<string, string> = { "claude-code": "Claude Code", "claude-desktop": "Claude Desktop", cursor: "Cursor", cline: "Cline (VS Code)", "cline-cursor": "Cline (Cursor)", windsurf: "Windsurf" };
export interface ClientResult { client: string; status: "written" | "removed" | "skipped" | "manual" | "error"; detail: string }

const SERVER_NAME = "deskdock";

function home(): string { return process.env.USERPROFILE ?? process.env.HOME ?? "."; }
function appdata(): string { return process.env.APPDATA ?? path.join(home(), "AppData", "Roaming"); }

/** How a client should launch us. Prefer the installed CLI; fall back to `node dist/index.js` of this checkout. */
export function launchSpec(): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.resolve(here, "index.js");
  // Always absolute paths: MCP clients spawn the command without a shell, so a `deskdock` / `deskdock.cmd` shim on PATH
  // does not start on Windows, and PATH changes need a new session anyway. node.exe + dist/index.js works everywhere.
  return { command: process.execPath, args: [entry] };
}

type JsonFileClient = { client: string; file: string; key: "mcpServers"; exists: () => boolean };

/** Claude Desktop config locations: the direct download uses %APPDATA%\Claude; the Microsoft Store build is sandboxed
 *  and keeps its files under %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude. Both may exist; each one that
 *  has a config file (or a real app folder) is configured. */
function claudeDesktopClients(): JsonFileClient[] {
  const out: JsonFileClient[] = [];
  const direct = path.join(appdata(), "Claude");
  if (existsSync(path.join(direct, "claude_desktop_config.json")) || existsSync(path.join(direct, "config.json")))
    out.push({ client: "Claude Desktop", file: path.join(direct, "claude_desktop_config.json"), key: "mcpServers", exists: () => true });
  const packages = path.join(process.env.LOCALAPPDATA ?? path.join(home(), "AppData", "Local"), "Packages");
  try {
    for (const d of readdirSync(packages)) {
      if (!/^Claude_/.test(d)) continue;
      const dir = path.join(packages, d, "LocalCache", "Roaming", "Claude");
      if (existsSync(dir)) out.push({ client: "Claude Desktop (Store)", file: path.join(dir, "claude_desktop_config.json"), key: "mcpServers", exists: () => true });
    }
  } catch { /* no Packages dir */ }
  if (out.length === 0) out.push({ client: "Claude Desktop", file: path.join(direct, "claude_desktop_config.json"), key: "mcpServers", exists: () => existsSync(direct) });
  return out;
}

function jsonClients(): JsonFileClient[] {
  const vscodeCline = path.join(appdata(), "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
  const cursorCline = path.join(appdata(), "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
  return [
    ...claudeDesktopClients(),
    { client: "Cursor", file: path.join(home(), ".cursor", "mcp.json"), key: "mcpServers", exists: () => existsSync(path.join(home(), ".cursor")) || existsSync(path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor")) },
    { client: "Cline (VS Code)", file: vscodeCline, key: "mcpServers", exists: () => existsSync(path.dirname(path.dirname(vscodeCline))) },
    { client: "Cline (Cursor)", file: cursorCline, key: "mcpServers", exists: () => existsSync(path.dirname(path.dirname(cursorCline))) },
    { client: "Windsurf", file: path.join(home(), ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", exists: () => existsSync(path.join(home(), ".codeium", "windsurf")) },
  ];
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function updateJsonClient(c: JsonFileClient, opts: SetupOptions): ClientResult {
  if (!c.exists()) return { client: c.client, status: "skipped", detail: `not installed (${path.dirname(c.file)} missing)` };
  let data: Record<string, unknown>;
  try { data = readJson(c.file); } catch (e) { return { client: c.client, status: "error", detail: `${c.file} is not valid JSON: ${(e as Error).message}; fix or delete it and rerun` }; }
  const servers = (data[c.key] as Record<string, unknown> | undefined) ?? {};
  const had = SERVER_NAME in servers;
  if (opts.remove) {
    if (!had) return { client: c.client, status: "skipped", detail: "not configured" };
    delete servers[SERVER_NAME];
  } else {
    const spec = launchSpec();
    servers[SERVER_NAME] = { command: spec.command, args: spec.args };
  }
  data[c.key] = servers;
  if (opts.dryRun) return { client: c.client, status: opts.remove ? "removed" : "written", detail: `(dry run) would ${opts.remove ? "remove from" : had ? "update" : "add to"} ${c.file}` };
  mkdirSync(path.dirname(c.file), { recursive: true });
  if (existsSync(c.file)) {
    if (!existsSync(c.file + ".deskdock.bak")) copyFileSync(c.file, c.file + ".deskdock.bak"); // the original, kept forever
    copyFileSync(c.file, c.file + ".deskdock.prev");                                            // the state before this run
  }
  writeFileSync(c.file, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { client: c.client, status: opts.remove ? "removed" : "written", detail: `${had ? "updated" : "added"} in ${c.file}${existsSync(c.file + ".deskdock.bak") ? " (backup: .deskdock.bak)" : ""}` };
}

function claudeCodeAvailable(): boolean {
  try { execSync("claude --version", { stdio: "ignore", timeout: 20000 }); return true; } catch { return false; }
}

function updateClaudeCode(opts: SetupOptions): ClientResult {
  if (!claudeCodeAvailable()) return { client: "Claude Code", status: "skipped", detail: "claude CLI not found on PATH" };
  const spec = launchSpec();
  const args = opts.remove
    ? ["mcp", "remove", "-s", "user", SERVER_NAME]
    : ["mcp", "add", "-s", "user", SERVER_NAME, "--", spec.command, ...spec.args];
  if (opts.dryRun) return { client: "Claude Code", status: opts.remove ? "removed" : "written", detail: `(dry run) would run: claude ${args.join(" ")}` };
  // claude is a .cmd shim, so cmd.exe is unavoidable; every argument is quoted (quotes escaped) so that & ^ ( ) in a
  // path cannot be interpreted, and the whole line is passed verbatim.
  const q = (a: string) => `"${a.replace(/"/g, '\\"')}"`;
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${["claude", ...args].map(q).join(" ")}"`], { stdio: "pipe", timeout: 30000, windowsVerbatimArguments: true, encoding: "utf8" });
  if (r.status === 0) return { client: "Claude Code", status: opts.remove ? "removed" : "written", detail: `ran: claude ${args.join(" ")}` };
  {
    const msg = (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).toString();
    if (!opts.remove && /already exists/i.test(msg)) return { client: "Claude Code", status: "skipped", detail: "already configured (run with --remove first to change it)" };
    return { client: "Claude Code", status: "error", detail: msg.trim() };
  }
}

export function manualSnippet(): string {
  const spec = launchSpec();
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: spec.command, args: spec.args } } }, null, 2);
}

export function runSetup(opts: SetupOptions = {}): ClientResult[] {
  const wanted = opts.clients?.length ? new Set(opts.clients.map((c) => CLIENT_IDS[c] ?? c)) : undefined;
  const pick = (name: string) => !wanted || wanted.has(name) || (name === "Claude Desktop (Store)" && wanted.has("Claude Desktop"));
  const results: ClientResult[] = [];
  if (pick("Claude Code")) results.push(updateClaudeCode(opts));
  for (const c of jsonClients()) if (pick(c.client)) results.push(updateJsonClient(c, opts));
  results.push({ client: "Cherry Studio / others", status: "manual", detail: "add an MCP server of type stdio with the command below" });
  return results;
}

export function formatResults(results: ClientResult[], lang: "zh" | "en"): string {
  const zh = lang === "zh";
  const label: Record<ClientResult["status"], string> = zh
    ? { written: "已写入", removed: "已移除", skipped: "跳过", manual: "手动", error: "出错" }
    : { written: "written", removed: "removed", skipped: "skipped", manual: "manual", error: "error" };
  const lines = results.map((r) => `${label[r.status].padEnd(zh ? 4 : 8)}  ${r.client.padEnd(22)}  ${r.detail}`);
  lines.push("", zh ? "手动配置时粘贴这段：" : "Manual configuration snippet:", manualSnippet());
  lines.push("", zh ? "改完配置后重启对应的客户端。" : "Restart the client after changing its configuration.");
  return lines.join("\n");
}
