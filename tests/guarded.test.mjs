// 权限包装层的行为：整屏捕获遇到禁止级窗口要拒绝、坐标点击落在禁止级窗口要拒绝、暂停标记对所有工具生效、
// 拒绝要写进审计日志。用假的辅助进程和临时配置目录，不碰系统，不写真实日志。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = mkdtempSync(path.join(tmpdir(), "deskdock-home-"));
process.env.DESKDOCK_HOME = home; // must be set before the modules compute paths
const { createServer } = await import("../dist/index.js");
const { Helper } = await import("../dist/helper.js");
const { PolicyStore, pausedPath } = await import("../dist/policy.js");
const { Audit } = await import("../dist/audit.js");
const { MacroStore } = await import("../dist/macros.js");

const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-helper.mjs");
const policyFile = path.join(home, "policy.json");
writeFileSync(policyFile, JSON.stringify({ version: 1, default: "full", rules: { "bank.exe": "block", "msedge.exe": "read" } }));
const policy = new PolicyStore(policyFile);
const audit = new Audit(path.join(home, "logs"));
const ocrStub = { languages: [], recognizePng: async () => ({ ok: true, ms: 0, lang: "stub", angle: 0, lines: [] }), close() {} };
const helper = new Helper(process.execPath, [fake]);
const { server } = createServer({ helper, policy, audit, ocr: ocrStub, macros: new MacroStore(path.join(home, "macros")) });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "t", version: "0" });
await client.connect(clientT);
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: r.isError === true, text: r.content.find((c) => c.type === "text")?.text ?? "" }; };
const auditText = () => readdirSync(path.join(home, "logs")).map((f) => readFileSync(path.join(home, "logs", f), "utf8")).join("");

test("full-screen capture is refused while a blocked app is visible; a window capture of another app is fine", async () => {
  const full = await call("screenshot");
  assert.equal(full.err, true); assert.match(full.text, /blocked app is visible/); assert.match(full.text, /bank\.exe/);
  const ocr = await call("read_screen_text");
  assert.equal(ocr.err, true); assert.match(ocr.text, /blocked app is visible/);
  const one = await call("screenshot", { hwnd: 2 });
  assert.equal(one.err, false);
  const bank = await call("screenshot", { hwnd: 1 });
  assert.equal(bank.err, true); assert.match(bank.text, /blocked/);
  assert.match(auditText(), /"tool":"screenshot".*"outcome":"denied"/);
});

test("coordinate click resolves the window under the point and applies its level", async () => {
  const onBank = await call("click", { x: 10, y: 10 });
  assert.equal(onBank.err, true); assert.match(onBank.text, /bank\.exe/);
  const onNotepad = await call("click", { x: 300, y: 300 });
  assert.equal(onNotepad.err, false);
});

test("drag is checked at both ends; clipboard_set is checked against the foreground app; macro replay cannot read a blocked app", async () => {
  const ok = await call("drag", { x1: 300, y1: 300, x2: 400, y2: 400 });
  assert.equal(ok.err, false, ok.text);
  const intoBank = await call("drag", { x1: 300, y1: 300, x2: 10, y2: 10 });
  assert.equal(intoBank.err, true); assert.match(intoBank.text, /end in "bank\.exe"/);
  // foreground (notepad) set to read: writing the clipboard is a click-level action and must be refused
  writeFileSync(policyFile, JSON.stringify({ version: 1, default: "full", rules: { "bank.exe": "block", "notepad.exe": "read" } }));
  await new Promise((r) => setTimeout(r, 30));
  const clip = await call("clipboard_set", { text: "x" });
  assert.equal(clip.err, true); assert.match(clip.text, /notepad\.exe/);
  writeFileSync(policyFile, JSON.stringify({ version: 1, default: "full", rules: { "bank.exe": "block", "msedge.exe": "read" } }));
  await new Promise((r) => setTimeout(r, 30));
  const saved = await call("save_macro", { name: "peek_bank", description: "", steps: [{ tool: "click", args: { ref: 1 }, target: { process: "bank.exe", type: "document", name: "Text editor" } }] });
  assert.equal(saved.err, false, saved.text);
  const run = await call("macro_peek_bank", {});
  assert.equal(run.err, true); assert.match(run.text, /bank\.exe/, "resolving a target must not read a blocked window");
  await call("delete_macro", { name: "peek_bank" });
});

