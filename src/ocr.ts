// Offline OCR via the Windows.Media.Ocr engine that ships with Windows 10/11, driven through a resident
// Windows PowerShell 5.1 worker (resources/ocr.ps1). One JSON request per line in, one JSON line out.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface OcrWord { t: string; x: number; y: number; w: number; h: number }
export interface OcrLine { text: string; x: number; y: number; w: number; h: number; words: OcrWord[] }
export interface OcrResult { ok: true; ms: number; lang: string; angle: number | null; lines: OcrLine[] }

export class OcrError extends Error {}

function scriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.resolve(here, "../resources/ocr.ps1"), path.resolve(here, "../../resources/ocr.ps1")]) if (existsSync(p)) return p;
  throw new OcrError("resources/ocr.ps1 not found");
}

/** ASCII-only scratch dir: the worker receives paths over stdin and non-ASCII paths are not reliable there. */
export function scratchDir(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".";
  const dir = path.join(base, "Temp", "deskdock");
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Pending = { resolve: (v: OcrResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class Ocr {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<string[]> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  languages: string[] = [];

  private start(): Promise<string[]> {
    if (this.proc && this.proc.exitCode === null && this.ready) return this.ready;
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath()], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = p;
    p.stderr.on("data", (d) => process.stderr.write(`[deskdock-ocr] ${d}`));
    p.on("error", () => { /* handled through the exit path below */ });
    p.stdin.on("error", () => { /* a dead worker is replaced on the next call */ });
    this.ready = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new OcrError("OCR worker did not start within 20 s"));
        try { p.kill(); } catch { /* ignore */ }
        if (this.proc === p) { this.proc = null; this.ready = null; }
      }, 20000);
      const rl = createInterface({ input: p.stdout });
      rl.on("line", (line) => {
        let msg: { ready?: boolean; languages?: string[]; id?: number; ok?: boolean; error?: string } & Partial<OcrResult>;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { clearTimeout(timer); this.languages = msg.languages ?? []; resolve(this.languages); return; }
        const pend = this.pending.get(msg.id ?? -1);
        if (!pend) return;
        this.pending.delete(msg.id!);
        clearTimeout(pend.timer);
        msg.ok ? pend.resolve(msg as OcrResult) : pend.reject(new OcrError(msg.error ?? "OCR failed"));
      });
      p.on("exit", (code) => {
        clearTimeout(timer);
        reject(new OcrError(`OCR worker exited with code ${code}`));
        for (const [, pend] of this.pending) { clearTimeout(pend.timer); pend.reject(new OcrError("OCR worker exited")); }
        this.pending.clear();
        if (this.proc === p) { this.proc = null; this.ready = null; }
      });
    });
    return this.ready;
  }

  /** Recognize text in a PNG file. Serialized: the worker handles one image at a time. */
  recognizeFile(pngPath: string, lang?: string, timeoutMs = 15000): Promise<OcrResult> {
    const run = async () => {
      await this.start();
      const p = this.proc!;
      return new Promise<OcrResult>((resolve, reject) => {
        const id = this.nextId++;
        const timer = setTimeout(() => { this.pending.delete(id); reject(new OcrError(`OCR timed out after ${timeoutMs} ms`)); try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        // the path travels base64-encoded: stdin text encoding is unreliable for non-ASCII paths (Chinese user names)
        p.stdin.write(JSON.stringify({ id, pathB64: Buffer.from(pngPath, "utf8").toString("base64"), lang: lang ?? null }) + "\n");
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Recognize a PNG held in memory (written to the ASCII scratch dir and deleted afterwards). */
  async recognizePng(png: Buffer, lang?: string): Promise<OcrResult> {
    const file = path.join(scratchDir(), `ocr-${process.pid}-${Date.now()}-${this.nextId}.png`);
    writeFileSync(file, png);
    try { return await this.recognizeFile(file, lang); }
    finally { try { unlinkSync(file); } catch { /* ignore */ } }
  }

  close(): void { if (this.proc) { try { this.proc.stdin.end(); } catch { /* ignore */ } } }
}

/** Map OCR lines from image pixels back to screen coordinates. */
export function toScreen(lines: OcrLine[], scale: number, origin: { x: number; y: number }): OcrLine[] {
  const f = (v: number) => Math.round(v / scale);
  return lines.map((l) => ({
    text: l.text, x: f(l.x) + origin.x, y: f(l.y) + origin.y, w: f(l.w), h: f(l.h),
    words: l.words.map((w) => ({ t: w.t, x: f(w.x) + origin.x, y: f(w.y) + origin.y, w: f(w.w), h: f(w.h) })),
  }));
}

export function formatOcr(lines: OcrLine[], header: string): string {
  const out = [header, `Lines: ${lines.length}`];
  for (const l of lines) {
    const cx = l.x + Math.round(l.w / 2), cy = l.y + Math.round(l.h / 2);
    out.push(`${JSON.stringify(l.text)} @(${l.x},${l.y} ${l.w}x${l.h}) center=(${cx},${cy})`);
  }
  if (lines.length === 0) out.push("No text recognized. The area may be empty, an image, or the text too small; try a window screenshot with a larger maxEdge.");
  return out.join("\n");
}
