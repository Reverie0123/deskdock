// 只读指令测试：不注入键鼠，用户在用电脑时也能跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/deskdock-helper.exe");

function startHelper() {
  const p = spawn(exe, [], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: p.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  });
  const call = (op, args = {}, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} timed out`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); msg.ok ? resolve(msg.result) : reject(new Error(msg.error)); });
    p.stdin.write(JSON.stringify({ id, op, args }) + "\n");
  });
  return { call, close: () => p.stdin.end() };
}

test("helper read-only ops", async (t) => {
  const h = startHelper();
  try {
    const pong = await h.call("ping");
    assert.equal(pong.pong, true);

    const wins = await h.call("list_windows");
    assert.ok(Array.isArray(wins) && wins.length > 0, "at least one window");
    for (const w of wins) { assert.equal(typeof w.hwnd, "number"); assert.equal(typeof w.title, "string"); assert.ok(w.rect); }
    t.diagnostic(`windows: ${wins.map((w) => `${w.process}:${w.title.slice(0, 30)}`).join(" | ")}`);

    const info = await h.call("screen_info");
    assert.ok(info.monitors.length >= 1);
    t.diagnostic(`monitors: ${JSON.stringify(info.monitors.map((m) => [m.name, m.rect.w, m.rect.h, m.scale]))}`);

    const pos = await h.call("cursor_pos");
    assert.equal(typeof pos.x, "number");

    const shot = await h.call("screenshot", { scale: 0.25 });
    assert.ok(shot.png_base64.startsWith("iVBOR"), "PNG magic");
    assert.ok(shot.width > 0 && shot.height > 0);
    t.diagnostic(`screenshot ${shot.width}x${shot.height}, ${Math.round(shot.png_base64.length * 0.75 / 1024)} KB`);

    const target = wins.find((w) => !w.minimized && w.process.toLowerCase() !== "explorer.exe") ?? wins[0];
    const wshot = await h.call("screenshot", { hwnd: target.hwnd, scale: 0.5 });
    assert.ok(wshot.png_base64.startsWith("iVBOR"));
    t.diagnostic(`window screenshot of "${target.title.slice(0, 30)}": ${wshot.width}x${wshot.height}`);

    const snap = await h.call("uia_snapshot", { hwnd: target.hwnd, maxNodes: 80, interactiveOnly: true });
    assert.ok(Array.isArray(snap.nodes));
    t.diagnostic(`uia nodes for "${target.title.slice(0, 30)}": ${snap.nodes.length}, truncated=${snap.truncated}`);
    t.diagnostic(snap.nodes.slice(0, 8).map((n) => `[${n.ref}] ${n.type} "${n.name.slice(0, 25)}"`).join(" ; "));

    const clip = await h.call("clipboard_get");
    assert.equal(typeof clip.hasText, "boolean");

    await assert.rejects(h.call("nope"), /unknown op/);
    await assert.rejects(h.call("screenshot", { hwnd: 12345 }), /no longer exists/);
  } finally { h.close(); }
});
