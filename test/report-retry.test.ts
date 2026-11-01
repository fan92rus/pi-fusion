/**
 * FR-007 — the report retry (design rev.5.2 §4 "Report retry", TD-004,
 * roles §4.5): a schemaFailed first attempt triggers EXACTLY ONE corrective
 * request to the SAME model — report-only, carrying the re-rendering
 * context: the task's brief (the same render attempt 1 got) and, when the
 * engine saw a value, the size-limited JSON of the rejected answer (B3).
 * Re-implementation, new check runs and fabricated fields stay forbidden
 * (B4). While the corrective runs, the caller holds the worker's slot.
 *
 * The retry is a NEW attempt-scoped run: nodeId <task.id>#a2 (the requestId
 * carries -a2-), so the bridge's per-attempt node identity cannot answer
 * duplicate_node (B-3-R5). Retry timeout = min(120s, the task's attempt-1
 * timeoutMs). A second schema failure is terminal: failed + schemaMissing:
 * true, attempts = 2 — and the FR-011 rate-limit window never grows for
 * schema-missing (Q-002). usage/turns sum across BOTH runs (FR-010);
 * absence stays unknown.
 *
 * Runs against the REAL seam client over the fake delegation bus
 * (test/fake-pi.ts) — the same path production takes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FanoutDeps, runFanout } from "../extensions/pi-fusion/pool/fanout.ts";
import {
  correctiveRequest,
  RETRY_TIMEOUT_MS,
  type ReportRetryOutcome,
  runReportRetry,
  type SchemaFailedOutcome,
} from "../extensions/pi-fusion/report/retry.ts";
import { violatedFields } from "../extensions/pi-fusion/report/validate.ts";
import {
  createFanoutSeamClient,
  type FanoutSeamClient,
} from "../extensions/pi-fusion/seam/client.ts";
import {
  createFakePi,
  type DelegationStatus,
  type DelegationUsage,
  type FakePi,
  type RespondOverrides,
} from "./fake-pi.ts";

const TOOL_BLOCK = ["fusion_delegate", "subagent", "codemode"];

/** The attempt-1 brief, carried into the corrective as context (§4.5.1, B3). */
const BRIEF = "REAL BRIEF";

const USAGE_A: DelegationUsage = {
  input: 1000,
  output: 200,
  cacheRead: 300,
  cacheWrite: 40,
  cost: 0.25,
  turns: 4,
  toolCalls: 7,
  durationMs: 9000,
};

const USAGE_B: DelegationUsage = {
  input: 2000,
  output: 500,
  cacheRead: 100,
  cacheWrite: 10,
  cost: 0.75,
  turns: 6,
  toolCalls: 0,
  durationMs: 0,
};

const GOOD_REPORT = {
  status: "done",
  summary: "landed",
  filesChanged: ["src/a.ts"],
  evidence: ["tests green"],
  residualRisks: [],
};

/** needs_orchestrator without question — the host's if/then refuses it. */
const BAD_REPORT = {
  status: "needs_orchestrator",
  summary: "stuck",
  filesChanged: ["src/a.ts"],
  evidence: [],
  residualRisks: [],
};

/** violatedFields() of BAD_REPORT — what the corrective request must name. */
const BAD_FIELDS = violatedFields(BAD_REPORT);

interface Ctx {
  pi: FakePi;
  client: FanoutSeamClient;
}

let ctx: Ctx;

beforeEach(() => {
  const pi = createFakePi();
  ctx = { pi, client: createFanoutSeamClient({ events: pi.events, cwd: "/repo" }) };
});

afterEach(() => {
  ctx.client.dispose();
  ctx.pi.host.dispose();
});

/** Drains the microtask chain (settle → corrective :request). */
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function lastRequest() {
  const request = ctx.pi.host.requests.at(-1);
  if (!request) throw new Error("no request reached the bus");
  return request;
}

/** Runs attempt 1 and terminally answers it structured_output_failed. */
async function schemaFailedFirstAttempt(
  opts: { usage?: DelegationUsage | undefined } = { usage: USAGE_A },
): Promise<SchemaFailedOutcome> {
  const promise = ctx.client.run({
    nodeId: "task-1#a1",
    task: BRIEF,
    role: "worker",
    model: "model-a",
    timeoutMs: 60_000,
    hardToolBudget: 120,
  });
  const first = lastRequest();
  ctx.pi.host.respond(first.requestId, {
    status: "structured_output_failed",
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  });
  const outcome = await promise;
  if (outcome.kind !== "schemaFailed") {
    throw new Error(`expected schemaFailed, got ${JSON.stringify(outcome.kind)}`);
  }
  return outcome;
}

