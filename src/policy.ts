// Per-application permission table. Lives at %APPDATA%\deskdock\policy.json and is re-read when the file changes.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** block: never touch; read: screenshot + read tree only; click: read + mouse, no keyboard; full: everything */
export type Level = "block" | "read" | "click" | "full";
export type Action = "read" | "click" | "type";

export interface Policy {
  version: 1;
  /** Level used when no rule matches. */
  default: Level;
  /** Keys are lower-case process names (e.g. "msedge.exe"), window-title substrings prefixed with "title:", or exact titles prefixed with "title=". */
  rules: Record<string, Level>;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  default: "full",
  rules: {
    // browsers: look, don't touch (the model should use a browser tool for web pages)
    "msedge.exe": "read", "chrome.exe": "read", "firefox.exe": "read", "brave.exe": "read", "opera.exe": "read", "vivaldi.exe": "read", "arc.exe": "read",
    // terminals and IDEs: clicking is fine, typing commands is not
    "windowsterminal.exe": "click", "cmd.exe": "click", "powershell.exe": "click", "pwsh.exe": "click", "conhost.exe": "click",
    "code.exe": "click", "cursor.exe": "click", "idea64.exe": "click", "pycharm64.exe": "click", "devenv.exe": "click",
    // sensitive: never
    "1password.exe": "block", "bitwarden.exe": "block", "keepass.exe": "block", "keepassxc.exe": "block",
    "alipay.exe": "block", "alipaysecsvc.exe": "block", "wechatpay.exe": "block",
    "title:网上银行": "block", "title:online banking": "block", "title:密码管理": "block",
    // the Win+R Run box lives in explorer.exe: let the model see it but not type a command into it (exact title)
    "title=运行": "click", "title=run": "click",
    // ourselves and the OS security surface
    "logonui.exe": "block", "consent.exe": "block", "credentialuihost.exe": "block",
    // the model must not edit its own permission table: any window showing the policy file or the control panel is read-only
    "title:policy.json": "read", "title:deskdock": "read",
  },
};

export function policyDir(): string {
  if (process.env.DESKDOCK_HOME) return process.env.DESKDOCK_HOME; // tests and portable installs
  return path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"), "deskdock");
}
export function policyPath(): string { return path.join(policyDir(), "policy.json"); }
/** The tray app creates this file while the user has paused DeskDock; every tool is refused until it is gone. */
export function pausedPath(): string { return path.join(policyDir(), "paused"); }
export function isPaused(): boolean { return existsSync(pausedPath()); }

export class PolicyStore {
  private cached: Policy = DEFAULT_POLICY;
  private mtime = 0;
  constructor(private readonly filePath: string = policyPath()) {}
  get file(): string { return this.filePath; }

  /** Writes the default table on first run so users can find and edit it. */
  ensureFile(): void {
    if (existsSync(this.filePath)) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", "utf8");
  }

  get(): Policy {
    try {
      const st = statSync(this.filePath);
      if (st.mtimeMs !== this.mtime) {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<Policy>;
        const rules: Record<string, Level> = {};
        for (const [k, v] of Object.entries(raw.rules ?? {})) {
          if (LEVELS.includes(v as Level)) rules[k.trim().toLowerCase()] = v as Level;
          else { rules[k.trim().toLowerCase()] = "block"; process.stderr.write(`[deskdock] policy: unknown level "${String(v)}" for ${k}; treating as block\n`); }
        }
        let def: Level = "full";
        if (LEVELS.includes(raw.default as Level)) def = raw.default as Level;
        else if (raw.default !== undefined) { def = "read"; process.stderr.write(`[deskdock] policy: unknown default level "${String(raw.default)}"; using read\n`); }
        this.cached = { version: 1, default: def, rules };
        this.mtime = st.mtimeMs;
      }
    } catch {
      // a torn write (editor saving, panel PUT in flight) or a missing file: keep the last good table rather than
      // falling back to something more permissive than what the user configured
      if (this.mtime === 0) this.cached = DEFAULT_POLICY;
    }
    return this.cached;
  }

  /** The strictest of every matching rule (process name and any title: substring); default when nothing matches.
   *  A window whose process cannot be identified (protected/system process) is capped at read. */
  levelFor(processName: string, title: string): Level {
    const p = this.get();
    const proc = processName.toLowerCase();
    const t = title.toLowerCase();
    let level: Level | undefined = proc ? p.rules[proc] : undefined;
    for (const [k, v] of Object.entries(p.rules)) {
      const hit = (k.startsWith("title:") && k.length > 6 && t.includes(k.slice(6)))   // substring
               || (k.startsWith("title=") && k.length > 6 && t === k.slice(6));         // exact title
      if (hit) level = level === undefined ? v : strictest(level, v);
    }
    if (level === undefined) level = p.default;
    if (!proc) level = strictest(level, "read");
    return level;
  }
}

const LEVELS: Level[] = ["block", "read", "click", "full"];
const RANK: Record<Level, number> = { block: 0, read: 1, click: 2, full: 3 };
export function strictest(a: Level, b: Level): Level { return RANK[a] <= RANK[b] ? a : b; }
const NEEDED: Record<Action, number> = { read: 1, click: 2, type: 3 };

export interface Decision { allowed: boolean; level: Level; reason?: string }

export function decide(level: Level, action: Action, processName: string, title: string): Decision {
  if (RANK[level] >= NEEDED[action]) return { allowed: true, level };
  const target = processName || title || "this window";
  const what = action === "read" ? "read or screenshot" : action === "click" ? "click in" : "type into";
  const because = level === "block"
    ? `"${target}" is blocked by the user's DeskDock policy`
    : `"${target}" is set to "${level}" in the user's DeskDock policy`;
  return {
    allowed: false, level,
    reason: `Not allowed to ${what} "${target}": ${because}. Tell the user and ask them to do this step themselves, or to change the rule in ${policyPath()}.`,
  };
}
