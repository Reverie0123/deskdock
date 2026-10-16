// 控制面板接口测试：用临时的权限文件和日志目录，不碰真实配置。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PolicyStore } from "../dist/policy.js";
import { startPanel } from "../dist/panel.js";

test("panel api: status, policy round-trip, logs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deskdock-panel-"));
  const policyFile = path.join(dir, "policy.json");
  const logs = path.join(dir, "logs"); mkdirSync(logs);
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(logs, `${today}.jsonl`), [
    JSON.stringify({ ts: new Date().toISOString(), tool: "click", args: { x: 1, y: 2 }, target: { process: "notepad.exe", title: "x", hwnd: 1 }, outcome: "ok", ms: 5 }),
    JSON.stringify({ ts: new Date().toISOString(), tool: "type", args: { text: "3 chars" }, target: { process: "msedge.exe", title: "y", hwnd: 2 }, outcome: "denied", detail: "read-only", ms: 1 }),
    "{ torn line",
  ].join("\n") + "\n");
  const policy = new PolicyStore(policyFile); policy.ensureFile();
  const panel = await startPanel({ policy, version: "test", logsDir: logs, writeInfo: false, port: 0, token: "0123456789abcdef0123456789abcdef" });
  const token = panel.url.split("#")[1];
  const base = panel.url.split("#")[0];
  const fetch0 = globalThis.fetch;
  const fetch = (u, o = {}) => fetch0(u.replace(panel.url, base), { ...o, headers: { ...(o.headers || {}), "x-deskdock-token": token } });
  try {
    assert.equal((await fetch0(base + "api/status")).status, 401, "API without the token is refused");
    // fetch cannot override Host; use a raw request to simulate DNS rebinding
    const { request } = await import("node:http");
    const hostStatus = await new Promise((resolve) => { const r = request(base + "api/status", { headers: { host: "evil.example", "x-deskdock-token": token } }, (res) => { res.resume(); resolve(res.statusCode); }); r.end(); });
    assert.equal(hostStatus, 403, "wrong Host is refused even with the token");
    const html = await (await fetch0(base)).text();
    assert.match(html, /<title>DeskDock<\/title>/);

    const status = await (await fetch(panel.url + "api/status")).json();
    assert.equal(status.callsToday, 2); assert.equal(status.deniedToday, 1); assert.equal(status.policyPath, policyFile);

    const p = await (await fetch(panel.url + "api/policy")).json();
    assert.equal(p.rules["msedge.exe"], "read");

    const noHeader = await fetch(panel.url + "api/policy", { method: "PUT", body: JSON.stringify(p) });
    assert.equal(noHeader.status, 403, "writes require the X-DeskDock header");

    const bad = await fetch(panel.url + "api/policy", { method: "PUT", headers: { "x-deskdock": "panel" }, body: JSON.stringify({ default: "nope" }) });
    assert.equal(bad.status, 400);

    p.rules["Notepad.EXE"] = "click"; p.default = "read";
    const ok = await fetch(panel.url + "api/policy", { method: "PUT", headers: { "x-deskdock": "panel" }, body: JSON.stringify(p) });
    assert.equal(ok.status, 200);
    const onDisk = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.equal(onDisk.rules["notepad.exe"], "click", "keys are lower-cased");
    assert.equal(policy.levelFor("notepad.exe", ""), "click", "store sees the change");
    assert.equal(policy.levelFor("unknown.exe", ""), "read");

    const dates = await (await fetch(panel.url + "api/logs")).json();
    assert.deepEqual(dates.dates, [today]);
    const log = await (await fetch(panel.url + "api/logs?date=" + today)).json();
    assert.equal(log.entries.length, 2, "torn line skipped");
    const none = await (await fetch(panel.url + "api/logs?date=1999-01-01")).json();
    assert.equal(none.entries.length, 0);
    assert.equal((await fetch(panel.url + "api/nope")).status, 404);
  } finally { panel.close(); rmSync(dir, { recursive: true, force: true }); }
});
