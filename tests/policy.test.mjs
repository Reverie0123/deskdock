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
  assert.equal(store.levelFor("notepad.exe", "Untitled"), "full");
  assert.equal(store.levelFor("1password.exe", ""), "block");
  assert.equal(store.levelFor("someapp.exe", "我的网上银行 - 登录"), "block", "title rule");
  rmSync(dir, { recursive: true, force: true });
});

test("decide: rank of action vs level", () => {
  assert.equal(decide("full", "type", "x.exe", "").allowed, true);
  assert.equal(decide("click", "click", "x.exe", "").allowed, true);
  assert.equal(decide("click", "type", "x.exe", "").allowed, false);
  assert.equal(decide("read", "click", "x.exe", "").allowed, false);
  assert.equal(decide("read", "read", "x.exe", "").allowed, true);
  assert.equal(decide("block", "read", "x.exe", "").allowed, false);
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
  assert.equal(store.levelFor("notepad.exe", ""), "full");
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, JSON.stringify({ ...DEFAULT_POLICY, rules: { ...DEFAULT_POLICY.rules, "notepad.exe": "read" } }));
  assert.equal(store.levelFor("notepad.exe", ""), "read");
  writeFileSync(file, "{ not json");
  assert.equal(store.levelFor("msedge.exe", ""), "read", "falls back to defaults on a broken file");
  rmSync(dir, { recursive: true, force: true });
});
