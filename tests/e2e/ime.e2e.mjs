// 端到端：在记事本里把中文输入法打开，然后用 type 输入英文和中文，验证输入不被输入法截走，且结束后输入法状态恢复。
// 真实注入键鼠。运行：node tests/e2e/ime.e2e.mjs
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p = spawn(path.join(process.cwd(), "resources", "deskdock-helper.exe"), [], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: p.stdout }); const q = new Map(); let id = 1;
rl.on("line", (l) => { const m = JSON.parse(l); const cb = q.get(m.id); q.delete(m.id); cb(m); });
const call = (op, args = {}) => new Promise((res, rej) => { const i = id++; q.set(i, (m) => (m.ok ? res(m.result) : rej(new Error(m.error)))); p.stdin.write(JSON.stringify({ id: i, op, args }) + "\n"); });

const dir = path.join(process.env.LOCALAPPDATA, "Temp", "deskdock", "e2e"); mkdirSync(dir, { recursive: true });
const file = path.join(dir, `ime-${Date.now()}.txt`); writeFileSync(file, "", "utf8");
let before = null; for (let i = 0; i < 5 && !before; i++) { try { before = (await call("foreground_window")).hwnd; } catch { await sleep(300); } }
let win = null;
try {
  spawn("notepad.exe", [file], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 40 && !win; i++) { await sleep(250); win = (await call("list_windows")).find((w) => /notepad\.exe/i.test(w.process) && w.title.includes(path.basename(file))); }
  if (!win) throw new Error("notepad did not open");
  await call("focus_window", { hwnd: win.hwnd }); await sleep(400);
  const fg = await call("foreground_window"); if (fg.hwnd !== win.hwnd) throw new Error("focus failed");
  const snap = await call("uia_snapshot", { hwnd: win.hwnd, interactiveOnly: true });
  const edit = snap.nodes.find((n) => n.type === "document" || n.type === "edit");
  await call("uia_click", { ref: edit.ref }); await sleep(200);

  const s0 = await call("ime_status", { hwnd: win.hwnd });
  log("ime before:", s0);
  await call("ime_status", { hwnd: win.hwnd, open: true }); await sleep(200);
  const s1 = await call("ime_status", { hwnd: win.hwnd });
  log("ime forced open:", s1);
  if (!s1.open) log("note: could not open the IME on this window (no CJK IME active?); the test still checks typing");

  const text = "hello 你好 world 123";
  const r = await call("type", { text }); await sleep(400);
  log("type result:", r);
  await call("key", { keys: "ctrl+s" }); await sleep(500);
  const written = readFileSync(file, "utf8").replace(/^﻿/, "").trim();
  log("written:", JSON.stringify(written));
  const s2 = await call("ime_status", { hwnd: win.hwnd });
  log("ime after:", s2);
  if (written !== text) throw new Error("IME interfered: expected " + JSON.stringify(text));
  if (s1.open && !s2.open) throw new Error("IME state was not restored");
  log("PASS");
} finally {
  if (win) { try { await call("focus_window", { hwnd: win.hwnd }); await sleep(200); await call("ime_status", { hwnd: win.hwnd, open: false }); await call("key", { keys: "ctrl+w" }); await sleep(400); } catch (e) { log("close:", e.message); } }
  try { await call("focus_window", { hwnd: before }); } catch { /* ignore */ }
  try { unlinkSync(file); } catch { /* ignore */ }
  p.stdin.end();
}
