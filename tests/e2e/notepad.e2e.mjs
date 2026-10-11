// 端到端：真实注入键鼠。创建一个临时 txt，用记事本打开它，输入一段文字，Ctrl+S 保存，校验文件内容，关闭该标签，恢复原前台窗口。
// 你在用电脑的时候不要跑。运行：node tests/e2e/notepad.e2e.mjs
//
// 安全规则（2026-10-11 事故后定的）：只操作本脚本自己创建的文件；每次输入前核对前台进程和窗口标题；
// 绝不对不是自己打开的文档按保存。Windows 11 记事本是多标签的，直接启动 notepad.exe 会恢复用户上次的标签。
import path from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwndOf = (line) => Number(/hwnd=(\d+)/.exec(line)[1]);

const client = new Client({ name: "deskdock-e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "pipe" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(`${name} -> ${t}`);
  return t;
};
const windows = async () => (await call("list_windows")).split("\n").filter(Boolean);
const foregroundLine = async () => (await windows()).find((l) => l.includes("(focused)")) ?? "";
/** Refuse to send input unless the foreground window is OUR notepad tab (process + our file name in the title). */
const assertOurs = async (fileName) => {
  const fg = await foregroundLine();
  const proc = /\[([^\]]+)\]/.exec(fg)?.[1] ?? "";
  if (proc.toLowerCase() !== "notepad.exe" || !fg.includes(fileName)) throw new Error(`refusing to send input: foreground is ${fg.slice(0, 100)}`);
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(process.env.LOCALAPPDATA, "Temp", "deskdock", "e2e");
mkdirSync(dir, { recursive: true });
const fileName = `deskdock-e2e-${stamp}.txt`;
const target = path.join(dir, fileName);
writeFileSync(target, "", "utf8"); // our own, empty file: saving it can never damage user data
const text = `DeskDock e2e 测试 ${stamp}\n第二行：中文、English、123`;
const before = await foregroundLine();
log("foreground before:", before.slice(0, 80));
let ourTab = null;

try {
  spawn("notepad.exe", [target], { detached: true, stdio: "ignore" }).unref();
  let win;
  for (let i = 0; i < 40 && !win; i++) { await sleep(250); win = (await windows()).find((l) => /\[notepad\.exe\]/i.test(l) && l.includes(fileName)); }
  if (!win) throw new Error("notepad window with our file did not appear");
  ourTab = hwndOf(win);
  log("notepad:", win.slice(0, 90));

  log(await call("focus_window", { hwnd: ourTab }));
  await sleep(300);
  await assertOurs(fileName);

  const tree = await call("read_window", { hwnd: ourTab });
  const editLine = tree.split("\n").find((l) => /\]\s+(document|edit)\b/.test(l));
  if (!editLine) throw new Error("no edit control found in notepad tree:\n" + tree.slice(0, 800));
  const editRef = Number(/\[(\d+)\]/.exec(editLine)[1]);
  log("edit control:", editLine.trim().slice(0, 100));
  log(await call("click", { ref: editRef }));
  await sleep(150);

  await assertOurs(fileName);
  log(await call("type", { text }));
  await sleep(300);
  const after = await call("read_window", { hwnd: ourTab });
  const afterEdit = after.split("\n").find((l) => /\]\s+(document|edit)\b/.test(l)) ?? "";
  log("edit value after typing:", afterEdit.includes("DeskDock e2e") ? "contains typed text" : "not visible in tree: " + afterEdit.slice(0, 120));

  await assertOurs(fileName);
  log(await call("key", { keys: "ctrl+s" }));
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await sleep(250); ok = readFileSync(target, "utf8").length > 0; }
  if (!ok) throw new Error("file was not written: " + target);
  await sleep(300);
  const written = readFileSync(target, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (written !== text) throw new Error(`content mismatch:\n--- expected\n${text}\n--- got\n${written}`);
  log("PASS: file content matches:", target);
} finally {
  if (ourTab) {
    try {
      await call("focus_window", { hwnd: ourTab }); await sleep(200); await assertOurs(fileName);
      await call("key", { keys: "ctrl+w" }); // close only our tab; other tabs stay
      await sleep(400);
      const still = (await windows()).find((l) => /\[notepad\.exe\]/i.test(l) && l.includes(fileName));
      if (still) { log("tab still open (unsaved prompt?), pressing alt+n to discard"); await call("key", { keys: "alt+n" }); }
    } catch (e) { log("close tab:", e.message); }
  }
  if (before) { try { await call("focus_window", { hwnd: hwndOf(before) }); } catch (e) { log("restore foreground:", e.message); } }
  if (process.argv.includes("--keep")) log("kept", target); else { try { unlinkSync(target); } catch { /* ignore */ } }
  await client.close();
}
