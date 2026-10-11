// 辅助进程卡死后的自愈：超时 → 报错并杀掉 → 下一次调用自动重启。用假的辅助进程，不碰系统。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Helper, HelperError, wellFormed } from "../dist/helper.js";

const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-helper.mjs");

test("helper restarts after a hung call", async () => {
  const h = new Helper(process.execPath, [fake]);
  try {
    const a = await h.call("ping");
    assert.equal(a.pong, true);
    const pid1 = a.pid;

    await assert.rejects(h.call("hang", {}, 400), (e) => e instanceof HelperError && /timed out/.test(e.message));

    const b = await h.call("ping");
    assert.equal(b.pong, true);
    assert.notEqual(b.pid, pid1, "a fresh helper process should have been started");

    await assert.rejects(h.call("fail"), /simulated failure/);
    const c = await h.call("echo", { x: 1 });
    assert.deepEqual(c.echo, { x: 1 });
    assert.equal(c.pid, b.pid, "an ordinary error must not restart the helper");
  } finally { h.close(); }
});

test("calls are serialized in order", async () => {
  const h = new Helper(process.execPath, [fake]);
  try {
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => h.call("echo", { i })));
    assert.deepEqual(results.map((r) => r.echo.i), [1, 2, 3, 4, 5]);
  } finally { h.close(); }
});

test("lone surrogates are replaced before reaching the helper", async () => {
  assert.equal(wellFormed("a\uD83Db"), "a\uFFFDb");
  assert.equal(wellFormed("ok \uD83D\uDE00 emoji"), "ok \uD83D\uDE00 emoji", "a valid pair is untouched");
  assert.deepEqual(wellFormed({ t: ["\uDE00"], n: 1 }), { t: ["\uFFFD"], n: 1 });
  const h = new Helper(process.execPath, [fake]);
  try {
    const r = await h.call("echo", { text: "broken \uD83D emoji" });
    assert.equal(r.echo.text, "broken \uFFFD emoji", "the fake helper rejects lone surrogates like the real one, so this only passes if the Node side sanitized");
  } finally { h.close(); }
});
