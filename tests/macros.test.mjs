// 宏的纯逻辑测试：参数替换、校验、存储。不碰系统。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MacroStore, substitute, validateMacro, formatMacro } from "../dist/macros.js";

test("substitute replaces {{param}} in nested args and keeps types for whole placeholders", () => {
  const out = substitute({ text: "Hi {{who}}, {{n}} items", ref: "{{ref}}", nested: { keys: "{{keys}}" }, list: ["{{who}}"] }, { who: "Amy", n: 3, ref: 42, keys: "ctrl+s" });
  assert.deepEqual(out, { text: "Hi Amy, 3 items", ref: 42, nested: { keys: "ctrl+s" }, list: ["Amy"] });
  assert.equal(substitute("{{missing}} stays", {}), "{{missing}} stays");
});

test("validateMacro rejects bad names, empty steps, undeclared params and recursive macros", () => {
  const ok = { name: "notepad_hello", description: "", params: [{ name: "msg" }], steps: [{ tool: "type", args: { text: "{{msg}}" } }], created: "" };
  assert.doesNotThrow(() => validateMacro(ok));
  assert.throws(() => validateMacro({ ...ok, name: "Bad Name" }), /macro name/);
  assert.throws(() => validateMacro({ ...ok, steps: [] }), /at least one step/);
  assert.throws(() => validateMacro({ ...ok, params: [] }), /no such param/);
  assert.throws(() => validateMacro({ ...ok, steps: [{ tool: "macro_other", args: {} }] }), /cannot call/);
  assert.throws(() => validateMacro({ ...ok, steps: [{ tool: "run_macro", args: {} }] }), /cannot call/);
});

test("MacroStore round-trip", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deskdock-macros-"));
  const store = new MacroStore(dir);
  assert.deepEqual(store.list(), []);
  const m = { name: "demo", description: "d", params: [], steps: [{ tool: "key", args: { keys: "ctrl+s" }, target: undefined }], created: new Date().toISOString() };
  store.save(m);
  assert.equal(store.list().length, 1);
  assert.equal(store.get("demo")?.steps[0].tool, "key");
  assert.equal(store.get("../etc"), undefined, "names outside the pattern never touch the disk");
  assert.match(formatMacro(m), /macro_demo/);
  assert.equal(store.delete("demo"), true);
  assert.equal(store.delete("demo"), false);
  rmSync(dir, { recursive: true, force: true });
});
