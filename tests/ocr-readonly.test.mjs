// OCR 工作进程测试：自己截一张整屏图再识别，不碰键鼠，不依赖别的测试留下的文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ocr } from "../dist/ocr.js";
import { Helper } from "../dist/helper.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("windows ocr worker", async (t) => {
  const helper = new Helper();
  const ocr = new Ocr();
  try {
    const shot = await helper.call("screenshot", { scale: 0.75 });
    const dir = path.join(root, "tests", "out"); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ocr-input.png");
    writeFileSync(file, Buffer.from(shot.png_base64, "base64"));

    const t0 = Date.now();
    const r1 = await ocr.recognizeFile(file);
    t.diagnostic(`first call (includes worker start): ${Date.now() - t0} ms, engine ${r1.lang}, ocr ${r1.ms} ms, lines ${r1.lines.length}, languages ${ocr.languages.join(",")}`);
    assert.ok(r1.lines.length > 5, `should read text from a ${shot.width}x${shot.height} screenshot of the desktop`);
    t.diagnostic(r1.lines.slice(0, 5).map((l) => `  (${l.x},${l.y} ${l.w}x${l.h}) ${l.text}`).join("\n"));

    const t1 = Date.now();
    const r2 = await ocr.recognizeFile(file);
    t.diagnostic(`second call: ${Date.now() - t1} ms total, ocr ${r2.ms} ms`);
    assert.ok(Math.abs(r2.lines.length - r1.lines.length) <= 2, "same image, same result");

    await assert.rejects(ocr.recognizeFile(path.join(dir, "missing.png")));
  } finally { ocr.close(); helper.close(); }
});
