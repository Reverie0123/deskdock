// 端到端：打开 Windows 设置的「颜色」页，把「选择模式」切到深色再切回原值，验证控件树对 WinUI 应用的读取和两步下拉操作。
// 会真实注入键鼠并短暂改变你的主题（最后恢复）。运行：node tests/e2e/settings-theme.e2e.mjs
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwndOf = (line) => Number(/hwnd=(\d+)/.exec(line)[1]);
const refOf = (line) => Number(/\[(\d+)\]/.exec(line)[1]);

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
const isSettings = (l) => /\[SystemSettings\.exe\]/i.test(l) || (/\[ApplicationFrameHost\.exe\]/i.test(l) && /"(设置|Settings)"/.test(l));
const assertSettingsFront = async () => { const fg = await foregroundLine(); if (!isSettings(fg)) throw new Error("refusing to send input: foreground is " + fg.slice(0, 100)); };

const before = await foregroundLine();
const settingsWasOpen = (await windows()).some(isSettings);
log("foreground before:", before.slice(0, 80), "| settings already open:", settingsWasOpen);

const findModeCombo = (tree) => tree.split("\n").find((l) => /\]\s+combobox\b/.test(l) && /(选择模式|Choose your mode|模式)/.test(l));
const valueOf = (line) => /selected="([^"]*)"/.exec(line)?.[1] ?? /value="([^"]*)"/.exec(line)?.[1] ?? "";

async function readSettingsTree(hwnd) {
  return call("read_window", { hwnd, maxNodes: 1500, maxDepth: 30 });
}
async function selectMode(hwnd, wanted) {
  let tree = await readSettingsTree(hwnd);
  const combo = findModeCombo(tree);
  if (!combo) throw new Error("mode combobox not found; first lines:\n" + tree.split("\n").slice(0, 25).join("\n"));
  log("combo:", combo.trim().slice(0, 110));
  await assertSettingsFront();
  await call("click", { ref: refOf(combo) });
  await sleep(700);
  tree = await readSettingsTree(hwnd);
  const item = tree.split("\n").find((l) => /\]\s+listitem\b/.test(l) && l.includes(`"${wanted}"`));
  if (!item) throw new Error(`list item "${wanted}" not found after opening the combobox`);
  await assertSettingsFront();
  await call("click", { ref: refOf(item) });
  await sleep(1500);
  tree = await readSettingsTree(hwnd);
  const after = findModeCombo(tree);
  log("after:", after?.trim().slice(0, 110));
  return valueOf(after ?? "");
}

let hwnd = null;
let original = null;
try {
  spawn("cmd.exe", ["/c", "start", "", "ms-settings:personalization-colors"], { detached: true, stdio: "ignore" }).unref();
  let win;
  for (let i = 0; i < 60 && !win; i++) { await sleep(300); win = (await windows()).find((l) => isSettings(l) && !l.includes("minimized")); }
  if (!win) throw new Error("settings window did not appear");
  hwnd = hwndOf(win);
  log("settings:", win.slice(0, 90));
  log(await call("focus_window", { hwnd }));
  await sleep(1500);

  const tree = await readSettingsTree(hwnd);
  log("tree lines:", tree.split("\n").length);
  const combo = findModeCombo(tree);
  if (!combo) throw new Error("mode combobox not found; first lines:\n" + tree.split("\n").slice(0, 30).join("\n"));
  original = valueOf(combo);
  log("original mode:", original);
  if (!original) throw new Error("cannot read the current mode from the combobox; refusing to change the theme blindly: " + combo.trim());
  const target = /深色|Dark/.test(original) ? "浅色" : "深色";
  const v1 = await selectMode(hwnd, target);
  if (!v1.includes(target)) throw new Error(`expected "${target}", combobox shows "${v1}"`);
  log(`PASS step 1: switched to ${target}`);
  const v2 = await selectMode(hwnd, original);
  if (v2 !== original) throw new Error(`expected restore to "${original}", combobox shows "${v2}"`);
  log(`PASS step 2: restored to ${original}`);
} finally {
  if (hwnd && !settingsWasOpen) {
    try { log(await call("close_window", { hwnd })); } catch (e) { log("close settings:", e.message); }
  }
  if (before) { try { await call("focus_window", { hwnd: hwndOf(before) }); } catch (e) { log("restore foreground:", e.message); } }
  await client.close();
}
