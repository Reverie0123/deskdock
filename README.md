# DeskDock

**Let Claude, Cursor or any model safely operate any Windows app.**

English · [简体中文](README.zh.md)

DeskDock is an MCP server for Windows. Once it is installed, any MCP client (Claude Code, Claude Desktop, Cursor, Cline, Windsurf, Cherry Studio and others) can see your desktop windows, read their controls as text, click, type and press keys, with a per-app permission table that you control and an audit log of every step.

<!-- demo.gif: left, a chat window with one instruction; right, the desktop doing it. Added before release. -->

```bash
npx deskdock setup
```

One command finds the AI clients installed on this machine and adds DeskDock to each of them. Restart the client and ask it to do something on your desktop.

- **Installs in one line, needs nothing else.** A single executable plus Node. No Python, no .NET runtime, no model download.
- **Reads windows as text, not pixels.** Controls come back as `[ref] button "Save"` lines with exact screen rects. Clicking by ref survives window moves, DPI changes and multiple monitors. A screenshot is the fallback, not the default.
- **You decide what it may touch.** Every app gets a level: block, read, click or full. Browsers are read-only by default, terminals and IDEs are click-only, password managers and payment apps are blocked. Denied actions are explained to the model so it asks you instead of guessing.
- **Chinese and English throughout.** Tool descriptions, errors and the setup command follow your system language, and the built-in Windows OCR reads Chinese UI text out of the box.

## How it compares

| | DeskDock | Windows-MCP | terminator | Claude Desktop (built-in) |
|---|---|---|---|---|
| Install | `npx deskdock setup` | Python 3.13 + uv | npm | part of the app |
| Works with any MCP client | yes | yes | yes | Claude only |
| UI tree as text + click by ref | yes | yes | yes | screenshot + coordinates |
| Per-app permission levels | block / read / click / full, editable | tool allow-list only | none | fixed by category |
| Audit log of every action | yes | no | no | no |
| OCR fallback for apps without a UI tree | built-in Windows OCR, no download | no | no | no |
| Hung UI tree handling | per-call timeout, auto-restart | reported deadlocks | — | — |
| Chinese UI and docs | yes | English only | English only | yes |

## Tools

| Tool | What it does |
|---|---|
| `list_windows` | Visible top-level windows with hwnd, title, process, rect and the policy level that applies |
| `focus_window` | Bring a window to the front (restores minimized windows) |
| `read_window` | The window's controls as text: one line per control with a `[ref]`, type, name, value and screen rect |
| `read_screen_text` | OCR fallback: every text line on screen or in one window, with screen coordinates |
| `screenshot` | PNG of the full screen or one window, downscaled so the long edge fits in 1280 px |
| `click` | Click a control by ref, or a point by coordinates; left / right / middle, single or double |
| `type` | Type text into the focused control (Unicode, so Chinese works; `\n` presses Enter) |
| `key` | Press a key or chord: `enter`, `ctrl+s`, `alt+f4`, `win+r` |
| `scroll`, `drag`, `mouse_move` | Wheel, drag and hover |
| `set_value`, `focus_element` | Set an input's text or focus a control directly by ref |
| `clipboard_get`, `clipboard_set` | Read and write the clipboard |
| `screen_info` | Monitors, DPI scale and virtual-screen bounds |

The usual flow the model follows: `list_windows` → `focus_window` → `read_window` → `click` / `type` → `read_window` again to verify. All coordinates are physical screen pixels.

## Permissions

The policy lives at `%APPDATA%\deskdock\policy.json` (run `deskdock policy` to print the path). It is created on first run and re-read whenever it changes.

```json
{
  "version": 1,
  "default": "full",
  "rules": {
    "msedge.exe": "read",
    "chrome.exe": "read",
    "windowsterminal.exe": "click",
    "code.exe": "click",
    "1password.exe": "block",
    "title:online banking": "block"
  }
}
```

| Level | Screenshot, read_window, OCR | Click, scroll, drag, focus | Type, key, set_value |
|---|---|---|---|
| `block` | no | no | no |
| `read` | yes | no | no |
| `click` | yes | yes | no |
| `full` | yes | yes | yes |

