// 端到端：权限 ask 档。把 notepad.exe 设为 ask，让 MCP 服务往记事本里打字；弹出的确认框由第二个辅助进程实例去点「是」。
// 再测一次点「否」。真实注入键鼠。运行：node tests/e2e/ask.e2e.mjs
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd();
const home = path.join(process.env.LOCALAPPDATA, "Temp", "deskdock", "ask-home"); rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, "policy.json"), JSON.stringify({ version: 1, default: "full", rules: { "notepad.exe": "ask" } }));

// a second, independent helper instance acts as "the user" clicking the dialog
const p = spawn(path.join(root, "resources", "deskdock-native.exe"), ["--helper"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: p.stdout }); const q = new Map(); let id = 1;
rl.on("line", (l) => { const m = JSON.parse(l); const cb = q.get(m.id); q.delete(m.id); cb(m); });
const user = (op, args = {}) => new Promise((res, rej) => { const i = id++; q.set(i, (m) => (m.ok ? res(m.result) : rej(new Error(m.error)))); p.stdin.write(JSON.stringify({ id: i, op, args }) + "\n"); });
async function answerDialog(button) {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const dlg = (await user("list_windows")).find((w) => /deskdock-native.exe/i.test(w.process) && w.title === "DeskDock");
    if (!dlg) continue;
    const snap = await user("uia_snapshot", { hwnd: dlg.hwnd, interactiveOnly: true });
    const text = snap.nodes.filter((n) => n.type === "text").map((n) => n.name).join(" ");
    const btn = snap.nodes.find((n) => n.type === "button" && new RegExp(button, "i").test(n.name));
    if (!btn) throw new Error("button not found in dialog: " + snap.nodes.map((n) => `${n.type}:${n.name}`).join(","));
    log(`dialog says: ${text.slice(0, 120)}`); log(`clicking "${btn.name}"`);
    await user("uia_click", { ref: btn.ref });
    return true;
  }
  throw new Error("confirmation dialog never appeared");
}

const client = new Client({ name: "deskdock-e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "pipe", env: { ...process.env, DESKDOCK_HOME: home } }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: r.isError === true, text: r.content.find((c) => c.type === "text")?.text ?? "" }; };
const windows = async () => (await call("list_windows")).text.split("\n").filter(Boolean);
const hwndOf = (l) => Number(/hwnd=(\d+)/.exec(l)[1]);

const dir = path.join(process.env.LOCALAPPDATA, "Temp", "deskdock", "e2e"); mkdirSync(dir, { recursive: true });
const fileName = `ask-${Date.now()}.txt`; const file = path.join(dir, fileName); writeFileSync(file, "", "utf8");
const before = (await windows()).find((l) => l.includes("(focused)"));
let tab = null;
try {
  spawn("notepad.exe", [file], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 40 && !tab; i++) { await sleep(250); tab = (await windows()).find((l) => /\[notepad\.exe\]/i.test(l) && l.includes(fileName)); }
  if (!tab) throw new Error("notepad did not open");
  const hwnd = hwndOf(tab);
  // focus_window on an ask-level app asks too: answer yes
  const focusP = call("focus_window", { hwnd }); await answerDialog("允许一次|Allow once"); log("focus:", (await focusP).text.slice(0, 60));
  await sleep(300);
  const tree = (await call("read_window", { hwnd })).text; // reads never ask
  const edit = tree.split("\n").find((l) => /\]\s+(document|edit)\b/.test(l));
  const clickP = call("click", { ref: Number(/\[(\d+)\]/.exec(edit)[1]) }); await answerDialog("允许一次|Allow once"); log("click:", (await clickP).text.slice(0, 60));
  await sleep(200);
  const typeP = call("type", { text: "ASK-YES" }); await answerDialog("允许一次|Allow once"); const t1 = await typeP; log("type (yes):", t1.err ? "ERR " + t1.text : t1.text.slice(0, 60));
  if (t1.err) throw new Error("type after yes failed");
  const typeP2 = call("type", { text: "ASK-NO" }); await answerDialog("^拒绝|^Deny"); const t2 = await typeP2; log("type (no):", t2.text.slice(0, 90));
  if (!t2.err || !/declined/.test(t2.text)) throw new Error("declined type was not refused");
  const saveP = call("key", { keys: "ctrl+s" }); await answerDialog("允许一次|Allow once"); await saveP; await sleep(500);
  // "allow this app from now on": the next action must go through without any dialog
  const typeP3 = call("type", { text: "-ALL" }); await answerDialog("以后都允许|from now on"); const t3 = await typeP3; log("type (allow app):", t3.err ? "ERR " + t3.text : t3.text.slice(0, 60));
  if (t3.err) throw new Error("type after allow-app failed");
  const saveP2 = call("key", { keys: "ctrl+s" });
  const r2 = await Promise.race([saveP2, sleep(8000).then(() => null)]);
  if (!r2) throw new Error("a dialog still appeared after allowing the app for the session");
  log("save without dialog:", r2.text.slice(0, 60)); await sleep(500);
  const written = readFileSync(file, "utf8").replace(/^﻿/, "").trim();
  log("written:", JSON.stringify(written));
  if (written !== "ASK-YES-ALL") throw new Error("file content mismatch");
  log("PASS: ask level confirms each action; declined action did nothing; allow-for-session silences later prompts");
} finally {
  try { const t = (await windows()).find((l) => /\[notepad\.exe\]/i.test(l) && l.includes(fileName)); if (t) { await user("focus_window", { hwnd: hwndOf(t) }); await sleep(200); await user("key", { keys: "ctrl+w" }); await sleep(300); } } catch { /* ignore */ }
  if (before) { try { await user("focus_window", { hwnd: hwndOf(before) }); } catch { /* ignore */ } }
  try { unlinkSync(file); } catch { /* ignore */ }
  await client.close(); p.stdin.end();
  rmSync(home, { recursive: true, force: true });
}
