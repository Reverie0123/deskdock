// OCR 工作进程测试：识别已有截图，不碰键鼠。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ocr } from "../dist/ocr.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("windows ocr worker", async (t) => {
  const ocr = new Ocr();
  try {
    const t0 = Date.now();
    const r1 = await ocr.recognizeFile(path.join(root, "tests", "out", "window.png"));
    t.diagnostic(`first call (includes worker start): ${Date.now() - t0} ms, engine ${r1.lang}, ocr ${r1.ms} ms, lines ${r1.lines.length}, languages ${ocr.languages.join(",")}`);
    assert.ok(r1.lines.length > 5, "should read text from the window screenshot");
    t.diagnostic(r1.lines.slice(0, 6).map((l) => `  (${l.x},${l.y} ${l.w}x${l.h}) ${l.text}`).join("\n"));
    const t1 = Date.now();
    const r2 = await ocr.recognizeFile(path.join(root, "tests", "out", "screen.png"));
    t.diagnostic(`second call: ${Date.now() - t1} ms total, ocr ${r2.ms} ms, lines ${r2.lines.length}`);
    assert.ok(r2.lines.length > 5);
    await assert.rejects(ocr.recognizeFile(path.join(root, "tests", "out", "missing.png")));
  } finally { ocr.close(); }
});
