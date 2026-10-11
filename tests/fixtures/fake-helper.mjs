// A stand-in for deskdock-helper.exe: answers ping, echoes other ops, and never answers "hang".
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "hang") return; // simulate a UIA call stuck inside an app
  if (req.op === "fail") { process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: "simulated failure" }) + "\n"); return; }
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { pong: req.op === "ping", pid: process.pid, echo: req.args ?? {} } }) + "\n");
});