type TerminalOverrides = RespondOverrides & {
  status?: Exclude<DelegationStatus, "invalid_request">;
};

/** schemaFailed attempt 1 + corrective attempt 2 answered with `overrides`. */
async function retryAnsweredWith(
  overrides: TerminalOverrides,
  opts: { firstUsage?: DelegationUsage | undefined } = { firstUsage: USAGE_A },
): Promise<ReportRetryOutcome> {
  const first = await schemaFailedFirstAttempt({ usage: opts.firstUsage });
  const retry = runReportRetry(ctx.client, {
    taskId: "task-1",
    role: "worker",
    brief: BRIEF,
    firstOutcome: first,
    model: "model-a",
    violatedFields: BAD_FIELDS,
    attemptTimeoutMs: 60_000,
    hardToolBudget: 120,
  });
  await tick();
  const second = lastRequest();
  ctx.pi.host.respond(second.requestId, overrides);
  return retry;
}

describe("correctiveRequest (design §4.5 report-only wording)", () => {
  const base = { role: "worker" as const, brief: BRIEF };

  it("names the violated fields, the brief, and demands report-only output", () => {
    const text = correctiveRequest({
      ...base,
      violated: ["filesChanged", "question"],
      rejectedJson: JSON.stringify({ filesChanged: ["a.ts"] }),
    });
    expect(text).toContain("нарушал ролевую схему (worker): filesChanged, question");
    expect(text).toContain(BRIEF);
    expect(text).toContain("Реализацию не повторять");
    expect(text).toContain("Поля, которые контекст не подтверждает, оставь пустыми");
  });

  it("host-refused: no rejected answer exists and the corrective says so honestly", () => {
    // The host-refused path (structured_output_failed) reaches the engine
    // without the rejected value — the retry must still happen, and the
    // child must not pretend work it never saw (review fix M4: status and
    // summary are derived from the brief alone, never asserted).
    const text = correctiveRequest({ ...base, violated: [] });
    expect(text).toContain("его содержание неизвестно");
    expect(text).not.toContain("работа уже выполнена");
    expect(text).toContain("status и summary выводи только из брифа");
    expect(text).toContain("предыдущий ответ недоступен");
    expect(text).toContain("Реализацию не повторять");
    expect(text).toContain("ОТВЕТ ПРЕДЫДУЩЕЙ ПОПЫТКИ");
    expect(text).toContain("недоступен (хост отказал до движка");
  });

  it("rejected answer attached as JSON with the отклонён marker (B3)", () => {
    const text = correctiveRequest({
      ...base,
      violated: ["question"],
      rejectedJson: '{"status":"needs_orchestrator"}',
    });
    expect(text).toContain("ОТВЕТ ПРЕДЫДУЩЕЙ ПОПЫТКИ (отклонён по схеме");
    expect(text).toContain('{"status":"needs_orchestrator"}');
    expect(text).toContain("Реализацию не повторять");
  });
});

