# Installing DeskDock (instructions for AI agents such as Cline)

DeskDock is a Windows-only MCP server (stdio). Requirements: Windows 10/11, Node.js 20 or newer.

## Recommended: one command

```bash
npx deskdock setup
```

This installs nothing globally; it writes a `deskdock` entry into the MCP configuration of every client found on the machine (Claude Code, Claude Desktop, Cursor, Cline for VS Code and Cursor, Windsurf), backing each file up as `*.deskdock.bak`. Restart the client afterwards.

## Manual configuration

Add this to the client's MCP settings (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "deskdock": {
      "command": "npx",
      "args": ["-y", "deskdock"]
    }
  }
}
```

No environment variables or API keys are needed. The permission table is created on first run at `%APPDATA%\deskdock\policy.json`; the control panel is available with `npx deskdock panel`.

## Verify

Call the `list_windows` tool: it should return the visible windows with their process names and permission levels. If `read_window` on an Electron app returns only three title-bar buttons, retry after a few seconds or use `read_screen_text`.

## Teach the agent (optional)

The package ships a playbook at `node_modules/deskdock/skills/deskdock/SKILL.md` (or `skills/deskdock/SKILL.md` in the repository). For Claude Code, copy that folder into `.claude/skills/`. For other agents, add a rule such as `Before operating Windows apps with DeskDock, read <path>/skills/deskdock/SKILL.md` to `AGENTS.md`, `CLAUDE.md` or `.cursorrules`.

## Uninstall

```bash
npx deskdock setup --remove
```
