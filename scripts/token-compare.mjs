// 对比同一个窗口「读控件树」和「截图」各要吃多少模型 token。只读，不碰键鼠。
// 运行：node scripts/token-compare.mjs  → 写 docs/token-compare.md
import path from "node:path";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const client = new Client({ name: "token-compare", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "pipe" }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return r; };
const textOf = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

// rough but consistent: CJK chars ~1 token each, everything else ~4 chars per token
const textTokens = (s) => { const cjk = (s.match(/[㐀-鿿豈-﫿　-〿＀-￯]/g) ?? []).length; return cjk + Math.ceil((s.length - cjk) / 4); };
// Claude image tokens ≈ width * height / 750
const imageTokens = (w, h) => Math.ceil((w * h) / 750);

const wins = textOf(await call("list_windows")).split("\n").filter((l) => l && !l.includes("minimized"));
const rows = [];
for (const line of wins) {
  const hwnd = Number(/hwnd=(\d+)/.exec(line)[1]);
  const title = /"([^"]*)"/.exec(line)?.[1] ?? "";
  const proc = /\[([^\]]+)\]/.exec(line)?.[1] ?? "";
  const tree = await call("read_window", { hwnd });
  const treeText = textOf(tree);
  const nodes = Number(/Nodes: (\d+)/.exec(treeText)?.[1] ?? 0);
  const shot = await call("screenshot", { hwnd });
  const dims = /^(\d+)x(\d+) png/.exec(textOf(shot));
  const w = dims ? Number(dims[1]) : 0, h = dims ? Number(dims[2]) : 0;
  const t0 = Date.now();
  const ocr = await call("read_screen_text", { hwnd });
  const ocrMs = Date.now() - t0;
  const ocrText = textOf(ocr);
  rows.push({ proc, title: title.slice(0, 40), nodes, treeTok: tree.isError ? NaN : textTokens(treeText), imgTok: imageTokens(w, h), dims: `${w}x${h}`, ocrTok: ocr.isError ? NaN : textTokens(ocrText), ocrLines: Number(/Lines: (\d+)/.exec(ocrText)?.[1] ?? 0), ocrMs });
}
await client.close();

const now = new Date().toISOString().slice(0, 16).replace("T", " ");
const lines = [
  `# read_window vs screenshot: token cost (${now})`,
  "",
  "Measured on this machine (2560×1600 at 150 %). Text tokens: CJK ≈ 1 per char, other ≈ 4 chars per token. Image tokens ≈ width × height / 750 (Claude). screenshot is capped to a 1280 px long edge; read_window uses the default budget of 400 nodes.",
  "",
  "| App | Window | UI nodes | read_window tokens | screenshot | screenshot tokens | OCR lines | OCR tokens | OCR ms |",
  "|---|---|---:|---:|---|---:|---:|---:|---:|",
  ...rows.map((r) => `| ${r.proc} | ${r.title} | ${r.nodes} | ${isNaN(r.treeTok) ? "denied" : r.treeTok} | ${r.dims} | ${r.imgTok} | ${r.ocrLines} | ${isNaN(r.ocrTok) ? "denied" : r.ocrTok} | ${r.ocrMs} |`),
  "",
  "Notes: a window whose UI tree is empty (3 title-bar buttons) shows a tiny read_window cost but no usable content; that is where OCR or screenshot is needed. The screenshot figure is per call; a multi-step task takes one per step.",
];
writeFileSync(path.join(root, "docs", "token-compare.md"), lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
