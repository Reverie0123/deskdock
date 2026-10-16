// 端到端：把「在记事本里输入一段文字并保存」录成宏，再用宏一步跑一遍。真实注入键鼠。
// 运行：node tests/e2e/macro.e2e.mjs
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const home = path.join(process.env.LOCALAPPDATA, "Temp", "deskdock", "e2e-home"); mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, "policy.json"), JSON.stringify({ version: 1, default: "full", rules: { "notepad.exe": "full" } }));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwndOf = (line) => Number(/hwnd=(\d+)/.exec(line)[1]);
const refOf = (line) => Number(/\[(\d+)\]/.exec(line)[1]);

const client = new Client({ name: "deskdock-e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "pipe", env: { ...process.env, DESKDOCK_HOME: home } }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.find((c) => c.type === "text")?.text ?? ""; if (r.isError) throw new Error(`${name} -> ${t}`); return t; };
const windows = async () => (await call("list_windows")).split("\n").filter(Boolean);
const assertOurs = async (fileName) => { const fg = (await windows()).find((l) => l.includes("(focused)")) ?? ""; if (!/\[notepad\.exe\]/i.test(fg) || !fg.includes(fileName)) throw new Error("refusing input: foreground is " + fg.slice(0, 90)); };

const dir = path.join(process.env.LOCALAPPDATA, "Temp", "deskdock", "e2e"); mkdirSync(dir, { recursive: true });
const before = (await windows()).find((l) => l.includes("(focused)"));
const openNotepad = async (fileName) => {
  const target = path.join(dir, fileName); writeFileSync(target, "", "utf8");
  spawn("notepad.exe", [target], { detached: true, stdio: "ignore" }).unref();
  let win; for (let i = 0; i < 40 && !win; i++) { await sleep(250); win = (await windows()).find((l) => /\[notepad\.exe\]/i.test(l) && l.includes(fileName)); }
  if (!win) throw new Error("notepad did not open " + fileName);
  await call("focus_window", { hwnd: hwndOf(win) }); await sleep(300); await assertOurs(fileName);
  return { hwnd: hwndOf(win), target };
};
const closeTab = async (fileName) => { try { await assertOurs(fileName); await call("key", { keys: "ctrl+w" }); await sleep(400); } catch (e) { log("close:", e.message); } };

let f1 = null, f2 = null;
try {
  // 1) do the task once by hand (through the tools), as a model would
  const stamp = Date.now();
  const n1 = `macro-rec-${stamp}.txt`; f1 = await openNotepad(n1);
  const tree = await call("read_window", { hwnd: f1.hwnd });
  const edit = tree.split("\n").find((l) => /\]\s+(document|edit)\b/.test(l));
  await call("click", { ref: refOf(edit) }); await sleep(150);
  await assertOurs(n1); await call("type", { text: "RECORDED-TEXT" }); await sleep(150);
  await assertOurs(n1); await call("key", { keys: "ctrl+s" }); await sleep(500);
  log("recorded run done; file:", readFileSync(f1.target, "utf8").trim());

  // 2) save the last 3 actions (click by ref, type, key) as a macro; make the typed text a parameter
  const saved = await call("save_macro", { name: "notepad_type_save", description: "Type text into the open Notepad tab and save it", fromLast: 3, params: [{ name: "text", description: "what to type" }], replace: { "RECORDED-TEXT": "text" } });
  log(saved.split("\n").slice(0, 6).join("\n"));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  if (!tools.includes("macro_notepad_type_save")) throw new Error("macro tool not registered: " + tools.join(","));
  await closeTab(n1);

  // 3) replay on a fresh file through the macro tool (click step is resolved by control name/type, not by the old ref)
  const n2 = `macro-play-${stamp}.txt`; f2 = await openNotepad(n2);
  const out = await call("macro_notepad_type_save", { text: "REPLAYED 中文 ok" });
  log(out);
  await sleep(500);
  const written = readFileSync(f2.target, "utf8").replace(/^﻿/, "").trim();
  if (written !== "REPLAYED 中文 ok") throw new Error(`replay content mismatch: ${JSON.stringify(written)}`);
  log("PASS: macro replay wrote the file correctly");
  await closeTab(n2);

  log(await call("delete_macro", { name: "notepad_type_save" }));
} finally {
  for (const f of [f1, f2]) if (f) {
    const name = path.basename(f.target);
    const open = (await windows()).find((l) => /\[notepad\.exe\]/i.test(l) && l.includes(name));
    if (open) { try { await call("focus_window", { hwnd: hwndOf(open) }); await sleep(300); await closeTab(name); const still = (await windows()).find((l) => l.includes(name)); if (still) await call("key", { keys: "alt+n" }); } catch { /* ignore */ } }
    try { unlinkSync(f.target); } catch { /* ignore */ }
  }
  try { await call("delete_macro", { name: "notepad_type_save" }); } catch { /* already gone */ }
  if (before) { try { await call("focus_window", { hwnd: hwndOf(before) }); } catch { /* ignore */ } }
  await client.close();
}
