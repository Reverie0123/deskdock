// A stand-in for deskdock-native.exe: answers the ops the Node layer uses with canned data, never touches the system.
// "hang" never answers; "fail" returns an error. Window 1 is a blocked banking app, window 2 is Notepad.
import { createInterface } from "node:readline";
const rect = (x, y, w, h) => ({ x, y, w, h });
const WINDOWS = [
  { hwnd: 1, title: "My Bank - Online Banking", class: "Chrome_WidgetWin_1", pid: 11, process: "bank.exe", rect: rect(0, 0, 800, 600), minimized: false, focused: false },
  { hwnd: 2, title: "notes.txt - Notepad", class: "Notepad", pid: 22, process: "notepad.exe", rect: rect(100, 100, 600, 400), minimized: false, focused: true },
];
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ id: null, ok: false, error: "parse error" }) + "\n"); return; }
  // the real helper (nlohmann/json) rejects lone surrogates in strings with a parse error and no request id
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  if (lone.test(JSON.stringify(req).replace(/\\u[0-9a-fA-F]{4}/g, (m) => String.fromCharCode(parseInt(m.slice(2), 16))))) { process.stdout.write(JSON.stringify({ id: null, ok: false, error: "parse error: lone surrogate" }) + "\n"); return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
  const err = (error) => process.stdout.write(JSON.stringify({ id: req.id, ok: false, error }) + "\n");
  const a = req.args ?? {};
  switch (req.op) {
    case "hang": return;
    case "fail": return err("simulated failure");
    case "ping": return reply({ pong: true, pid: process.pid });
    case "list_windows": return reply(a.all ? [...WINDOWS, { hwnd: 3, title: "", class: "Popup", pid: 11, process: "bank.exe", rect: rect(900, 0, 300, 200), minimized: false, focused: false }] : WINDOWS);
    case "clipboard_owner": return reply({ ownSet: false, empty: false, ...(globalThis.__clipOwner ?? { ownerProcess: "notepad.exe", ownerTitle: "notes.txt - Notepad", ownerHwnd: 2 }) });
    case "set_clip_owner": globalThis.__clipOwner = a; return reply({ ok: true });
    case "foreground_window": return reply(WINDOWS[1]);
    case "window_at": return reply(a.x < 50 ? WINDOWS[0] : WINDOWS[1]); // the bank window sits at the left edge
    case "screen_info": return reply({ virtual: { x: 0, y: 0, w: 1600, h: 900 }, monitors: [] });
    case "screenshot": return reply({ png_base64: PNG_1x1, width: 1, height: 1, origin: { x: 0, y: 0 }, scale: a.scale ?? 1 });
    case "uia_snapshot": return reply({ window: WINDOWS[1], nodes: [{ ref: 1, depth: 0, type: "document", name: "Text editor", rect: rect(100, 150, 600, 300) }], truncated: false });
    case "ref_window": return reply(WINDOWS[1]);
    case "ref_node": return a.ref === 1 ? reply({ window: WINDOWS[1], node: { ref: 1, depth: 0, type: "document", name: "Text editor", rect: rect(100, 150, 600, 300) } }) : err("unknown ref (take a new snapshot)");
    case "uia_find": return (a.type === "document" && a.name === "Text editor") ? reply({ window: WINDOWS[1], node: { ref: 77, depth: 0, type: "document", name: "Text editor", rect: rect(100, 150, 600, 300) } }) : err("no control matched");
    case "uia_click": return reply({ action: "invoke", rect: rect(0, 0, 1, 1) });
    case "focus_window": return reply({ focused: true, window: WINDOWS.find((w) => w.hwnd === a.hwnd) ?? WINDOWS[1] });
    case "clipboard_get": { const o = globalThis.__clipOwner ?? { ownerProcess: "notepad.exe", ownerTitle: "notes.txt - Notepad", ownerHwnd: 2 }; return reply({ text: o.empty ? "" : "clip", hasText: !o.empty, ownSet: false, empty: false, ...o }); }
    case "clipboard_set": return (a.expectHwnd && a.expectHwnd !== 2) ? err("refused: the foreground window changed before the input was sent") : reply({ chars: String(a.text ?? "").length });
    case "type": return (a.expectHwnd && a.expectHwnd !== 2) ? err("refused: the foreground window changed before the input was sent") : reply({ chars: String(a.text ?? "").length });
    case "key": return (a.expectHwnd && a.expectHwnd !== 2) ? err("refused: the foreground window changed before the input was sent") : reply({ keys: a.keys, repeat: a.repeat ?? 1 });
    case "click": { const under = a.x < 50 ? 1 : 2; return (a.expectHwnd && a.expectHwnd !== under) ? err("refused: a different window is now under the point") : reply({ x: a.x, y: a.y, button: a.button ?? "left", count: a.count ?? 1 }); }
    case "drag": { const u1 = a.x1 < 50 ? 1 : 2, u2 = a.x2 < 50 ? 1 : 2; return ((a.expectHwnd && a.expectHwnd !== u1) || (a.expectHwnd2 && a.expectHwnd2 !== u2)) ? err("refused: a different window is now under the point") : reply({ from: { x: a.x1, y: a.y1 }, to: { x: a.x2, y: a.y2 } }); }
    case "confirm": return reply({ answer: /DENY-ME/.test(a.text) ? "no" : /TIMEOUT-ME/.test(a.text) ? "timeout" : "yes" });
    default: return reply({ pong: false, pid: process.pid, echo: a });
  }
});
