# Changelog

## 0.1.0 (unreleased)

First version.

- MCP server over stdio with 21 tools: windows, UI tree as text, click by ref or coordinates, type, keys, scroll, drag, clipboard, screenshot, OCR fallback, macros.
- Native helper (single MinGW-built executable): UI Automation with per-call timeouts, PrintWindow capture, SendInput with virtual-desktop coordinates, Per-Monitor V2 DPI awareness.
- Per-app permission table (block / read / click / full) with sensible defaults; audit log in JSONL; pause marker honoured on every call.
- Local control panel (policy editor, log table and timeline replay, macros) and a tray app (open panel, pause, logs, exit).
- `deskdock setup` writes the server into Claude Code, Claude Desktop, Cursor, Cline and Windsurf configs, with backups.
- Chinese and English interface following the system language.