test("pause marker blocks every tool, including window-less ones, and is audited", async () => {
  writeFileSync(pausedPath(), "");
  try {
    for (const name of ["list_windows", "screen_info", "clipboard_get", "clipboard_set", "screenshot", "type"]) {
      const r = await call(name, name === "clipboard_set" || name === "type" ? { text: "x" } : {});
      assert.equal(r.err, true, name); assert.match(r.text, /paused/, name);
    }
  } finally { unlinkSync(pausedPath()); }
  assert.equal((await call("list_windows")).err, false);
  assert.match(auditText(), /"tool":"clipboard_get".*"outcome":"denied".*paused/);
});

test("macro with a ref step but no target is rejected; replay resolves targets through uia_find", async () => {
  const bad = await call("save_macro", { name: "bad_one", description: "", steps: [{ tool: "click", args: { ref: 3 } }] });
  assert.equal(bad.err, true); assert.match(bad.text, /needs a target/);
  // record: click by ref (fake ref_node gives it a target), then type
  assert.equal((await call("read_window")).err, false);
  assert.equal((await call("click", { ref: 1 })).err, false);
  assert.equal((await call("type", { text: "hello" })).err, false);
  const saved = await call("save_macro", { name: "note_type", description: "d", fromLast: 2, params: [{ name: "t" }], replace: { hello: "t" } });
  assert.equal(saved.err, false, saved.text); assert.match(saved.text, /macro_note_type/);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("macro_note_type"));
  const run = await call("macro_note_type", { t: "again" });
  assert.equal(run.err, false, run.text); assert.match(run.text, /finished \(2 steps\)/);
  assert.match(auditText(), /"tool":"macro_note_type"/);
  assert.match(auditText(), /"tool":"save_macro"/);
  // deleted from the panel side (file removed) -> the live tool refuses
  unlinkSync(path.join(home, "macros", "note_type.json"));
  const gone = await call("macro_note_type", { t: "x" });
  assert.equal(gone.err, true); assert.match(gone.text, /deleted/);
});

test("ask level: actions go through a confirmation; no/timeout are denied and audited", async () => {
  writeFileSync(policyFile, JSON.stringify({ version: 1, default: "full", rules: { "bank.exe": "block", "notepad.exe": "ask" } }));
  await new Promise((r) => setTimeout(r, 30));
  const ok = await call("type", { text: "fine" });
  assert.equal(ok.err, false, ok.text);
  const no = await call("type", { text: "DENY-ME please" });
  assert.equal(no.err, true); assert.match(no.text, /declined/);
  const late = await call("type", { text: "TIMEOUT-ME" });
  assert.equal(late.err, true); assert.match(late.text, /did not answer/);
  const read = await call("read_window", { hwnd: 2 });
  assert.equal(read.err, false, "reads never ask");
  assert.match(auditText(), /"tool":"type".*"outcome":"denied".*declined/);
  writeFileSync(policyFile, JSON.stringify({ version: 1, default: "full", rules: { "bank.exe": "block", "msedge.exe": "read" } }));
  await new Promise((r) => setTimeout(r, 30));
});

test("typed text is never written to the audit log in full", async () => {
  await call("type", { text: "SECRET-PASSWORD-123" });
  assert.doesNotMatch(auditText(), /SECRET-PASSWORD-123/);
  assert.match(auditText(), /19 chars/);
});

test("lone surrogates in arguments do not stall the helper", async () => {
  const t0 = Date.now();
  const r = await call("clipboard_set", { text: "broken \uD83D emoji" });
  assert.ok(Date.now() - t0 < 5000, "should not wait for the 15 s timeout");
  assert.equal(r.err, false, r.text);
});

test.after(async () => { await client.close(); helper.close(); rmSync(home, { recursive: true, force: true }); });