describe("retry trigger (FR-007)", () => {
  it("structured_output_failed → exactly ONE corrective request to the SAME model", async () => {
    const first = await schemaFailedFirstAttempt();
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: first,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 60_000,
      hardToolBudget: 120,
    });
    await tick();

    expect(ctx.pi.host.requests).toHaveLength(2); // start + the one retry
    const second = lastRequest();
    expect(second.nodeId).toBe("task-1#a2");
    expect(second.requestId).toMatch(/^fusion-task-1-a2-\d+-\d+$/);
    expect(second.model).toBe("model-a"); // the same model as attempt 1
    expect(second.task).toBe(
      correctiveRequest({ role: "worker", brief: BRIEF, violated: BAD_FIELDS }),
    );
    // Host-refused attempt 1: no rejected value exists — the corrective says so.
    expect(second.task).toContain("предыдущий ответ недоступен");
    expect(second.toolBudget).toEqual({ hard: 120, block: TOOL_BLOCK });

    ctx.pi.host.respond(second.requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
      usage: USAGE_B,
    });
    const outcome = await retry;
    expect(outcome.result).toMatchObject({
      id: "task-1",
      status: "done",
      summary: "landed",
      filesChanged: ["src/a.ts"],
      attempts: 2,
    });
  });

  it("fields and the rejected value come from the completed-but-violating answer (B3)", async () => {
    // The client maps a completed answer whose value violates the schema onto
    // schemaFailed too — and delivers the size-limited JSON of exactly that
    // value (rejectedJson) so the fresh retry child can re-render honestly.
    const promise = ctx.client.run({
      nodeId: "task-1#a1",
      task: BRIEF,
      role: "worker",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const first = lastRequest();
    ctx.pi.host.respond(first.requestId, {
      result: { kind: "structured", value: BAD_REPORT },
    });
    const outcome = await promise;
    if (outcome.kind !== "schemaFailed") {
      throw new Error(`expected schemaFailed, got ${JSON.stringify(outcome.kind)}`);
    }

    expect(BAD_FIELDS).toEqual(["question"]); // the if/then rule, from report/validate
    expect(outcome.rejectedJson).toBe(JSON.stringify(BAD_REPORT)); // the value the engine saw
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: outcome,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 60_000,
      hardToolBudget: 120,
    });
    await tick();
    const second = lastRequest();
    expect(second.task).toBe(
      correctiveRequest({
        role: "worker",
        brief: BRIEF,
        violated: BAD_FIELDS,
        rejectedJson: outcome.rejectedJson,
      }),
    );
    expect(second.task).toContain('{"status":"needs_orchestrator"');

    ctx.pi.host.respond(second.requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
    });
    const fixed = await retry;
    expect(fixed.result.status).toBe("done");
  });

  it("role fields survive the retry: scout sources and reviewer verdict land in the row (B3)", async () => {
    for (const [role, report, expected] of [
      [
        "scout",
        { ...GOOD_REPORT, sources: ["src/a.ts:12 entry"] },
        { sources: ["src/a.ts:12 entry"] },
      ],
      [
        "reviewer",
        { ...GOOD_REPORT, findings: ["pin drift"], checksRun: ["npm test"], verdict: "fail" },
        { findings: ["pin drift"], checksRun: ["npm test"], verdict: "fail" },
      ],
    ] as const) {
      const first = await schemaFailedFirstAttempt();
      const retry = runReportRetry(ctx.client, {
        taskId: "task-1",
        role,
        brief: BRIEF,
        firstOutcome: first,
        model: "model-a",
        violatedFields: BAD_FIELDS,
        attemptTimeoutMs: 60_000,
        hardToolBudget: 120,
      });
      await tick();
      ctx.pi.host.respond(lastRequest().requestId, {
        result: { kind: "structured", value: report },
      });
      const outcome = await retry;
      expect(outcome.result).toMatchObject({ status: "done", attempts: 2, ...expected });
    }
  });

  it("a worker report carries no role fields into the row", async () => {
    const outcome = await retryAnsweredWith({
      result: { kind: "structured", value: GOOD_REPORT },
    });
    expect(outcome.result.sources).toBeUndefined();
    expect(outcome.result.verdict).toBeUndefined();
  });
});

describe("slot held across the retry (TD-004)", () => {
  it("the corrective run starts at once, resolves only after attempt 2, and never :cancels", async () => {
    const first = await schemaFailedFirstAttempt();
    let settled = false;
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: first,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 60_000,
      hardToolBudget: 120,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await tick();

    // The corrective run is in flight on the held slot: nothing resolved
    // early, nothing else was dispatched, and the slot was never forcibly
    // released with a :cancel.
    expect(settled).toBe(false);
    expect(ctx.pi.host.requests).toHaveLength(2);
    expect(ctx.pi.host.pendingRequestIds()).toHaveLength(1);
    expect(ctx.pi.host.cancels).toHaveLength(0);

    ctx.pi.host.respond(lastRequest().requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
      usage: USAGE_B,
    });
    const outcome = await retry;
    expect(settled).toBe(true);
    expect(outcome.result.attempts).toBe(2);
  });
});

describe("retry timeout = min(120s, task timeoutMs)", () => {
  it("keeps a smaller attempt timeout", async () => {
    const first = await schemaFailedFirstAttempt();
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: first,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 30_000,
      hardToolBudget: 120,
    });
    await tick();
    expect(lastRequest().timeoutMs).toBe(30_000);

    ctx.pi.host.respond(lastRequest().requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
    });
    await retry;
  });

  it("caps a longer attempt timeout at RETRY_TIMEOUT_MS", async () => {
    expect(RETRY_TIMEOUT_MS).toBe(120_000);
    const first = await schemaFailedFirstAttempt();
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: first,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 600_000,
      hardToolBudget: 120,
    });
    await tick();
    expect(lastRequest().timeoutMs).toBe(120_000);

    ctx.pi.host.respond(lastRequest().requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
    });
    await retry;
  });
});

