# Changelog

## 0.1.0 (2026-10-28)

First version.

- MCP server over stdio with 21 tools: windows, UI tree as text, click by ref or coordinates, type, keys, scroll, drag, clipboard, screenshot, OCR fallback, macros.
- Native helper (single MinGW-built executable): UI Automation with per-call timeouts, PrintWindow capture, SendInput with virtual-desktop coordinates, Per-Monitor V2 DPI awareness.
- Per-app permission table (block / read / click / ask / full); apps without a rule ask before every action, browsers read-only, terminals click-only, password managers, banks and payment apps blocked; audit log in JSONL; pause marker honoured on every call.
- Local control panel (policy editor, log table and timeline replay, macros) and a tray app (open panel, pause, logs, exit).
- `deskdock setup` writes the server into Claude Code, Claude Desktop, Cursor, Cline and Windsurf configs, with backups.
- Chinese and English interface following the system language.
- Model guidance in three layers: tool descriptions, MCP server instructions sent on connect, and a skill file (`skills/deskdock/SKILL.md`) with the full playbook and worked examples.
