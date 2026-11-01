/**
 * Live smoke for the pi-fusion extension (bd pi-fusion-d7g, T16). Run OUTSIDE
 * `npm test`:
 *
 *   node --experimental-strip-types scripts/smoke/live-smoke.mts
 *
 * Phases (each spawns a real `pi --mode json` process with this repo's
 * extension loaded via `-e`):
 *   A. exposure-off  — fusion disabled  → the lead does NOT have fusion_delegate.
 *   B. exposure-on   — fusion enabled   → the lead HAS fusion_delegate.
 *   C. fanout        — one fusion_delegate call, 2 real worker tasks on a
 *                      generated smoke repo: workers write reports, the lead
 *                      must not successfully call write/edit/bash, the tool
 *                      result carries a summary and usage.
 *   D. degradation   — workerModels []  → the whole call fails up front with
 *                      per-task rows carrying the no-available-model error
 *                      (B-FINAL: nothing launches, nothing is hidden).
 *
 * The phases mutate the REAL pi agent dir's fusion.json (backup/restore in
 * `finally`) and install the shipped fusion-worker agent (idempotent,
 * version-pinned). Exit code 0 iff every phase passes.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFusionWorkerAgent } from "../../extensions/pi-fusion/worker-install.ts";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXTENSION_DIR = join(REPO_ROOT, "extensions", "pi-fusion");
const SMOKE_REPO = join(REPO_ROOT, "smoke-repo");
const LEAD_MODEL = process.env.SMOKE_LEAD_MODEL ?? "zai-coding-cn/glm-5.3-flash";
const WORKER_MODELS = (process.env.SMOKE_WORKER_MODELS ?? "zai-coding-cn/glm-5.3-flash").split(",");

interface PhaseResult {
  phase: string;
  ok: boolean;
  detail: string;
}

interface JsonRecord {
  type: string;
  [key: string]: unknown;
}

interface Captured {
  records: JsonRecord[];
  stdout: string;
  stderr: string;
  code: number | null;
}

function agentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const configured = process.env.PI_CODING_AGENT_DIR;
  // Mirrors config.ts resolveAgentDir exactly: the smoke must back up and
  // restore the same file the extension reads.
  if (configured === "~") return home;
  if (configured !== undefined && configured.length > 0) {
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
      return join(home, configured.slice(2));
    }
    return configured;
  }
  return join(home, ".pi", "agent");
}

/** One `pi --mode json` run: the prompt goes in via stdin, JSONL comes out. */
function runPi(cwd: string, prompt: string, timeoutMs: number): Promise<Captured> {
  return new Promise((resolve) => {
    const args = [
      "pi",
      "--mode",
      "json",
      "--no-session",
      "--model",
      LEAD_MODEL,
      "-e",
      EXTENSION_DIR,
      "-p",
    ];
    const child = spawn(args.join(" "), {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let done = false;
    const timer = setTimeout(() => {
      if (!done && child.pid !== undefined) {
        spawn(`taskkill /PID ${child.pid} /T /F`, { shell: true, windowsHide: true });
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8");
      const records: JsonRecord[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          records.push(JSON.parse(trimmed) as JsonRecord);
        } catch {
          // Non-JSON line: diagnostics may share stdout on crash — ignore.
        }
      }
      resolve({
        records,
        stdout: text,
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ─── event helpers ─────────────────────────────────────────────────────────

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function toolCallsOf(records: JsonRecord[]): ToolCallBlock[] {
  const calls: ToolCallBlock[] = [];
  for (const record of records) {
    if (record.type !== "message_end") continue;
    const message = record.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "toolCall") {
        calls.push(block as unknown as ToolCallBlock);
      }
    }
  }
  return calls;
}

interface ToolResultShape {
  toolCallId?: string;
  toolName: string;
  isError: boolean;
  details?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

function toolResultsOf(records: JsonRecord[]): ToolResultShape[] {
  const results: ToolResultShape[] = [];
  for (const record of records) {
    if (record.type !== "message_end") continue;
    const message = record.message as { role?: string } | undefined;
    if (message?.role === "toolResult") {
      results.push(message as unknown as ToolResultShape);
    }
    const turnEnd = record as { toolResults?: ToolResultShape[] };
    if (Array.isArray(turnEnd.toolResults)) results.push(...turnEnd.toolResults);
  }
  return results;
}

function finalTextOf(records: JsonRecord[]): string {
  let text = "";
  for (const record of records) {
    if (record.type !== "message_end") continue;
    const message = record.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
    }
  }
  return text;
}

// ─── fixture helpers ───────────────────────────────────────────────────────

function writeFusionConfig(dir: string, fields: Record<string, unknown>): void {
  const canonical = {
    enabled: false,
    workers: 2,
    maxParallel: 2,
    taskTimeoutMs: 180_000,
    workerModels: [] as string[],
    maxSteps: 40,
    requireApproval: false,
    blockedTools: ["fusion_delegate", "subagent", "codemode"],
    leadBlockedTools: ["write", "edit", "bash"],
    ...fields,
  };
  writeFileSync(join(dir, "fusion.json"), `${JSON.stringify(canonical, null, 2)}\n`, "utf8");
}

function makeSmokeRepo(): void {
  rmSync(SMOKE_REPO, { recursive: true, force: true });
  mkdirSync(join(SMOKE_REPO, "src"), { recursive: true });
  writeFileSync(join(SMOKE_REPO, "src", "a.txt"), A_CONTENT, "utf8");
  writeFileSync(join(SMOKE_REPO, "src", "b.txt"), B_CONTENT, "utf8");
}

/** The fixtures every phase and every expectation derives from. */
const A_CONTENT = "alpha beta gamma delta\n";
const B_CONTENT = "echo foxtrot golf hotel\n";

// ─── phases ────────────────────────────────────────────────────────────────

const EXPOSURE_PROMPT =
  "Reply with ONLY a comma-separated list of the exact tool names you can call right now. No other words.";

async function phaseExposure(dir: string, enabled: boolean): Promise<PhaseResult> {
  writeFusionConfig(dir, { enabled });
  const run = await runPi(SMOKE_REPO, EXPOSURE_PROMPT, 180_000);
  const text = finalTextOf(run.records);
  const present = text.includes("fusion_delegate");
  if (run.records.length === 0) {
    return { phase: enabled ? "B-exposure-on" : "A-exposure-off", ok: false, detail: `no JSON events (exit ${run.code}); stderr: ${run.stderr.slice(0, 300)}` };
  }
  return {
    phase: enabled ? "B-exposure-on" : "A-exposure-off",
    ok: present === enabled,
    detail: `fusion_delegate ${present ? "present" : "absent"} in ${text.length} chars of final text`,
  };
}

const FANOUT_PROMPT = [
  "Call the fusion_delegate tool exactly once with two tasks:",
  "task id upper-a: read src/a.txt and write its content converted to UPPERCASE to reports/a-upper.txt (create the reports directory);",
  "task id copy-b: read src/b.txt and write an unchanged copy of its content to reports/b-copy.txt.",
  "Do the work only through the workers; after the tool returns reply with one line per task: id colon status.",
].join(" ");

async function phaseFanout(dir: string): Promise<PhaseResult[]> {
  writeFusionConfig(dir, { enabled: true, workerModels: WORKER_MODELS });
  const run = await runPi(SMOKE_REPO, FANOUT_PROMPT, 480_000);
  const phases: PhaseResult[] = [];
  const call = toolCallsOf(run.records).find((c) => c.name === "fusion_delegate");
  phases.push({
    phase: "C1-tool-called",
    ok: call !== undefined,
    detail: call === undefined ? "fusion_delegate was never called" : `arguments: ${JSON.stringify(call.arguments).slice(0, 160)}`,
  });
  const result = toolResultsOf(run.records).find((r) => r.toolName === "fusion_delegate");
  const details = typeof result?.details === "string" ? result.details : "";
  const tasksDone = /2 task\(s\): 2 done/.test(details);
  phases.push({
    phase: "C2-two-done",
    ok: result !== undefined && !result.isError && tasksDone,
    detail: result === undefined ? "no fusion_delegate tool result" : `isError=${String(result.isError)} details=${details.slice(0, 120)}`,
  });
  // A leak is a lead write/edit/bash whose own tool result is NOT an error —
  // blocked attempts (isError=true) are the gate working, not a violation.
  const leadWriteCalls = toolCallsOf(run.records).filter((c) => ["write", "edit", "bash"].includes(c.name));
  const resultsByCallId = new Map(
    toolResultsOf(run.records)
      .filter((r) => typeof r.toolCallId === "string")
      .map((r) => [r.toolCallId as string, r]),
  );
  const leaks = leadWriteCalls.filter((call) => {
    const result = resultsByCallId.get(call.id);
    return result !== undefined && result.isError !== true;
  });
  phases.push({
    phase: "C3-lead-hands-off",
    ok: leaks.length === 0,
    detail: `lead write/edit/bash attempts: ${leadWriteCalls.length}, unblocked leaks: ${leaks.length}`,
  });
  const usage = (result as unknown as { usage?: Record<string, unknown> } | undefined)?.usage;
  phases.push({
    phase: "C4-usage-summed",
    ok: usage !== undefined && typeof usage.totalTokens === "number",
    detail: usage === undefined ? "no usage on the tool result" : `usage: ${JSON.stringify(usage).slice(0, 120)}`,
  });
  const upper = existsSync(join(SMOKE_REPO, "reports", "a-upper.txt"))
    ? readFileSync(join(SMOKE_REPO, "reports", "a-upper.txt"), "utf8")
    : "";
  const copy = existsSync(join(SMOKE_REPO, "reports", "b-copy.txt"))
    ? readFileSync(join(SMOKE_REPO, "reports", "b-copy.txt"), "utf8")
    : "";
  phases.push({
    phase: "C5-worker-files",
    ok: upper === A_CONTENT.toUpperCase() && copy === B_CONTENT,
    detail: `a-upper=${JSON.stringify(upper.slice(0, 40))} b-copy=${JSON.stringify(copy.slice(0, 40))}`,
  });
  return phases;
}

async function phaseDegradation(dir: string): Promise<PhaseResult> {
  writeFusionConfig(dir, { enabled: true, workerModels: [] });
  const run = await runPi(SMOKE_REPO, FANOUT_PROMPT, 240_000);
  const result = toolResultsOf(run.records).find((r) => r.toolName === "fusion_delegate");
  const details = typeof result?.details === "string" ? result.details : "";
  const text = result?.content?.map((block) => block.text ?? "").join("") ?? "";
  // B-FINAL: an empty rotation fails the whole call with per-task rows, each
  // carrying the no-available-model error — nothing launches, nothing hidden.
  const honest =
    result !== undefined &&
    result.isError !== true &&
    /2 task\(s\): 2 failed/.test(details) &&
    text.includes("no available model left in the rotation");
  return {
    phase: "D-degradation",
    ok: honest,
    detail: result === undefined ? "no tool result" : `details=${details.slice(0, 120)} text=${text.slice(0, 160)}`,
  };
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const dir = agentDir();
  const configPath = join(dir, "fusion.json");
  const workerAgentPath = join(dir, "agents", "fusion-worker.md");
  const configBackup = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  const agentBackup = existsSync(workerAgentPath) ? readFileSync(workerAgentPath, "utf8") : undefined;
  const results: PhaseResult[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    installFusionWorkerAgent();
    makeSmokeRepo();
    results.push(await phaseExposure(dir, false));
    results.push(await phaseExposure(dir, true));
    results.push(...(await phaseFanout(dir)));
    results.push(await phaseDegradation(dir));
  } finally {
    if (configBackup === undefined) rmSync(configPath, { force: true });
    else writeFileSync(configPath, configBackup, "utf8");
    if (agentBackup === undefined) rmSync(workerAgentPath, { force: true });
    else writeFileSync(workerAgentPath, agentBackup, "utf8");
  }
  let allOk = true;
  for (const result of results) {
    if (!result.ok) allOk = false;
    console.log(`SMOKE ${result.phase}: ${result.ok ? "PASS" : "FAIL"} — ${result.detail}`);
  }
  console.log(`SMOKE TOTAL: ${allOk ? "PASS" : "FAIL"}`);
  return allOk ? 0 : 1;
}

process.exit(await main());