describe("second failure is terminal (FR-007)", () => {
  it("a second schemaFailed → failed + schemaMissing:true, attempts=2", async () => {
    const outcome = await retryAnsweredWith({
      status: "structured_output_failed",
      usage: USAGE_B,
    });
    expect(outcome.result).toMatchObject({
      id: "task-1",
      status: "failed",
      error: "schema-missing",
      schemaMissing: true,
      attempts: 2,
    });
  });

  it("the FR-011 window counter does not grow for schema-missing (Q-002)", async () => {
    // The terminal row carries the non-window code (not a host:failed /
    // rate-limit mark), and no third run happens the window could be fed with.
    const outcome = await retryAnsweredWith({ status: "structured_output_failed" });
    expect(outcome.result.error).toBe("schema-missing");
    expect(outcome.result.schemaMissing).toBe(true);
    expect(ctx.pi.host.requests).toHaveLength(2);
    expect(ctx.pi.host.cancels).toHaveLength(0);
  });
});

describe("attempt identity (B-3-R5)", () => {
  it("the attempt-specific nodeId cannot trip duplicate_node", async () => {
    const first = await schemaFailedFirstAttempt();
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: first,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 60_000,
      hardToolBudget: 120,
    });
    await tick();
    const second = lastRequest();
    expect(second.nodeId).not.toBe(ctx.pi.host.requests[0]?.nodeId);
    expect(second.requestId).toContain("-a2-");
    // The fake bridge registered the corrective run as pending — it was NOT
    // auto-answered duplicate_node.
    expect(ctx.pi.host.getPending(second.requestId)).toBeDefined();
    expect(ctx.pi.host.responses.some((r) => r.status === "duplicate_node")).toBe(false);

    ctx.pi.host.respond(second.requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
    });
    const outcome = await retry;
    expect(outcome.result.status).toBe("done");
  });
});

describe("usage/turns aggregation (FR-010)", () => {
  it("sums usage over BOTH runs; result.turns is Σ terminal turns", async () => {
    const outcome = await retryAnsweredWith({
      result: { kind: "structured", value: GOOD_REPORT },
      usage: USAGE_B,
    });
    expect(outcome.usage).toEqual({
      input: 3000,
      output: 700,
      cacheRead: 400,
      cacheWrite: 50,
      cost: 1,
      turns: 10,
      toolCalls: 7,
      durationMs: 9000,
    });
    expect(outcome.result.turns).toBe(10);
  });

  it("absence stays unknown: no usage on either run → usage/turns undefined", async () => {
    const outcome = await retryAnsweredWith(
      { result: { kind: "structured", value: GOOD_REPORT } },
      { firstUsage: undefined },
    );
    expect(outcome.usage).toBeUndefined();
    expect(outcome.result.turns).toBeUndefined();
  });

  it("attempt-2 :update snapshots feed turnsObserved and onProgress", async () => {
    const first = await schemaFailedFirstAttempt({ usage: undefined });
    const seen: number[] = [];
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: first,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 60_000,
      hardToolBudget: 120,
      onProgress: (snapshot) => {
        seen.push(snapshot.turns);
      },
    });
    await tick();
    const second = lastRequest();
    ctx.pi.host.update(second.requestId, {
      usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, turns: 5 },
    });
    ctx.pi.host.respond(second.requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
      usage: USAGE_B,
    });
    const outcome = await retry;
    expect(seen).toEqual([5]);
    expect(outcome.result.turnsObserved).toBe(5);
    // attempt 1 had no usage; the seam client maps toolCalls/durationMs 0 to
    // "no data" and drops those keys.
    expect(outcome.usage).toEqual({
      input: 2000,
      output: 500,
      cacheRead: 100,
      cacheWrite: 10,
      cost: 0.75,
      turns: 6,
    });
  });
});

