// Per-application permission table. Lives at %APPDATA%\deskdock\policy.json and is re-read when the file changes.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** block: never touch; read: screenshot + read tree only; click: read + mouse, no keyboard;
 *  ask: everything, but each mouse/keyboard action pops a yes/no box for the user; full: everything */
export type Level = "block" | "read" | "click" | "ask" | "full";
export type Action = "read" | "click" | "type";

export interface Policy {
  version: 1;
  /** Level used when no rule matches. */
  default: Level;
  /** Keys are lower-case process names (e.g. "msedge.exe"), window-title substrings prefixed with "title:", exact titles prefixed with "title=", or "class:<window class>@<process>". */
  rules: Record<string, Level>;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  // Apps without a rule get "ask": the user sees a yes/no box before each action and can switch an app to full (Shift+Yes, or the panel).
  default: "ask",
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
    // banks, brokers and payment sites in a browser (the browser itself is only "read", which still lets the model see the page)
    "title:个人网银": "block", "title:企业网银": "block", "title:工商银行": "block", "title:建设银行": "block", "title:农业银行": "block", "title:中国银行": "block", "title:招商银行": "block", "title:交通银行": "block", "title:邮储银行": "block", "title:邮政储蓄": "block", "title:浦发银行": "block", "title:兴业银行": "block", "title:民生银行": "block", "title:中信银行": "block", "title:光大银行": "block", "title:平安银行": "block", "title:华夏银行": "block", "title:广发银行": "block", "title:支付宝": "block", "title:微信支付": "block", "title:财付通": "block", "title:云闪付": "block", "title:证券": "block", "title:同花顺": "block", "title:东方财富": "block", "title:富途": "block", "title:老虎证券": "block",
    "title: bank": "block", "title:bank of": "block", "title:banking": "block", "title:paypal": "block", "title:coinbase": "block", "title:binance": "block", "title:brokerage": "block", "title:robinhood": "block", "title:wise.com": "block", "title:revolut": "block",
    // the Win+R Run box is an explorer.exe dialog: let the model see it but not type a command into it (any UI language)
    "class:#32770@explorer.exe": "click", "title=运行": "click", "title=run": "click",
    // our own files: never let the model edit the permission table or read the panel token
    "title:panel.json": "read", "title:panel-token": "block",
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
  private stamp = ""; // mtime + size of the last table read: mtime alone misses a rewrite inside the same tick on coarse filesystems
  /** set when the file could not be parsed: the table in use is then a fail-closed one, and denials say so */
  problem: string | undefined;
  private warned = false;
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
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp !== this.stamp) {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<Policy>;
        const rules: Record<string, Level> = {};
        for (const [k, v] of Object.entries(raw.rules ?? {})) {
          if (LEVELS.includes(v as Level)) rules[k.trim().toLowerCase()] = v as Level;
          else { rules[k.trim().toLowerCase()] = "block"; process.stderr.write(`[deskdock] policy: unknown level "${String(v)}" for ${k}; treating as block\n`); }
        }
        let def: Level = DEFAULT_POLICY.default; // a file without "default" behaves like the factory table
        if (LEVELS.includes(raw.default as Level)) def = raw.default as Level;
        else if (raw.default !== undefined) { def = "read"; process.stderr.write(`[deskdock] policy: unknown default level "${String(raw.default)}"; using read\n`); }
        this.cached = { version: 1, default: def, rules };
        this.stamp = stamp;
        this.problem = undefined;
      }
    } catch (e) {
      // Unreadable file. If we had a good table, keep it (an editor save or the panel may be mid-write) but say so in
      // every denial; if we never had one, fail closed: the default rules with "read" as the fallback level, never "full".
      const why = (e as Error).message.split("\n")[0];
      if (this.stamp === "") {
        this.cached = { version: 1, default: "read", rules: DEFAULT_POLICY.rules };
        this.problem = `policy file ${this.filePath} could not be parsed (${why}); using read-only defaults until it is fixed`;
      } else {
        this.problem = `policy file ${this.filePath} could not be parsed (${why}); the last valid table is still in use, new rules are NOT applied`;
      }
      if (!this.warned) { process.stderr.write(`[deskdock] ${this.problem}\n`); this.warned = true; }
    }
    return this.cached;
  }

  /** The strictest of every matching rule (process name and any title: substring); default when nothing matches.
   *  A window whose process cannot be identified (protected/system process) is capped at read. */
  levelFor(processName: string, title: string, windowClass = ""): Level {
    const p = this.get();
    const proc = processName.toLowerCase();
    const t = title.toLowerCase();
    const cls = windowClass.toLowerCase();
    let level: Level | undefined = proc ? p.rules[proc] : undefined;
    for (const [k, v] of Object.entries(p.rules)) {
      const hit = (k.startsWith("title:") && k.length > 6 && t.includes(k.slice(6)))   // substring
               || (k.startsWith("title=") && k.length > 6 && t === k.slice(6))          // exact title
               || (k.startsWith("class:") && cls && k.slice(6) === `${cls}@${proc}`);  // window class@process
      if (hit) level = level === undefined ? v : strictest(level, v);
    }
    if (level === undefined) level = p.default;
    if (!proc) level = strictest(level, "read");
    return level;
  }
}

const LEVELS: Level[] = ["block", "read", "click", "ask", "full"];
const RANK: Record<Level, number> = { block: 0, read: 1, click: 2, ask: 3, full: 4 };
export function strictest(a: Level, b: Level): Level { return RANK[a] <= RANK[b] ? a : b; }
const NEEDED: Record<Action, number> = { read: 1, click: 2, type: 3 };

export interface Decision { allowed: boolean; level: Level; reason?: string; /** level "ask": the user must confirm this action first */ confirm?: boolean }

export function decide(level: Level, action: Action, processName: string, title: string): Decision {
  if (RANK[level] >= NEEDED[action]) return { allowed: true, level, confirm: level === "ask" && action !== "read" };
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
