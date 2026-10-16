// 权限表纯逻辑测试：不碰系统，不碰键鼠。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PolicyStore, decide, DEFAULT_POLICY } from "../dist/policy.js";

test("default levels by process name and title", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deskdock-policy-"));
  const file = path.join(dir, "policy.json");
  const store = new PolicyStore(file);
  store.ensureFile();
  assert.equal(store.levelFor("msedge.exe", "anything"), "read");
  assert.equal(store.levelFor("MSEDGE.EXE", "anything"), "read", "case-insensitive process match");
  assert.equal(store.levelFor("WindowsTerminal.exe", ""), "click");
  assert.equal(store.levelFor("notepad.exe", "Untitled"), "ask", "apps without a rule ask before acting");
  assert.equal(store.levelFor("1password.exe", ""), "block");
  assert.equal(store.levelFor("someapp.exe", "我的网上银行 - 登录"), "block", "title rule");
  assert.equal(store.levelFor("notepad.exe", "policy.json - Notepad"), "read", "the model cannot edit its own permission table");
  assert.equal(store.levelFor("chrome.exe", "DeskDock"), "read", "nor use the control panel through a browser");
  assert.equal(store.levelFor("firefox.exe", "DeskDock"), "read");
  assert.equal(store.levelFor("chrome.exe", "招商银行 - 个人网银 - Google Chrome"), "block", "online banking inside a browser is blocked by title");
  assert.equal(store.levelFor("chrome.exe", "招商银行招聘 - Google Chrome"), "read", "a bank NAME alone only caps at read");
  assert.equal(store.levelFor("code.exe", "bank.ts - myproject - Visual Studio Code"), "click", "no generic bank/banking substring rule: the editor keeps its own level");
  assert.equal(store.levelFor("chrome.exe", "Banking news - Chrome"), "read");
  assert.equal(store.levelFor("explorer.exe", "Ausführen", "#32770"), "click", "the Run box is recognised by window class in any language");
  assert.equal(store.levelFor("explorer.exe", "C:\\ - Properties", "#32770"), "click");
  rmSync(dir, { recursive: true, force: true });
});

test("decide: rank of action vs level", () => {
  assert.equal(decide("full", "type", "x.exe", "").allowed, true);
  assert.equal(decide("click", "click", "x.exe", "").allowed, true);
  assert.equal(decide("click", "type", "x.exe", "").allowed, false);
  assert.equal(decide("read", "click", "x.exe", "").allowed, false);
  assert.equal(decide("read", "read", "x.exe", "").allowed, true);
  assert.equal(decide("block", "read", "x.exe", "").allowed, false);
  assert.deepEqual(decide("ask", "type", "x.exe", ""), { allowed: true, level: "ask", confirm: true });
  assert.equal(decide("ask", "read", "x.exe", "").confirm, false);
  assert.equal(decide("full", "type", "x.exe", "").confirm, false);
  const d = decide("read", "type", "msedge.exe", "Edge");
  assert.match(d.reason, /msedge\.exe/);
  assert.match(d.reason, /policy\.json/);
  assert.match(d.reason, /Tell the user/);
});

test("policy file is re-read when it changes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deskdock-policy-"));
  const file = path.join(dir, "policy.json");
  const store = new PolicyStore(file);
  store.ensureFile();
  assert.equal(store.levelFor("notepad.exe", ""), "ask", "factory default is ask");
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, JSON.stringify({ ...DEFAULT_POLICY, rules: { ...DEFAULT_POLICY.rules, "notepad.exe": "read" } }));
  assert.equal(store.levelFor("notepad.exe", ""), "read");
  writeFileSync(file, "{ not json");
  assert.equal(store.levelFor("notepad.exe", ""), "read", "keeps the last good table on a broken file, never falls back to a looser default");
  rmSync(dir, { recursive: true, force: true });
});

test("strictest matching rule wins; unknown process is capped at read; keys are lower-cased", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deskdock-policy-"));
  const file = path.join(dir, "policy.json");
  writeFileSync(file, JSON.stringify({ version: 1, default: "full", rules: { "Chrome.EXE": "read", "title:online banking": "block", "title:scratch": "full", "notepad.exe": "click" } }));
  const store = new PolicyStore(file);
  assert.equal(store.levelFor("chrome.exe", "My Online Banking - Chrome"), "block", "title rule must still apply inside a browser");
  assert.equal(store.levelFor("chrome.exe", "news"), "read", "upper-case key in the file still matches");
  assert.equal(store.levelFor("notepad.exe", "scratch.txt"), "click", "a looser title rule cannot widen a process rule");
  writeFileSync(file, "{ broken after load");
  assert.equal(store.levelFor("notepad.exe", ""), "click", "the last good table stays in use");
  assert.match(store.problem, /new rules are NOT applied/);
  assert.equal(store.levelFor("", "Some system window"), "read", "no process name: never more than read");
  assert.equal(store.levelFor("", "online banking"), "block");
  assert.equal(store.levelFor("other.exe", "anything"), "full");
  rmSync(dir, { recursive: true, force: true });
});

test("unknown levels fail closed; title= matches the exact title only", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deskdock-policy-"));
  const file = path.join(dir, "policy.json");
  writeFileSync(file, JSON.stringify({ version: 1, default: "ful", rules: { "bank.exe": "blcok", "title=运行": "click" } }));
  const store = new PolicyStore(file);
  assert.equal(store.levelFor("bank.exe", ""), "block", "a typo in a level must not loosen it");
  assert.equal(store.levelFor("other.exe", ""), "read", "a typo in default must not mean full");
  assert.equal(store.levelFor("explorer.exe", "运行"), "click");
  assert.equal(store.levelFor("notepad.exe", "运行说明.txt - Notepad"), "read", "title= is exact, so other titles containing the word are untouched (default here is read)");
  rmSync(dir, { recursive: true, force: true });
});

test("a policy file that is broken from the start fails closed (read), not open (full)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deskdock-policy-"));
  const file = path.join(dir, "policy.json");
  writeFileSync(file, "{ \"default\": \"full\", \"rules\": { \"bank.exe\": \"block\", } }"); // trailing comma
  const store = new PolicyStore(file);
  assert.equal(store.levelFor("random.exe", ""), "read");
  assert.equal(store.levelFor("1password.exe", ""), "block", "built-in sensitive defaults still apply");
  assert.match(store.problem, /could not be parsed/);
  writeFileSync(file, JSON.stringify({ version: 1, default: "full", rules: {} }));
  assert.equal(store.levelFor("random.exe", ""), "full", "recovers once the file is valid");
  assert.equal(store.problem, undefined);
  rmSync(dir, { recursive: true, force: true });
});
