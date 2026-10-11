// Macros: a recorded list of tool calls, saved as JSON under %APPDATA%\deskdock\macros and exposed back to the
// model as one tool each (macro_<name>). Steps that clicked a [ref] are stored with a stable target description
// instead, because refs only live for one read_window.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { policyDir } from "./policy.js";

export interface MacroTarget {
  /** process name of the window, e.g. notepad.exe */
  process?: string;
  /** substring of the window title (optional, for apps with several windows) */
  title?: string;
  /** control name, type and automationId from read_window; name may be matched as a substring */
  name?: string; nameContains?: boolean; type?: string; automationId?: string;
}
export interface MacroStep {
  tool: string;
  args: Record<string, unknown>;
  /** set when the original call used a ref: resolved to a fresh ref at run time */
  target?: MacroTarget;
  /** optional pause after the step, ms (apps need time to react) */
  waitMs?: number;
}
export interface MacroParam { name: string; description?: string }
export interface Macro { name: string; description: string; params: MacroParam[]; steps: MacroStep[]; created: string }

export const MACRO_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function macrosDir(): string { return path.join(policyDir(), "macros"); }

export class MacroStore {
  constructor(private readonly dir: string = macrosDir()) {}
  list(): Macro[] {
    if (!existsSync(this.dir)) return [];
    const out: Macro[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as Macro); } catch { /* skip broken file */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  get(name: string): Macro | undefined {
    const file = path.join(this.dir, `${name}.json`);
    if (!MACRO_NAME.test(name) || !existsSync(file)) return undefined;
    try { return JSON.parse(readFileSync(file, "utf8")) as Macro; } catch { return undefined; }
  }
  save(m: Macro): void {
    validateMacro(m);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, `${m.name}.json`), JSON.stringify(m, null, 2) + "\n", "utf8");
  }
  delete(name: string): boolean {
    const file = path.join(this.dir, `${name}.json`);
    if (!MACRO_NAME.test(name) || !existsSync(file)) return false;
    unlinkSync(file); return true;
  }
}

export function validateMacro(m: Macro): void {
  if (!MACRO_NAME.test(m.name)) throw new Error(`macro name must match ${MACRO_NAME} (got "${m.name}")`);
  if (!Array.isArray(m.steps) || m.steps.length === 0) throw new Error("a macro needs at least one step");
  if (m.steps.length > 200) throw new Error("too many steps (max 200)");
  for (const [i, s] of m.steps.entries()) {
    if (!s.tool || typeof s.tool !== "string") throw new Error(`step ${i + 1}: tool missing`);
    if (/^macro_/.test(s.tool) || ["save_macro", "run_macro", "delete_macro"].includes(s.tool)) throw new Error(`step ${i + 1}: macros cannot call ${s.tool}`);
    if (s.args && typeof s.args !== "object") throw new Error(`step ${i + 1}: args must be an object`);
  }
  for (const p of m.params ?? []) if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(p.name)) throw new Error(`bad param name "${p.name}"`);
  const used = new Set<string>();
  JSON.stringify(m.steps).replace(/\{\{(\w+)\}\}/g, (_, n) => { used.add(n); return ""; });
  for (const n of used) if (!(m.params ?? []).some((p) => p.name === n)) throw new Error(`step uses {{${n}}} but no such param is declared`);
}

/** Replace {{param}} placeholders inside every string of args. Whole-string placeholders keep their type if the value is not a string. */
export function substitute<T>(value: T, params: Record<string, unknown>): T {
  if (typeof value === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(value);
    if (whole && whole[1] in params) return params[whole[1]] as unknown as T;
    return value.replace(/\{\{(\w+)\}\}/g, (m, n) => (n in params ? String(params[n]) : m)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, params);
    return out as unknown as T;
  }
  return value;
}

export function formatMacro(m: Macro): string {
  const params = m.params.length ? m.params.map((p) => `{{${p.name}}}${p.description ? ` (${p.description})` : ""}`).join(", ") : "none";
  const steps = m.steps.map((s, i) => {
    const tgt = s.target ? ` -> ${[s.target.process, s.target.type, s.target.name && JSON.stringify(s.target.name)].filter(Boolean).join(" ")}` : "";
    return `  ${i + 1}. ${s.tool} ${JSON.stringify(s.args)}${tgt}`;
  });
  return [`macro_${m.name}: ${m.description || "(no description)"}`, `params: ${params}`, ...steps].join("\n");
}