describe("every terminal shape of attempt 2 maps honestly (attempts=2)", () => {
  it.each([
    ["timed_out", { status: "failed", error: "timeout" }],
    ["interrupted", { status: "failed", error: "interrupted" }],
    ["unavailable_context", { status: "failed", error: "seam-unavailable" }],
    ["failed", { status: "failed", error: "host:failed" }],
    ["tool_budget_exhausted", { status: "failed", error: "max_steps" }],
  ] as const)("attempt 2 answers %s → %j", async (status, expected) => {
    const outcome = await retryAnsweredWith({ status });
    expect(outcome.result).toMatchObject({ id: "task-1", attempts: 2, ...expected });
  });

  it("a window-class 429 ON the retry stays an honest host:failed row", async () => {
    // The retry itself never feeds the window counter (schema-missing does
    // not exist as a window event); a REAL quota error from attempt 2 is
    // faithfully reported for the caller's accounting.
    const outcome = await retryAnsweredWith({
      status: "failed",
      error: "Rate limit exceeded for this key",
    });
    expect(outcome.result).toMatchObject({ status: "failed", error: "host:failed", attempts: 2 });
  });

  it("dispose during the retry resolves cancelled with attempts=2", async () => {
    const first = await schemaFailedFirstAttempt();
    const retry = runReportRetry(ctx.client, {
      taskId: "task-1",
      role: "worker",
      brief: BRIEF,
      firstOutcome: first,
      model: "model-a",
      violatedFields: BAD_FIELDS,
      attemptTimeoutMs: 60_000,
      hardToolBudget: 120,
    });
    await tick();
    ctx.client.dispose();
    const outcome = await retry;
    expect(outcome.result).toMatchObject({ id: "task-1", status: "cancelled", attempts: 2 });
  });

  it("a good second report carries its needs_orchestrator question", async () => {
    const outcome = await retryAnsweredWith({
      result: {
        kind: "structured",
        value: {
          status: "needs_orchestrator",
          question: "which API?",
          summary: "blocked",
          filesChanged: [],
          evidence: [],
          residualRisks: [],
        },
      },
    });
    expect(outcome.result).toMatchObject({
      status: "needs_orchestrator",
      question: "which API?",
      attempts: 2,
    });
  });
});

describe("fanout integration (the production caller of runReportRetry)", () => {
  it("runFanout retries a completed-but-invalid report with the exact violatedFields(BAD_REPORT) in the corrective brief", async () => {
    // Regression: the pool's schemaFailed handler must forward the fields the
    // seam client retained from the rejected report — NOT a hard-coded [].
    const deps: FanoutDeps = {
      contract: {
        tasks: [
          {
            id: "task-1",
            title: "task-1",
            instructions: "instructions for task-1",
            role: "worker",
          },
        ],
      },
      config: {
        workers: 1,
        maxParallel: 1,
        taskTimeoutMs: 60_000,
        workerModels: ["model-a"],
        maxSteps: 100,
      },
      available: () => true,
      makeClient: () => ctx.client, // the REAL seam client over the fake bus
    };
    const fanout = runFanout(deps);
    await tick();

    // Attempt 1 COMPLETES with a value that violates the schema (the
    // needs_orchestrator if/then rule) — the production path, not the
    // host-refused structured_output_failed one.
    const first = lastRequest();
    expect(first.nodeId).toBe("task-1#a1");
    ctx.pi.host.respond(first.requestId, {
      result: { kind: "structured", value: BAD_REPORT },
    });
    await tick();

    // The corrective attempt 2 must name EXACTLY violatedFields(BAD_REPORT).
    expect(BAD_FIELDS).toEqual(["question"]); // the if/then rule, from report/validate
    expect(ctx.pi.host.requests).toHaveLength(2);
    const second = lastRequest();
    expect(second.nodeId).toBe("task-1#a2");
    expect(second.model).toBe("model-a"); // the SAME model (FR-007)
    // The brief the corrective carries is the SAME render attempt 1 got:
    // title + instructions, no contract, no captured request.
    expect(second.task).toBe(
      correctiveRequest({
        role: "worker",
        brief: "## task-1\n\ninstructions for task-1",
        violated: BAD_FIELDS,
        rejectedJson: JSON.stringify(BAD_REPORT),
      }),
    );

    ctx.pi.host.respond(second.requestId, {
      result: { kind: "structured", value: GOOD_REPORT },
    });
    const result = await fanout;
    if (!("results" in result)) throw new Error("expected FanoutResult");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ id: "task-1", status: "done", attempts: 2 });
  });
});
