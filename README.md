# DeskDock

**Let Claude, Cursor or any model safely operate any Windows app.**

English · [简体中文](README.zh.md)

DeskDock is an MCP server for Windows. Once it is installed, any MCP client (Claude Code, Claude Desktop, Cursor, Cline, Windsurf, Cherry Studio and others) can see your desktop windows, read their controls as text, click, type and press keys, with a per-app permission table that you control and an audit log of every step.

<!-- demo.gif: left, a chat window with one instruction; right, the desktop doing it. Added before release. -->

**Download `DeskDock-Setup-0.1.0.exe`** from the [releases page](https://github.com/Reverie0123/deskdock/releases) and double-click it: pick a language, tick the AI apps to connect (the ones found on your PC are pre-ticked), done. Nothing else to install; no admin rights needed.

Developers can skip the wizard:

```bash
npx deskdock setup
```

Either way, DeskDock is written into the MCP settings of every selected client. Restart the client and ask it to do something on your desktop.

- **Installs in one line, needs nothing else.** A single executable plus Node. No Python, no .NET runtime, no model download.
- **Reads windows as text, not pixels.** Controls come back as `[ref] button "Save"` lines with exact screen rects. Clicking by ref survives window moves, DPI changes and multiple monitors. A screenshot is the fallback, not the default.
- **You decide what it may touch.** Every app gets a level: block, read, click, ask (a yes/no dialog before each action) or full. Apps without a rule **ask** before every action, with three buttons: allow once, allow this app until the client exits, deny; browsers are read-only, terminals and IDEs click-only, password managers, banks and payment apps blocked. The target window is re-checked by the native engine in the same step as the input, so a focus change between the decision and the action is refused. Denied actions are explained to the model so it asks you instead of guessing.
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
| `close_window` | Ask a window to close (like clicking its X) |
| `list_macros`, `save_macro`, `run_macro`, `delete_macro` | Record, replay and manage macros (see below) |
| `screen_info` | Monitors, DPI scale and virtual-screen bounds |

The usual flow the model follows: `list_windows` → `focus_window` → `read_window` → `click` / `type` → `read_window` again to verify. All coordinates are physical screen pixels.

## Privacy in one paragraph

DeskDock never connects to the network. Everything it reads (window text, screenshots, OCR, clipboard) goes to **your AI client and from there to the model provider you configured**; that is the only place your data leaves the machine. A `read` level still lets the model see an app; use `block` for anything it must not look at. Screen content is labelled as data, not instructions, but prompt injection through web pages and messages remains a risk of every desktop agent. Full details, verification steps and the binary build pipeline: [PRIVACY.md](PRIVACY.md).

## Permissions

The policy lives at `%APPDATA%\deskdock\policy.json` (run `deskdock policy` to print the path). It is created on first run and re-read whenever it changes.

```json
{
  "version": 1,
  "default": "ask",
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

The factory default for apps without a rule is `ask`.

| Level | Screenshot, read_window, OCR | Click, scroll, drag, focus | Type, key, set_value |
|---|---|---|---|
| `block` | no | no | no |
| `read` | yes | no | no |
| `click` | yes | yes | no |
| `ask` | yes | after you click Yes in a dialog | after you click Yes in a dialog |
| `full` | yes | yes | yes |

Keys are lower-case process names, `title:` followed by a substring of the window title, `title=` followed by the exact title, or `class:<window class>@<process>` (used for the Win+R Run box: `class:#32770@explorer.exe`, which works in every UI language). When several rules match (a process rule and a `title:` rule), the strictest one wins; otherwise `default` applies. Windows whose process cannot be identified are capped at `read`. When a tool is denied, the model receives the reason and the file path, and is told to ask you to do that step yourself.

Note that `read` still lets the model see what is on screen in that app, including a browser's address bar. Use `block` for anything it should not even look at.

**Known limit:** a key chord sent to the foreground app can also trigger a *global* hotkey registered by another program (for example a password manager's quick-fill shortcut). No input-injection tool can tell those apart; prefer `ask` for keyboard-heavy sessions if that matters to you. If the policy file cannot be parsed, DeskDock falls back to read-only defaults and says so in every denial.

## Control panel and tray

`deskdock panel` opens a local page (127.0.0.1 only, port 17337 or `DESKDOCK_PANEL_PORT`; one panel is shared by every DeskDock instance on the machine) where you edit the permission table, browse the audit log by day, filter by tool or outcome, and replay a session step by step on a timeline. The MCP server also starts the panel in the background whenever a client launches it.

Double-clicking `resources/deskdock-native.exe` (the same file the server uses as its engine) puts an icon in the notification area: open the panel, open the log folder, exit, and **Pause DeskDock**. While paused, every tool call is refused with a message telling the model to ask you to resume. Pause state is a marker file in `%APPDATA%\deskdock`, so it works even when the panel is not open.

## Macros

A task you repeat can be saved as a macro and comes back as a tool of its own:

```
save_macro(name="wechat_send", description="Send a WeChat message", fromLast=4,
           params=[{name:"who"},{name:"text"}], replace={"小王":"who","今晚八点开会":"text"})
→ new tool macro_wechat_send(who, text)
```

`fromLast=N` takes the last N successful actions of the session. Text that was typed or pasted is never written to the macro file: each occurrence becomes a `text_N` parameter unless you map it with `replace`. Steps that clicked a `[ref]` are stored as a stable description (process, control name, type, automationId) and re-resolved at run time, so a macro keeps working after windows move or reopen. `{{param}}` placeholders become the tool's parameters. Every replayed step goes through the same permission table and audit log; macros cannot call other macros. Files live in `%APPDATA%\deskdock\macros`.

## Audit log

Every tool call is appended to `%APPDATA%\deskdock\logs\YYYY-MM-DD.jsonl`: time, tool, arguments, the target window and process, outcome (ok / denied / error) and duration. Typed text is logged as a character count, never as content. Screenshots are not stored. Note that a macro file does contain the text that was typed while recording it, unless you turned it into a parameter.

## Apps without a UI tree

Most native, WinUI, Office and Chromium apps expose a full tree. Electron apps build theirs only after an assistive-technology client shows up: DeskDock sends the signals Chromium looks for on every read, but the first `read_window` on such an app may still return only the title-bar buttons, with the full tree appearing on a retry a few seconds later. Games and custom-drawn UIs have no tree at all. For those cases, `read_screen_text` runs the OCR engine built into Windows 10/11 on a screenshot and returns each text line with its coordinates, so the model can still click on a label. Install the English OCR language pack (Settings → Time & language → Language → Add a language → English → Optional features → OCR) for better results on English UI text.

## Install

**Installer (recommended for most people):** `DeskDock-Setup-<version>.exe` from the releases page. Per-user install into `%LOCALAPPDATA%\Programs\DeskDock`, bundles its own Node, adds Start-menu entries for the tray and the control panel, and uninstalls cleanly (it also removes itself from the AI clients it was added to).

**From npm (developers):** `npx deskdock setup`.

**No Node.js on this machine?** One line in PowerShell downloads a portable Node into DeskDock's own folder (no admin rights, nothing system-wide) and runs setup:

```powershell
irm https://raw.githubusercontent.com/Reverie0123/deskdock/main/install.ps1 | iex
```

**From source** (Node.js 20 or newer):

```bash
git clone https://github.com/Reverie0123/deskdock.git
cd deskdock
npm install
npm run build
node dist/index.js setup
```

`setup` edits the config of each installed client (Claude Code via `claude mcp add`, Claude Desktop, Cursor, Cline, Windsurf) after backing it up as `.deskdock.bak`; `setup --dry-run` only prints what would change; `setup --remove` undoes it. For clients without a standard config file, `setup` prints a JSON snippet to paste.

The native program (`resources/deskdock-native.exe`) is prebuilt. Rebuild it with `npm run build:native` only if you change `native/` (needs MinGW-w64 g++ and windres).

## FAQ

**Is this a plugin or an app?** Both, in the way a VPN client is: it is a background program with a tray settings window (coming), but it does nothing on its own. Your AI client calls it when the model wants to act on the desktop.

**Does it watch my screen all the time?** No. Nothing is read until the model calls a tool, and each call reads one window once. There is no background capture.

**Why does it only see three buttons in some apps?** That app does not expose its UI tree (common with Electron apps that disabled accessibility). Use `read_screen_text` or `screenshot` there; DeskDock tells the model to do so automatically.

**Can it mess up a document I have open?** Yes, in principle: `type` goes to whatever control has focus. The model is instructed to focus and verify the target window first, and every call is in the audit log, but keep sensitive work on `read` or `block` while an agent is running, and save your files.

**Can it type my passwords?** Policy aside, the tool instructions tell the model never to enter passwords or payment details and to ask you instead. Keep password managers and banking apps on `block`.

## Development

```bash
npm run build          # TypeScript -> dist/
npm run build:native   # native engine + tray, one exe (MinGW g++)
npm test               # read-only tests; they never inject input
```

`tests/e2e/` injects real mouse and keyboard input (Notepad, Settings, the tray, a macro); do not run it while you are using the computer.

## License

MIT. DeskDock is not affiliated with Anthropic, Microsoft, Cursor or any client it integrates with.

## Related

- [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP): the most widely used Windows desktop MCP server, Python based.
- [mediar-ai/terminator](https://github.com/mediar-ai/terminator): Rust desktop automation with a Playwright-style API.
