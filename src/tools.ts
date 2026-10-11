// Tool definitions exposed to the MCP client. Every tool: check policy -> call helper -> audit.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Helper, HelperError, type Screenshot, type Snapshot, type UiaNode, type WindowInfo } from "./helper.js";
import { decide, isPaused, PolicyStore, type Action } from "./policy.js";
import { Audit, redactArgs } from "./audit.js";
import { Ocr, toScreen, formatOcr } from "./ocr.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): Result => ({ content: [{ type: "text", text: t }], isError: true });

export interface Deps { helper: Helper; policy: PolicyStore; audit: Audit; ocr: Ocr }

export function formatWindow(w: WindowInfo): string {
  const flags = [w.focused ? "focused" : "", w.minimized ? "minimized" : ""].filter(Boolean).join(", ");
  return `hwnd=${w.hwnd} "${w.title}" [${w.process}] at (${w.rect.x},${w.rect.y}) ${w.rect.w}x${w.rect.h}${flags ? ` (${flags})` : ""}`;
}

export function formatSnapshot(s: Snapshot, includeOffscreen = false): string {
  const shown = includeOffscreen ? s.nodes : s.nodes.filter((n) => !n.offscreen);
  const hidden = s.nodes.length - shown.length;
  const lines = [
    `Window: ${formatWindow(s.window)}`,
    `Nodes: ${shown.length}${hidden ? ` (+${hidden} off-screen hidden; scroll to reach them or pass includeOffscreen=true)` : ""}${s.truncated ? " (truncated; pass a larger maxNodes or interactiveOnly=true)" : ""}. Format: [ref] type "name" value=... @centerX,centerY (screen px; indent = depth)`,
  ];
  for (const n of shown) lines.push(formatNode(n));
  if (s.nodes.length <= 3) lines.push("Few nodes: this app has not exposed its UI tree yet. Electron apps usually open it a little after the first read_window: retry in a few seconds, or use read_screen_text (OCR) or screenshot + click by coordinates now.");
  return lines.join("\n");
}
function formatNode(n: UiaNode): string {
  const parts = [`[${n.ref}]`, n.type];
  if (n.name) parts.push(JSON.stringify(n.name));
  if (n.value !== undefined) parts.push(`value=${JSON.stringify(n.value.length > 120 ? n.value.slice(0, 120) + "..." : n.value)}`);
  if (n.selected !== undefined) parts.push(`selected=${JSON.stringify(n.selected)}`);
  if (n.checked) parts.push(`checked=${n.checked}`);
  if (n.enabled === false) parts.push("disabled");
  if (n.offscreen) parts.push("offscreen");
  // centre point only: that is what click needs, and it halves the token cost of a big tree
  parts.push(`@${n.rect.x + Math.round(n.rect.w / 2)},${n.rect.y + Math.round(n.rect.h / 2)}`);
  return " ".repeat(Math.min(n.depth, 12)) + parts.join(" ");
}

