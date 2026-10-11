// Append-only audit log: %APPDATA%\deskdock\logs\YYYY-MM-DD.jsonl, one line per tool call.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { policyDir } from "./policy.js";

export interface AuditEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  target?: { process: string; title: string; hwnd: number };
  outcome: "ok" | "denied" | "error";
  detail?: string;
  ms: number;
}

export class Audit {
  constructor(private dir: string = path.join(policyDir(), "logs")) {}

  write(e: AuditEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${e.ts.slice(0, 10)}.jsonl`);
      appendFileSync(file, JSON.stringify(e) + "\n", "utf8");
    } catch (err) {
      process.stderr.write(`[deskdock] audit write failed: ${(err as Error).message}\n`);
    }
  }
}

/** Strip anything bulky or sensitive from args before logging. */
export function redactArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (tool === "type" && typeof out.text === "string") out.text = `${(out.text as string).length} chars`;
  if (tool === "clipboard_set" && typeof out.text === "string") out.text = `${(out.text as string).length} chars`;
  if (tool === "set_value" && typeof out.text === "string") out.text = `${(out.text as string).length} chars`;
  return out;
}
