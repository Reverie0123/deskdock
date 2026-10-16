// 通过真实的 MCP 客户端连 stdio 服务，只调只读工具和会被策略拒绝的工具，不注入键鼠。
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.DESKDOCK_TEST_OUT || path.join(root, "tests", "out");

test("mcp server read-only tools", async (t) => {
  const client = new Client({ name: "deskdock-test", version: "0.0.0" });
  // keep the test from writing into the real policy / audit log / macros folders
  const home = mkdirSync(path.join(outDir, "home"), { recursive: true }) ?? path.join(outDir, "home");
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "pipe", env: { ...process.env, DESKDOCK_HOME: home } });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name).sort();
    t.diagnostic(`tools (${names.length}): ${names.join(", ")}`);
    assert.ok(names.includes("read_window") && names.includes("screenshot") && names.includes("click"));

    const info = await client.callTool({ name: "screen_info", arguments: {} });
    assert.equal(info.isError, undefined);

    const wins = await client.callTool({ name: "list_windows", arguments: {} });
    const winText = wins.content[0].text;
    t.diagnostic("list_windows:\n" + winText);
    const edgeLine = winText.split("\n").find((l) => l.includes("[msedge.exe]"));
    const hwndOf = (line) => Number(/hwnd=(\d+)/.exec(line)[1]);

    const shot = await client.callTool({ name: "screenshot", arguments: {} });
    assert.equal(shot.isError, undefined, JSON.stringify(shot.content[0]));
    const img = shot.content.find((c) => c.type === "image");
    assert.ok(img, "image content");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "screen.png"), Buffer.from(img.data, "base64"));
    t.diagnostic(`screenshot: ${shot.content[0].text}`);

    if (edgeLine) {
      const hwnd = hwndOf(edgeLine);
      const denied = await client.callTool({ name: "focus_window", arguments: { hwnd } });
      assert.equal(denied.isError, true, "browser must be read-only by default");
      t.diagnostic("policy denial: " + denied.content[0].text);
      const tree = await client.callTool({ name: "read_window", arguments: { hwnd, maxNodes: 60 } });
      assert.equal(tree.isError, undefined, tree.content[0].text);
      t.diagnostic("read_window(edge):\n" + tree.content[0].text.split("\n").slice(0, 14).join("\n"));
    }

    // prefer an ordinary opaque window: layered/transparent overlays make PrintWindow fail, which is reported, not hidden
    const notepadLine = winText.split("\n").find((l) => /\[(claude|notepad|SystemSettings|ApplicationFrameHost)\.exe\]/i.test(l) && !l.includes("minimized"));
    const anyLine = notepadLine ?? winText.split("\n").find((l) => !l.includes("minimized") && !l.includes("[msedge.exe]") && !/Overlay/.test(l));
    if (anyLine) {
      const hwnd = hwndOf(anyLine);
      const tree = await client.callTool({ name: "read_window", arguments: { hwnd, maxNodes: 80 } });
      t.diagnostic(`read_window(${anyLine.slice(0, 50)}):\n` + tree.content[0].text.split("\n").slice(0, 12).join("\n"));
      const wshot = await client.callTool({ name: "screenshot", arguments: { hwnd, maxEdge: 900 } });
      const wimg = wshot.content.find((c) => c.type === "image");
      if (wimg) writeFileSync(path.join(outDir, "window.png"), Buffer.from(wimg.data, "base64"));
    }

    // the real engine: an empty clipboard or one written by a window reads fine; one whose writer has exited is refused
    const clip = await client.callTool({ name: "clipboard_get", arguments: {} });
    const clipText = clip.content.find((c) => c.type === "text")?.text ?? "";
    if (clip.isError) assert.match(clipText, /no longer running/, clipText); else assert.ok(clipText.length > 0);
  } finally { await client.close(); }
});
