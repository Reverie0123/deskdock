// A stand-in for deskdock-helper.exe: answers the ops the Node layer uses with canned data, never touches the system.
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
  const reply = (result) => process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
  const err = (error) => process.stdout.write(JSON.stringify({ id: req.id, ok: false, error }) + "\n");
  const a = req.args ?? {};
  switch (req.op) {
    case "hang": return;
    case "fail": return err("simulated failure");
    case "ping": return reply({ pong: true, pid: process.pid });
    case "list_windows": return reply(WINDOWS);
    case "foreground_window": return reply(WINDOWS[1]);
    case "window_at": return reply(a.x < 50 ? WINDOWS[0] : WINDOWS[1]); // the bank window sits at the left edge
    case "screen_info": return reply({ virtual: { x: 0, y: 0, w: 1600, h: 900 }, monitors: [] });
    case "screenshot": return reply({ png_base64: PNG_1x1, width: 1, height: 1, origin: { x: 0, y: 0 }, scale: a.scale ?? 1 });
    case "uia_snapshot": return reply({ window: WINDOWS[1], nodes: [{ ref: 1, depth: 0, type: "document", name: "Text editor", rect: rect(100, 150, 600, 300) }], truncated: false });
    case "ref_window": return reply(WINDOWS[1]);
    case "ref_node": return reply({ window: WINDOWS[1], node: { ref: a.ref, depth: 0, type: "document", name: "Text editor", rect: rect(100, 150, 600, 300) } });
    case "uia_find": return reply({ window: WINDOWS[1], node: { ref: 77, depth: 0, type: a.type || "document", name: a.name || "Text editor", rect: rect(100, 150, 600, 300) } });
    case "uia_click": return reply({ action: "invoke", rect: rect(0, 0, 1, 1) });
    case "focus_window": return reply({ focused: true, window: WINDOWS.find((w) => w.hwnd === a.hwnd) ?? WINDOWS[1] });
    case "clipboard_get": return reply({ text: "clip", hasText: true });
    default: return reply({ pong: false, pid: process.pid, echo: a });
  }
});
