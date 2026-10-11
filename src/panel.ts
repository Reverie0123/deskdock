// Local control panel: a tiny HTTP server on 127.0.0.1 serving resources/panel.html and a JSON API over the
// policy file and the audit logs. No framework, no dependencies; the tray app and `deskdock panel` open it in the browser.
import http from "node:http";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyStore, policyDir, DEFAULT_POLICY, type Policy, type Level } from "./policy.js";
import { MacroStore, MACRO_NAME } from "./macros.js";

const LEVELS: Level[] = ["block", "read", "click", "full"];

function panelHtmlPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.resolve(here, "../resources/panel.html"), path.resolve(here, "../../resources/panel.html")]) if (existsSync(p)) return p;
  throw new Error("resources/panel.html not found");
}
function defaultLogsDir(): string { return path.join(policyDir(), "logs"); }

export function listLogDates(dir: string = defaultLogsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
}
export function readLog(date: string, dir: string = defaultLogsDir()): unknown[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const file = path.join(dir, `${date}.jsonl`);
  if (!existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

function validatePolicy(raw: unknown): Policy {
  const p = raw as Partial<Policy>;
  if (!p || typeof p !== "object") throw new Error("policy must be an object");
  const def = (p.default ?? "full") as Level;
  if (!LEVELS.includes(def)) throw new Error(`bad default level: ${String(p.default)}`);
  const rules: Record<string, Level> = {};
  for (const [k, v] of Object.entries(p.rules ?? {})) {
    const key = k.trim().toLowerCase();
    if (!key) continue;
    if (!LEVELS.includes(v as Level)) throw new Error(`bad level for ${k}: ${String(v)}`);
    rules[key] = v as Level;
  }
  return { version: 1, default: def, rules };
}

export interface PanelHandle { port: number; url: string; close: () => void }

export function startPanel(opts: { policy: PolicyStore; port?: number; version: string; logsDir?: string; writeInfo?: boolean; macros?: MacroStore }): Promise<PanelHandle> {
  const html = readFileSync(panelHtmlPath(), "utf8");
  const logs = opts.logsDir ?? defaultLogsDir();
  const macros = opts.macros ?? new MacroStore();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // DNS-rebinding guard: a page on another origin can be made same-origin only by changing Host
    const host = String(req.headers.host ?? "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) { res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden host"); return; }
    const send = (code: number, body: string, type = "application/json; charset=utf-8") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    const json = (code: number, v: unknown) => send(code, JSON.stringify(v));
    try {
      if (req.method === "GET" && url.pathname === "/") return send(200, html, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/status") {
        const today = new Date().toISOString().slice(0, 10);
        const entries = readLog(today, logs) as { outcome?: string }[];
        return json(200, { version: opts.version, policyPath: opts.policy.file, logsDir: logs, today, callsToday: entries.length, deniedToday: entries.filter((e) => e.outcome === "denied").length, levels: LEVELS, defaults: DEFAULT_POLICY });
      }
      if (req.method === "GET" && url.pathname === "/api/policy") return json(200, opts.policy.get());
      if (req.method === "PUT" && url.pathname === "/api/policy") {
        if (req.headers["x-deskdock"] !== "panel") return json(403, { error: "missing X-DeskDock header" });
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
        req.on("end", () => {
          try {
            const policy = validatePolicy(JSON.parse(body));
            mkdirSync(path.dirname(opts.policy.file), { recursive: true });
            writeFileSync(opts.policy.file, JSON.stringify(policy, null, 2) + "\n", "utf8");
            json(200, policy);
          } catch (e) { json(400, { error: (e as Error).message }); }
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/logs") {
        const date = url.searchParams.get("date");
        if (!date) return json(200, { dates: listLogDates(logs) });
        return json(200, { date, entries: readLog(date, logs) });
      }
      if (req.method === "GET" && url.pathname === "/api/macros") return json(200, { macros: macros.list() });
      if (req.method === "DELETE" && url.pathname === "/api/macros") {
        if (req.headers["x-deskdock"] !== "panel") return json(403, { error: "missing X-DeskDock header" });
        const name = url.searchParams.get("name") ?? "";
        if (!MACRO_NAME.test(name)) return json(400, { error: "bad macro name" });
        return json(macros.delete(name) ? 200 : 404, { deleted: name });
      }
      json(404, { error: "not found" });
    } catch (e) { json(500, { error: (e as Error).message }); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
      const url = `http://127.0.0.1:${port}/`;
      if (opts.writeInfo !== false) try { mkdirSync(policyDir(), { recursive: true }); writeFileSync(path.join(policyDir(), "panel.json"), JSON.stringify({ port, url, pid: process.pid, started: new Date().toISOString() }), "utf8"); } catch { /* ignore */ }
      resolve({ port, url, close: () => server.close() });
    });
  });
}
