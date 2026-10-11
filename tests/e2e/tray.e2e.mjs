// 端到端：用 DeskDock 自己的工具操作 DeskDock 的托盘图标：右键 → 暂停 → 确认 paused 标记出现 → 再右键 → 取消暂停。
// 需要托盘程序已在运行（resources/deskdock-tray.exe）。会真实注入键鼠。运行：node tests/e2e/tray.e2e.mjs
import path from "node:path";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwndOf = (line) => Number(/hwnd=(\d+)/.exec(line)[1]);
const refOf = (line) => Number(/\[(\d+)\]/.exec(line)[1]);
const paused = path.join(process.env.APPDATA, "deskdock", "paused");

const client = new Client({ name: "deskdock-e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "dist", "index.js")], stderr: "pipe" }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.find((c) => c.type === "text")?.text ?? ""; if (r.isError) throw new Error(`${name} -> ${t}`); return t; };
const windows = async () => (await call("list_windows")).split("\n").filter(Boolean);

// The taskbar is a top-level window of explorer.exe without a title in some builds; find it by class via the helper tree.
async function taskbarHwnd() {
  const lines = await windows();
  const tb = lines.find((l) => /\[explorer\.exe\]/i.test(l) && /"(任务栏|Taskbar)"/.test(l));
  if (tb) return hwndOf(tb);
  throw new Error("taskbar window not found in list_windows:\n" + lines.join("\n"));
}
async function findTrayButton(hwnd) {
  const tree = await call("read_window", { hwnd, maxNodes: 600, maxDepth: 20 });
  const btn = tree.split("\n").find((l) => /\]\s+button\b/.test(l) && /DeskDock/.test(l));
  return { tree, btn };
}
async function toggleViaMenu(wantPaused) {
  const tb = await taskbarHwnd();
  let { tree, btn } = await findTrayButton(tb);
  if (!btn) {
    // icon may be in the overflow flyout; open it unless it is already open
    let fly = (await windows()).find((l) => /\[explorer\.exe\]/i.test(l) && /(系统托盘溢出窗口|System tray overflow)/i.test(l));
    if (!fly) {
      const overflow = tree.split("\n").find((l) => /\]\s+button\b/.test(l) && /(显示隐藏的图标|Show Hidden Icons)/i.test(l));
      if (!overflow) throw new Error("DeskDock tray icon not visible and no overflow button found:\n" + tree.split("\n").slice(0, 20).join("\n"));
      await call("click", { ref: refOf(overflow) }); await sleep(800);
      fly = (await windows()).find((l) => /\[explorer\.exe\]/i.test(l) && /(系统托盘溢出窗口|System tray overflow)/i.test(l));
    }
    if (!fly) throw new Error("overflow flyout did not open");
    ({ tree, btn } = await findTrayButton(hwndOf(fly)));
    if (!btn) throw new Error("DeskDock icon not found in overflow flyout");
  }
  log("tray icon:", btn.trim().slice(0, 80));
  await call("click", { ref: refOf(btn), button: "right" }); await sleep(700);
  // the context menu is a class #32768 window owned by the tray process; it does not take the foreground
  const menu = (await windows()).find((l) => /\[deskdock-tray\.exe\]/i.test(l) && /Context menu/.test(l));
  if (!menu) throw new Error("context menu window not found after right-click:\n" + (await windows()).join("\n"));
  log("menu window:", menu.slice(0, 80));
  const mtree = await call("read_window", { hwnd: hwndOf(menu), maxNodes: 50 });
  const item = mtree.split("\n").find((l) => /\]\s+menuitem\b/.test(l) && /(暂停 DeskDock|Pause DeskDock)/.test(l));
  if (!item) throw new Error("pause menu item not found in foreground tree:\n" + mtree.slice(0, 600));
  log("menu item:", item.trim().slice(0, 80));
  await call("click", { ref: refOf(item) }); await sleep(600);
  const now = existsSync(paused);
  if (now !== wantPaused) throw new Error(`expected paused=${wantPaused}, file exists=${now}`);
  log(`PASS: paused=${now}`);
}

try {
  if (existsSync(paused)) throw new Error("already paused before the test; resume first");
  await call("key", { keys: "esc" }); await sleep(300); // dismiss any menu left open by a previous run
  await toggleViaMenu(true);
  // while paused, DeskDock refuses its own tools, so the second toggle must go through a fresh unpaused check:
  // the pause gate is per call, and the tray menu click is what un-pauses, so we cannot use DeskDock to click it.
  log("note: while paused DeskDock cannot operate the tray itself (by design); removing the marker directly to resume");
} finally {
  if (existsSync(paused)) { const { unlinkSync } = await import("node:fs"); unlinkSync(paused); log("resumed (marker removed)"); }
  await client.close();
}
