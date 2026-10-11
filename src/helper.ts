// Talks to the C++ helper (resources/deskdock-helper.exe): one JSON request per line in, one JSON response per line out.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WindowInfo {
  hwnd: number; title: string; class: string; pid: number; process: string;
  rect: { x: number; y: number; w: number; h: number }; minimized: boolean; focused: boolean;
}
export interface UiaNode {
  ref: number; depth: number; type: string; name: string; rect: { x: number; y: number; w: number; h: number };
  enabled?: boolean; offscreen?: boolean; focusable?: boolean; automationId?: string; value?: string; checked?: "on" | "off" | "mixed";
}
export interface Snapshot { window: WindowInfo; nodes: UiaNode[]; truncated: boolean }
export interface Screenshot { png_base64: string; width: number; height: number; origin: { x: number; y: number }; scale: number }

export class HelperError extends Error {}

export function helperPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../resources/deskdock-helper.exe"),
    path.resolve(here, "../../resources/deskdock-helper.exe"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`deskdock-helper.exe not found; run "npm run build:helper". Looked in: ${candidates.join(", ")}`);
  return found;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class Helper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private exe: string = helperPath()) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const p = spawn(this.exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    p.stderr.on("data", (d) => process.stderr.write(`[deskdock-helper] ${d}`));
    const rl = createInterface({ input: p.stdout });
    rl.on("line", (line) => {
      let msg: { id: number; ok: boolean; result?: unknown; error?: string };
      try { msg = JSON.parse(line); } catch { process.stderr.write(`[deskdock-helper] bad line: ${line.slice(0, 200)}\n`); return; }
      const pend = this.pending.get(msg.id);
      if (!pend) return;
      this.pending.delete(msg.id);
      clearTimeout(pend.timer);
      msg.ok ? pend.resolve(msg.result) : pend.reject(new HelperError(msg.error ?? "unknown helper error"));
    });
    p.on("exit", (code) => {
      for (const [, pend] of this.pending) { clearTimeout(pend.timer); pend.reject(new HelperError(`helper exited with code ${code}`)); }
      this.pending.clear();
      this.proc = null;
    });
    this.proc = p;
    return p;
  }

  /** Calls are serialized: the helper handles one request at a time, and input injection must not interleave. */
  call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    const run = () => new Promise<T>((resolve, reject) => {
      const p = this.ensure();
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError(`${op} timed out after ${timeoutMs} ms`));
        // A hung helper (usually a UIA call stuck inside an app) is restarted so the next call works.
        try { p.kill(); } catch { /* ignore */ }
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin.write(JSON.stringify({ id, op, args }) + "\n");
    });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    if (this.proc) { try { this.proc.stdin.end(); } catch { /* ignore */ } }
  }
}