Keys are lower-case process names, or `title:` followed by a substring of the window title. The first matching rule wins; otherwise `default` applies. When a tool is denied, the model receives the reason and the file path, and is told to ask you to do that step yourself.

Note that `read` still lets the model see what is on screen in that app, including a browser's address bar. Use `block` for anything it should not even look at.

## Control panel and tray

`deskdock panel` opens a local page (127.0.0.1 only) where you edit the permission table, browse the audit log by day, filter by tool or outcome, and replay a session step by step on a timeline. The MCP server also starts the panel in the background whenever a client launches it.

`resources/deskdock-tray.exe` puts an icon in the notification area: open the panel, open the log folder, exit, and **Pause DeskDock**. While paused, every tool call is refused with a message telling the model to ask you to resume. Pause state is a marker file in `%APPDATA%\deskdock`, so it works even when the panel is not open.

## Audit log

Every tool call is appended to `%APPDATA%\deskdock\logs\YYYY-MM-DD.jsonl`: time, tool, arguments, the target window and process, outcome (ok / denied / error) and duration. Typed text is logged as a character count, never as content. Screenshots are not stored.

## Apps without a UI tree

Most native, WinUI, Office and Chromium apps expose a full tree. Electron apps build theirs only after an assistive-technology client shows up: DeskDock sends the signals Chromium looks for on every read, but the first `read_window` on such an app may still return only the title-bar buttons, with the full tree appearing on a retry a few seconds later. Games and custom-drawn UIs have no tree at all. For those cases, `read_screen_text` runs the OCR engine built into Windows 10/11 on a screenshot and returns each text line with its coordinates, so the model can still click on a label. Install the English OCR language pack (Settings → Time & language → Language → Add a language → English → Optional features → OCR) for better results on English UI text.

## Install

**From npm (after release):** `npx deskdock setup`.

**From source** (Node.js 20 or newer):

```bash
git clone https://github.com/Reverie0123/deskdock.git
cd deskdock
npm install
npm run build
node dist/index.js setup
```

`setup` edits the config of each installed client (Claude Code via `claude mcp add`, Claude Desktop, Cursor, Cline, Windsurf) after backing it up as `.deskdock.bak`; `setup --dry-run` only prints what would change; `setup --remove` undoes it. For clients without a standard config file, `setup` prints a JSON snippet to paste.

The native helper (`resources/deskdock-helper.exe`) is prebuilt. Rebuild it with `npm run build:helper` only if you change `native/helper/helper.cpp` (needs MinGW-w64 g++).

## FAQ

**Is this a plugin or an app?** Both, in the way a VPN client is: it is a background program with a tray settings window (coming), but it does nothing on its own. Your AI client calls it when the model wants to act on the desktop.

**Does it watch my screen all the time?** No. Nothing is read until the model calls a tool, and each call reads one window once. There is no background capture.

**Why does it only see three buttons in some apps?** That app does not expose its UI tree (common with Electron apps that disabled accessibility). Use `read_screen_text` or `screenshot` there; DeskDock tells the model to do so automatically.

**Can it mess up a document I have open?** Yes, in principle: `type` goes to whatever control has focus. The model is instructed to focus and verify the target window first, and every call is in the audit log, but keep sensitive work on `read` or `block` while an agent is running, and save your files.

**Can it type my passwords?** Policy aside, the tool instructions tell the model never to enter passwords or payment details and to ask you instead. Keep password managers and banking apps on `block`.

## Development

```bash
npm run build          # TypeScript -> dist/
npm run build:helper   # native helper (MinGW g++)
npm test               # read-only tests; they never inject input
```

`tests/e2e/` (coming) injects real mouse and keyboard input; do not run it while you are using the computer.

## License

MIT. DeskDock is not affiliated with Anthropic, Microsoft, Cursor or any client it integrates with.

## Related

- [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP): the most widely used Windows desktop MCP server, Python based.
- [mediar-ai/terminator](https://github.com/mediar-ai/terminator): Rust desktop automation with a Playwright-style API.