export function registerTools(server: McpServer, deps: Deps): void {
  const { helper, policy, audit, ocr } = deps;

  async function targetAt(x: number, y: number): Promise<WindowInfo> { return helper.call<WindowInfo>("window_at", { x, y }); }
  async function foreground(): Promise<WindowInfo> { return helper.call<WindowInfo>("foreground_window"); }
  async function byRef(ref: number): Promise<WindowInfo> { return helper.call<WindowInfo>("ref_window", { ref }); }
  async function byHwnd(hwnd: number): Promise<WindowInfo> {
    const wins = await helper.call<WindowInfo[]>("list_windows");
    const w = wins.find((v) => v.hwnd === hwnd);
    if (!w) throw new HelperError(`window hwnd=${hwnd} not found; call list_windows again`);
    return w;
  }

  async function capture(hwnd: number | undefined, maxEdge: number): Promise<Screenshot> {
    let scale = 1;
    if (hwnd) {
      const w = await byHwnd(hwnd); scale = Math.min(1, maxEdge / Math.max(w.rect.w, w.rect.h));
    } else {
      const info = await helper.call<{ virtual: { w: number; h: number } }>("screen_info");
      scale = Math.min(1, maxEdge / Math.max(info.virtual.w, info.virtual.h));
    }
    return helper.call<Screenshot>("screenshot", { hwnd: hwnd ?? null, scale });
  }

  /** Wraps a tool body with policy check + audit log. `target` resolves which window the action touches. */
  function guarded<A extends Record<string, unknown>>(
    tool: string, action: Action,
    target: (args: A) => Promise<WindowInfo | undefined>,
    body: (args: A, win: WindowInfo | undefined) => Promise<Result>,
  ) {
    return async (args: A): Promise<Result> => {
      const t0 = Date.now();
      let win: WindowInfo | undefined;
      try {
        if (isPaused()) {
          const reason = "DeskDock is paused: the user paused it from the tray icon. Do not retry; tell the user and ask them to resume DeskDock (tray icon -> Pause) when they want you to continue.";
          audit.write({ ts: new Date().toISOString(), tool, args: redactArgs(tool, args), outcome: "denied", detail: reason, ms: Date.now() - t0 });
          return fail(reason);
        }
        win = await target(args);
        if (win) {
          const d = decide(policy.levelFor(win.process, win.title), action, win.process, win.title);
          if (!d.allowed) {
            audit.write({ ts: new Date().toISOString(), tool, args: redactArgs(tool, args), target: { process: win.process, title: win.title, hwnd: win.hwnd }, outcome: "denied", detail: d.reason, ms: Date.now() - t0 });
            return fail(d.reason!);
          }
        }
        const r = await body(args, win);
        audit.write({ ts: new Date().toISOString(), tool, args: redactArgs(tool, args), target: win && { process: win.process, title: win.title, hwnd: win.hwnd }, outcome: "ok", ms: Date.now() - t0 });
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        audit.write({ ts: new Date().toISOString(), tool, args: redactArgs(tool, args), target: win && { process: win.process, title: win.title, hwnd: win.hwnd }, outcome: "error", detail: msg, ms: Date.now() - t0 });
        return fail(`${tool} failed: ${msg}`);
      }
    };
  }

  server.registerTool("screen_info", {
    title: "Screen info",
    description: "Monitors, their positions, sizes and DPI scale, and the virtual-screen bounds. All DeskDock coordinates are physical pixels in this space. 显示器布局与缩放比例。",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => text(JSON.stringify(await helper.call("screen_info"), null, 1)));

  server.registerTool("list_windows", {
    title: "List windows",
    description: "List visible top-level windows with hwnd, title, process name, position and size. Call this first to find what to act on. 列出所有可见窗口。",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const wins = await helper.call<WindowInfo[]>("list_windows");
    return text(wins.map((w) => `${formatWindow(w)} policy=${policy.levelFor(w.process, w.title)}`).join("\n") || "No visible windows.");
  });

  server.registerTool("focus_window", {
    title: "Focus window",
    description: "Bring a window to the front (restores it if minimized). Use the hwnd from list_windows. 把窗口切到前台。",
    inputSchema: { hwnd: z.number().int().describe("Window handle from list_windows") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded("focus_window", "click", (a) => byHwnd(a.hwnd), async (a) => {
    const r = await helper.call<{ focused: boolean; window: WindowInfo }>("focus_window", { hwnd: a.hwnd });
    return text(`${r.focused ? "Focused" : "Could not take focus (an elevated window may be in front)"}: ${formatWindow(r.window)}`);
  }));

  server.registerTool("close_window", {
    title: "Close window",
    description: "Ask a window to close (same as clicking its X). The app may show its own save prompt; read_window to handle it. Prefer this over alt+f4, which global hotkey tools can swallow. 关闭窗口。",
    inputSchema: { hwnd: z.number().int().describe("Window handle from list_windows") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded("close_window", "click", (a) => byHwnd(a.hwnd), async (a) => {
    const r = await helper.call<{ window: WindowInfo; closed: boolean }>("close_window", { hwnd: a.hwnd });
    return text(`${r.closed ? "Closed" : "Close requested (window still open, it may be asking to save)"}: ${formatWindow(r.window)}`);
  }));

  server.registerTool("screenshot", {
    title: "Screenshot",
    description: "PNG screenshot of the whole virtual screen, or of one window (hwnd) even if partly covered. Downscaled so the long edge is at most maxEdge px; coordinates in the image are image_pixel / scale + origin. Prefer read_window when the app exposes a UI tree; it is cheaper and gives exact click targets. 截图。",
    inputSchema: {
      hwnd: z.number().int().optional().describe("Window to capture; omit for the full screen"),
      maxEdge: z.number().int().min(200).max(4000).optional().describe("Max long-edge size in px (default 1280)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded("screenshot", "read", async (a) => a.hwnd ? byHwnd(a.hwnd) : undefined, async (a) => {
    const s = await capture(a.hwnd, a.maxEdge ?? 1280);
    return {
      content: [
        { type: "text", text: `${s.width}x${s.height} png, scale=${s.scale.toFixed(3)}, origin=(${s.origin.x},${s.origin.y}). Screen coordinate = image_pixel / ${s.scale.toFixed(3)} + origin.` },
        { type: "image", data: s.png_base64, mimeType: "image/png" },
      ],
    };
  }));

  server.registerTool("read_window", {
    title: "Read window",
    description: "Read a window's UI tree as text: one control per line with a [ref] number, type, name, value and screen rect. Then use click(ref=...), set_value(ref=...) or focus_element(ref=...). Refs are valid until the next read_window. Works for most native, WinUI, Office and Chromium apps; Electron apps and games may expose little, then use screenshot. 把窗口读成控件文本。",
    inputSchema: {
      hwnd: z.number().int().optional().describe("Window to read; omit for the foreground window"),
      interactiveOnly: z.boolean().optional().describe("Only buttons, inputs, links, list items and text (default true)"),
      maxNodes: z.number().int().min(10).max(3000).optional().describe("Node budget (default 400)"),
      maxDepth: z.number().int().min(1).max(40).optional().describe("Tree depth limit (default 14)"),
      includeOffscreen: z.boolean().optional().describe("Also list controls scrolled out of view (default false; they cannot be clicked until scrolled into view)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded("read_window", "read", async (a) => a.hwnd ? byHwnd(a.hwnd) : foreground(), async (a) => {
    const s = await helper.call<Snapshot>("uia_snapshot", { hwnd: a.hwnd ?? null, interactiveOnly: a.interactiveOnly ?? true, maxNodes: a.maxNodes ?? 400, maxDepth: a.maxDepth ?? 14 }, 8000);
    return text(formatSnapshot(s, a.includeOffscreen ?? false));
  }));

  server.registerTool("read_screen_text", {
    title: "Read screen text (OCR)",
    description: "Fallback for apps whose UI tree is empty (Electron apps with accessibility off, games, custom-drawn UIs): screenshot the screen or one window and run the built-in Windows OCR. Returns each text line with its screen rect and center, so you can click(x, y) on a label. Slower and less exact than read_window; use read_window first. 读不到控件树时用 OCR 把屏幕文字和坐标读出来。",
    inputSchema: {
      hwnd: z.number().int().optional().describe("Window to read; omit for the full screen"),
      maxEdge: z.number().int().min(400).max(4000).optional().describe("Capture resolution cap, long edge in px (default 4000 = native resolution; lower only to speed up)"),
      lang: z.string().optional().describe("OCR language tag such as zh-Hans-CN or en-US; default is the system profile language"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guarded("read_screen_text", "read", async (a) => a.hwnd ? byHwnd(a.hwnd) : undefined, async (a, win) => {
    const s = await capture(a.hwnd, a.maxEdge ?? 4000);
    const r = await ocr.recognizePng(Buffer.from(s.png_base64, "base64"), a.lang);
    const lines = toScreen(r.lines, s.scale, s.origin);
    const header = `${win ? formatWindow(win) : "Full screen"}; OCR ${r.lang} in ${r.ms} ms; coordinates are screen pixels.`;
    return text(formatOcr(lines, header));
  }));

  server.registerTool("click", {
    title: "Click",
    description: "Click a control by ref (from read_window) or a point by screen coordinates. button: left|right|middle; count: 1 or 2 for double-click. 点击控件或坐标。",
    inputSchema: {
      ref: z.number().int().optional().describe("Control ref from read_window"),
      x: z.number().int().optional(), y: z.number().int().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      count: z.number().int().min(1).max(3).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded("click", "click", async (a) => {
    if (a.ref !== undefined) return byRef(a.ref);
    if (a.x === undefined || a.y === undefined) throw new Error("give either ref or both x and y");
    return targetAt(a.x, a.y);
  }, async (a) => {
    if (a.ref !== undefined) {
      const r = await helper.call<{ action: string; x?: number; y?: number; rect: { x: number; y: number; w: number; h: number } }>("uia_click", { ref: a.ref, button: a.button ?? "left", count: a.count ?? 1 }, 8000);
      return text(`${r.action === "invoke" ? "Invoked" : "Clicked"} [${a.ref}]${r.x !== undefined ? ` at (${r.x},${r.y})` : ""}.`);
    }
    const r = await helper.call<{ x: number; y: number }>("click", { x: a.x, y: a.y, button: a.button ?? "left", count: a.count ?? 1 });
    return text(`Clicked (${r.x},${r.y}) ${a.button ?? "left"}${(a.count ?? 1) > 1 ? ` x${a.count}` : ""}.`);
  }));

  server.registerTool("type", {
    title: "Type text",
    description: "Type text into the focused control (Unicode, so Chinese and emoji work; \\n presses Enter). Click the input first. 输入文字。",
    inputSchema: { text: z.string().min(1).max(20000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded("type", "type", () => foreground(), async (a, win) => {
    const r = await helper.call<{ chars: number }>("type", { text: a.text });
    return text(`Typed ${r.chars} chars into ${win ? formatWindow(win) : "the foreground window"}.`);
  }));

  server.registerTool("key", {
    title: "Press keys",
    description: "Press a key or combination, e.g. \"enter\", \"ctrl+s\", \"alt+f4\", \"ctrl+shift+esc\", \"win+r\". Names: ctrl alt shift win enter tab esc space backspace delete home end pageup pagedown up down left right f1-f12, or a single character. 按键。",
    inputSchema: { keys: z.string().min(1).max(60), repeat: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded("key", "type", () => foreground(), async (a, win) => {
    await helper.call("key", { keys: a.keys, repeat: a.repeat ?? 1 });
    return text(`Pressed ${a.keys}${(a.repeat ?? 1) > 1 ? ` x${a.repeat}` : ""} in ${win ? formatWindow(win) : "the foreground window"}.`);
  }));

  server.registerTool("scroll", {
    title: "Scroll",
    description: "Scroll the wheel at a screen point. dy>0 scrolls down, dy<0 up; dx for horizontal. One unit = one notch. 滚动。",
    inputSchema: { x: z.number().int(), y: z.number().int(), dy: z.number().int().min(-50).max(50).optional(), dx: z.number().int().min(-50).max(50).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded("scroll", "click", (a) => targetAt(a.x, a.y), async (a) => {
    await helper.call("scroll", { x: a.x, y: a.y, dy: a.dy ?? 3, dx: a.dx ?? 0 });
    return text(`Scrolled at (${a.x},${a.y}) dy=${a.dy ?? 3} dx=${a.dx ?? 0}.`);
  }));

  server.registerTool("drag", {
    title: "Drag",
    description: "Press the mouse at (x1,y1), move to (x2,y2), release. 拖拽。",
    inputSchema: { x1: z.number().int(), y1: z.number().int(), x2: z.number().int(), y2: z.number().int(), button: z.enum(["left", "right", "middle"]).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded("drag", "click", (a) => targetAt(a.x1, a.y1), async (a) => {
    await helper.call("drag", { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, button: a.button ?? "left" });
    return text(`Dragged (${a.x1},${a.y1}) -> (${a.x2},${a.y2}).`);
  }));

  server.registerTool("mouse_move", {
    title: "Move mouse",
    description: "Move the cursor without clicking (hover, tooltips, menus). 移动鼠标。",
    inputSchema: { x: z.number().int(), y: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded("mouse_move", "click", (a) => targetAt(a.x, a.y), async (a) => {
    const r = await helper.call<{ x: number; y: number }>("mouse_move", { x: a.x, y: a.y });
    return text(`Cursor at (${r.x},${r.y}).`);
  }));

  server.registerTool("set_value", {
    title: "Set value",
    description: "Set the text of an input control directly by ref (faster and more reliable than click + type when the control supports it). 直接给输入框设值。",
    inputSchema: { ref: z.number().int(), text: z.string().max(20000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded("set_value", "type", (a) => byRef(a.ref), async (a) => {
    await helper.call("uia_set_value", { ref: a.ref, text: a.text }, 8000);
    return text(`Set value of [${a.ref}] (${a.text.length} chars).`);
  }));

  server.registerTool("focus_element", {
    title: "Focus element",
    description: "Give keyboard focus to a control by ref without clicking. 聚焦控件。",
    inputSchema: { ref: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded("focus_element", "click", (a) => byRef(a.ref), async (a) => {
    await helper.call("uia_focus", { ref: a.ref }, 8000);
    return text(`Focused [${a.ref}].`);
  }));

  server.registerTool("clipboard_get", {
    title: "Read clipboard",
    description: "Read text from the clipboard. 读剪贴板。",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const r = await helper.call<{ text: string; hasText: boolean }>("clipboard_get");
    return text(r.hasText ? r.text : "(clipboard has no text)");
  });

  server.registerTool("clipboard_set", {
    title: "Write clipboard",
    description: "Put text on the clipboard (then press ctrl+v in the target app; good for long or formatted text). 写剪贴板。",
    inputSchema: { text: z.string().max(200000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => {
    await helper.call("clipboard_set", { text: a.text });
    return text(`Clipboard set (${a.text.length} chars).`);
  });
}
