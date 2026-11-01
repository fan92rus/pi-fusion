/**
 * Seam client (design rev.5.2 §5 Seam Protocol, FR-008/FR-009/FR-010).
 *
 * Gates covered: the 11-status table (one row per SubagentDelegationStatus
 * literal, compile-time exhaustive), grace → :cancel, dispose-resolve pending
 * as cancelled, ignore-after-dispose, window/overload markers (Q-002),
 * terminal-only usage with "0 = no data", per-attempt turnsObserved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerReportSchema } from "../extensions/pi-fusion/report/schema.ts";
import { isSeamAvailable } from "../extensions/pi-fusion/seam/availability.ts";
import {
  clipRejectedJson,
  createFanoutSeamClient,
  type FanoutSeamClient,
  REJECTED_VALUE_CHAR_LIMIT,
  SEAM_GRACE_MS,
  type SeamOutcome,
} from "../extensions/pi-fusion/seam/client.ts";
import type { ProgressSnapshot } from "../extensions/pi-fusion/types.ts";
import {
  createFakePi,
  DELEGATION_RESPONSE_EVENT,
  DELEGATION_UPDATE_EVENT,
  type DelegationResponse,
  type DelegationStatus,
  type DelegationUsage,
  type FakePi,
  type RespondOverrides,
} from "./fake-pi.ts";

const TOOL_BLOCK = ["fusion_delegate", "subagent", "codemode"];

const USAGE: DelegationUsage = {
  input: 1000,
  output: 200,
  cacheRead: 300,
  cacheWrite: 40,
  cost: 0.25,
  turns: 4,
  toolCalls: 7,
  durationMs: 9000,
};

const VALID_REPORT = {
  status: "done",
  summary: "ok",
  filesChanged: ["a.ts"],
  evidence: ["tests green"],
  residualRisks: [],
};

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
  vi.useRealTimers();
});

function runTask(
  overrides: Partial<{
    nodeId: string;
    timeoutMs: number;
    onProgress: (snapshot: ProgressSnapshot) => void;
  }> = {},
): Promise<SeamOutcome> {
  return ctx.client.run({
    nodeId: overrides.nodeId ?? "task-1#a1",
    task: "brief",
    role: "worker",
    model: "model-a",
    timeoutMs: overrides.timeoutMs ?? 60_000,
    hardToolBudget: 120,
    onProgress: overrides.onProgress,
  });
}

function lastRequest() {
  const request = ctx.pi.host.requests.at(-1);
  if (!request) throw new Error("no request reached the bus");
  return request;
}

describe("availability(pi)", () => {
  it("is true when pi.events exposes on + emit", () => {
    const { events } = createFakePi();
    expect(isSeamAvailable({ events })).toBe(true);
  });

  it("is false without an event bus", () => {
    expect(isSeamAvailable(undefined)).toBe(false);
    expect(isSeamAvailable({})).toBe(false);
    expect(isSeamAvailable({ events: null })).toBe(false);
    expect(isSeamAvailable({ events: { on: () => () => undefined } })).toBe(false);
  });
});

describe("request shape (§5 Seam Protocol)", () => {
  it("builds requestId/nodeId/ownerRunId and the fresh fusion-worker request", () => {
    void runTask({ nodeId: "task-1#a2" });
    const request = lastRequest();
    expect(request.requestId).toMatch(/^fusion-task-1-a2-\d+-\d+$/);
    expect(request.nodeId).toBe("task-1#a2");
    expect(request.ownerRunId).toMatch(/^fusion-\d+-\d+$/);
    expect(request).toMatchObject({
      agent: "fusion-worker",
      context: "fresh",
      cwd: "/repo",
      model: "model-a",
      timeoutMs: 60_000,
      task: "brief",
      toolBudget: { hard: 120, block: TOOL_BLOCK },
      result: { kind: "structured" },
    });
  });

  it("sends the report schema as plain JSON over the seam (live-smoke regression, bd pi-fusion-d7g)", () => {
    void runTask({ nodeId: "task-1#a1" });
    const request = lastRequest();
    // pi-subagents clones result.schema with a plain-JSON walker; TypeBox
    // artifacts (the if/then values of the report schema) must never reach
    // the wire, or every structured request is rejected as invalid.
    expect(request.result).toEqual({
      kind: "structured",
      schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
    });
  });

  it("keeps one ownerRunId per client and a fresh requestId per run", () => {
    void runTask({ nodeId: "task-1#a1" });
    void runTask({ nodeId: "task-2#a1" });
    const [first, second] = ctx.pi.host.requests;
    expect(first?.ownerRunId).toBe(second?.ownerRunId);
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it("rejects a nodeId that does not carry the #a<attempt> suffix", () => {
    expect(() => runTask({ nodeId: "task-1" })).toThrow(/#a<attempt>/);
    expect(ctx.pi.host.requests).toHaveLength(0);
  });
});

/**
 * One row per SubagentDelegationStatus literal. Record<DelegationStatus, …>
 * makes a missing or extra status a compile error.
 */
interface StatusRow {
  kind: SeamOutcome["kind"];
  code?: string;
  windowClass?: boolean;
  /** Whether the host's terminal response carries usage (usage passthrough). */
  carriesUsage: boolean;
  drive: (c: Ctx) => Promise<SeamOutcome>;
}

type TerminalStatus = Exclude<DelegationStatus, "invalid_request">;

const respondWith =
  (status: TerminalStatus, overrides: RespondOverrides = {}) =>
  (c: Ctx): Promise<SeamOutcome> => {
    const promise = c.client.run({
      nodeId: "task-1#a1",
      task: "brief",
      role: "worker",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const requestId = c.pi.host.requests.at(-1)?.requestId ?? "";
    c.pi.host.respond(requestId, { ...overrides, status });
    return promise;
  };

const STATUS_TABLE: Record<DelegationStatus, StatusRow> = {
  completed: {
    kind: "report",
    carriesUsage: true,
    drive: (c) => respondWith("completed", { usage: USAGE })(c),
  },
  failed: {
    kind: "hostError",
    code: "failed",
    windowClass: false,
    carriesUsage: true,
    drive: (c) => respondWith("failed", { error: "boom", usage: USAGE })(c),
  },
  timed_out: {
    kind: "timeout",
    carriesUsage: true,
    drive: (c) => respondWith("timed_out", { usage: USAGE })(c),
  },
  cancelled: {
    kind: "cancelled",
    carriesUsage: true,
    drive: (c) => respondWith("cancelled", { usage: USAGE })(c),
  },
  interrupted: {
    kind: "interrupted",
    carriesUsage: true,
    drive: (c) => respondWith("interrupted", { usage: USAGE })(c),
  },
  tool_budget_exhausted: {
    kind: "hostError",
    code: "max_steps",
    windowClass: false,
    carriesUsage: true,
    drive: (c) => respondWith("tool_budget_exhausted", { usage: USAGE })(c),
  },
  structured_output_failed: {
    kind: "schemaFailed",
    carriesUsage: true,
    drive: (c) => respondWith("structured_output_failed", { usage: USAGE })(c),
  },
  acceptance_failed: {
    kind: "hostError",
    code: "acceptance-failed",
    windowClass: false,
    carriesUsage: true,
    drive: (c) => respondWith("acceptance_failed", { usage: USAGE })(c),
  },
  invalid_request: {
    kind: "hostError",
    code: "invalid_request",
    windowClass: false,
    carriesUsage: false,
    drive: (c) => {
      const promise = c.client.run({
        nodeId: "task-1#a1",
        task: "brief",
        role: "worker",
        model: "model-a",
        timeoutMs: 60_000,
        hardToolBudget: 120,
      });
      const request = c.pi.host.requests.at(-1);
      c.pi.host.respondRaw({
        requestId: request?.requestId ?? "",
        status: "invalid_request",
        error: "malformed",
      });
      return promise;
    },
  },
  unavailable_context: {
    kind: "unavailableContext",
    carriesUsage: false,
    drive: (c) => respondWith("unavailable_context")(c),
  },
  duplicate_node: {
    kind: "hostError",
    code: "duplicate_node",
    windowClass: false,
    carriesUsage: false,
    drive: (c) => {
      // First run holds the nodeId active; the second one collides at the bridge.
      void c.client.run({
        nodeId: "task-1#a1",
        task: "first",
        role: "worker",
        model: "model-a",
        timeoutMs: 60_000,
        hardToolBudget: 120,
      });
      return c.client.run({
        nodeId: "task-1#a1",
        task: "second",
        role: "worker",
        model: "model-a",
        timeoutMs: 60_000,
        hardToolBudget: 120,
      });
    },
  },
};

describe("11-status mapping table (design §5)", () => {
  it("has exactly the 11 SubagentDelegationStatus literals", () => {
    expect(Object.keys(STATUS_TABLE)).toHaveLength(11);
  });

  for (const [status, row] of Object.entries(STATUS_TABLE)) {
    it(`${status} → ${row.kind}${row.code ? ` (${row.code})` : ""}`, async () => {
      const outcome = await row.drive(ctx);
      expect(outcome.kind).toBe(row.kind);
      if (row.code !== undefined) {
        expect(outcome).toMatchObject({ code: row.code, windowClass: row.windowClass });
      }
      if (row.carriesUsage) {
        expect(outcome).toHaveProperty("usage");
      } else {
        expect(outcome).not.toHaveProperty("usage");
      }
    });
  }

  it("completed with a valid report carries the report and usage", async () => {
    const outcome = await respondWith("completed", {
      result: { kind: "structured", value: VALID_REPORT },
      usage: USAGE,
    })(ctx);
    expect(outcome).toStrictEqual({
      kind: "report",
      report: VALID_REPORT,
      usage: USAGE,
    });
  });

  it("completed without structuredOutput → hostError no-structured-output, no retry", async () => {
    const promise = ctx.client.run({
      nodeId: "task-1#a1",
      task: "brief",
      role: "worker",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const request = lastRequest();
    ctx.pi.host.respondRaw({
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
    });
    expect(await promise).toMatchObject({
      kind: "hostError",
      code: "no-structured-output",
      windowClass: false,
    });
    expect(ctx.pi.host.requests).toHaveLength(1);
  });

  it("completed with a report violating the schema → schemaFailed (FR-007 retry trigger)", async () => {
    const outcome = await respondWith("completed", {
      result: { kind: "structured", value: { status: "done" } },
    })(ctx);
    expect(outcome.kind).toBe("schemaFailed");
  });
});

describe("hostError classification (Q-002 three classes)", () => {
  const runFailed = async (error: string) => respondWith("failed", { error })(ctx);

  it.each([
    "Rate limit exceeded for this key",
    "quota exhausted",
    "usage limit reached for today",
    "Plan limit hit",
    "BILLING LIMIT",
  ])("window class: %s → windowClass=true, code failed", async (error) => {
    expect(await runFailed(error)).toMatchObject({
      kind: "hostError",
      code: "failed",
      windowClass: true,
    });
  });

  it.each([
    "Model is overloaded",
    "server busy, retry",
    "Too many concurrent requests",
    "please try again later",
    "HTTP 529 from upstream",
  ])("overload class: %s → code 429-overload, windowClass=false", async (error) => {
    expect(await runFailed(error)).toMatchObject({
      kind: "hostError",
      code: "429-overload",
      windowClass: false,
    });
  });

  it("other failures → code failed, windowClass=false", async () => {
    expect(await runFailed("SyntaxError in worker")).toMatchObject({
      kind: "hostError",
      code: "failed",
      windowClass: false,
    });
  });

  it("interrupted is checked before failed: a limit text on interrupted stays interrupted", async () => {
    const outcome = await respondWith("interrupted", { error: "rate limit exceeded" })(ctx);
    expect(outcome.kind).toBe("interrupted");
  });
});

describe("usage: terminal-only, 0 = no data", () => {
  it("toolCalls/durationMs of 0 are treated as unknown, other fields pass through", async () => {
    const outcome = await respondWith("failed", {
      error: "boom",
      usage: { ...USAGE, toolCalls: 0, durationMs: 0 },
    })(ctx);
    expect(outcome.kind).toBe("hostError");
    const usage = (outcome as { usage?: Record<string, unknown> }).usage ?? {};
    expect(usage).not.toHaveProperty("toolCalls");
    expect(usage).not.toHaveProperty("durationMs");
    expect(usage).toMatchObject({ input: 1000, output: 200, turns: 4, cost: 0.25 });
  });

  it("local grace timeout carries no usage (unknown, not zero)", async () => {
    vi.useFakeTimers();
    const promise = runTask({ timeoutMs: 1000 });
    vi.advanceTimersByTime(1000 + SEAM_GRACE_MS);
    const outcome = await promise;
    expect(outcome).toStrictEqual({ kind: "timeout" });
  });

  it(":update snapshots are never summed into the terminal usage", async () => {
    const promise = runTask();
    const requestId = lastRequest().requestId;
    ctx.pi.host.update(requestId, {
      usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, turns: 2 },
    });
    ctx.pi.host.update(requestId, {
      usage: { input: 800, output: 150, cacheRead: 0, cacheWrite: 0, turns: 3 },
    });
    ctx.pi.host.respond(requestId, { usage: USAGE });
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "report", usage: USAGE });
  });
});

describe(":update progress snapshots", () => {
  it("forwards each cumulative snapshot that carries usage, skips the rest", async () => {
    const seen: unknown[] = [];
    const promise = runTask({ onProgress: (s) => seen.push(s) });
    const requestId = lastRequest().requestId;
    ctx.pi.host.update(requestId, { toolCount: 1 });
    ctx.pi.host.update(requestId, {
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, turns: 1 },
    });
    ctx.pi.host.update(requestId, {
      usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, turns: 3 },
    });
    ctx.pi.host.respond(requestId);
    await promise;
    expect(seen).toStrictEqual([
      { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, turns: 1 },
      { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, turns: 3 },
    ]);
  });

  it("turnsObserved is per attempt: a new attempt does not inherit the previous snapshot", async () => {
    const attempt1: unknown[] = [];
    const attempt2: unknown[] = [];
    const first = runTask({ nodeId: "task-1#a1", onProgress: (s) => attempt1.push(s) });
    const firstId = lastRequest().requestId;
    ctx.pi.host.update(firstId, {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 2 },
    });
    ctx.pi.host.update(firstId, {
      usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, turns: 5 },
    });
    ctx.pi.host.respond(firstId, { status: "failed", error: "boom" });
    await first;

    const second = runTask({ nodeId: "task-1#a2", onProgress: (s) => attempt2.push(s) });
    const secondId = lastRequest().requestId;
    ctx.pi.host.update(secondId, {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1 },
    });
    ctx.pi.host.respond(secondId);
    await second;

    expect(attempt1.at(-1)).toMatchObject({ turns: 5 });
    expect(attempt2).toStrictEqual([
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1 },
    ]);
  });
});

describe("grace deadline and late responses", () => {
  it("at timeoutMs + 15s emits :cancel {requestId, ownerRunId, nodeId} and resolves timeout", async () => {
    vi.useFakeTimers();
    const promise = runTask({ timeoutMs: 1000 });
    const request = lastRequest();

    vi.advanceTimersByTime(1000 + SEAM_GRACE_MS - 1);
    expect(ctx.pi.host.cancels).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(ctx.pi.host.cancels).toStrictEqual([
      { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId },
    ]);
    expect(await promise).toStrictEqual({ kind: "timeout" });
  });

  it("a late terminal response after the grace timeout is ignored", async () => {
    vi.useFakeTimers();
    const promise = runTask({ timeoutMs: 1000 });
    const request = lastRequest();
    vi.advanceTimersByTime(1000 + SEAM_GRACE_MS);
    const late: DelegationResponse = {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      result: { kind: "structured", value: VALID_REPORT },
      usage: USAGE,
    };
    expect(() => ctx.pi.events.emit(DELEGATION_RESPONSE_EVENT, late)).not.toThrow();
    expect(await promise).toStrictEqual({ kind: "timeout" });
  });

  it("a late :update after the grace timeout is not forwarded", async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const promise = runTask({ timeoutMs: 1000, onProgress: (s) => seen.push(s) });
    const request = lastRequest();
    vi.advanceTimersByTime(1000 + SEAM_GRACE_MS);
    await promise;
    ctx.pi.events.emit(DELEGATION_UPDATE_EVENT, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1 },
    });
    expect(seen).toHaveLength(0);
  });
});

describe("cancel(requestId)", () => {
  it("emits :cancel with the request's {requestId, ownerRunId, nodeId} body", () => {
    void runTask();
    const request = lastRequest();
    ctx.client.cancel(request.requestId);
    expect(ctx.pi.host.cancels).toStrictEqual([
      { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId },
    ]);
  });

  it("the host's cancelled terminal resolves the run as cancelled with usage", async () => {
    const promise = runTask();
    const request = lastRequest();
    ctx.client.cancel(request.requestId);
    ctx.pi.host.respond(request.requestId, { status: "cancelled", usage: USAGE });
    expect(await promise).toStrictEqual({ kind: "cancelled", usage: USAGE });
  });

  it("is a no-op for an unknown or settled requestId", async () => {
    const promise = runTask();
    const request = lastRequest();
    ctx.pi.host.respond(request.requestId);
    await promise;
    ctx.client.cancel(request.requestId);
    ctx.client.cancel("never-sent");
    expect(ctx.pi.host.cancels).toHaveLength(0);
  });
});

describe("cancelAllPending()", () => {
  it("emits exactly one :cancel per pending run with the full body and resolves each as cancelled", async () => {
    const first = runTask({ nodeId: "task-1#a1" });
    const second = runTask({ nodeId: "task-2#a1" });
    ctx.client.cancelAllPending();
    expect(ctx.pi.host.cancels).toHaveLength(2);
    for (const cancel of ctx.pi.host.cancels) {
      const request = ctx.pi.host.requests.find((r) => r.requestId === cancel.requestId);
      expect(cancel).toStrictEqual({
        requestId: request?.requestId,
        ownerRunId: request?.ownerRunId,
        nodeId: request?.nodeId,
      });
    }
    expect(await first).toStrictEqual({ kind: "cancelled" });
    expect(await second).toStrictEqual({ kind: "cancelled" });
  });

  it("finished runs keep their results; only the still-pending run is cancelled", async () => {
    const finished = runTask({ nodeId: "task-1#a1" });
    const settled = lastRequest();
    ctx.pi.host.respond(settled.requestId, {
      result: { kind: "structured", value: VALID_REPORT },
      usage: USAGE,
    });
    expect(await finished).toMatchObject({ kind: "report", report: { status: "done" } });
    const pending = runTask({ nodeId: "task-2#a1" });
    ctx.client.cancelAllPending();
    expect(ctx.pi.host.cancels).toHaveLength(1);
    expect(ctx.pi.host.cancels[0]?.requestId).not.toBe(settled.requestId);
    expect(await pending).toStrictEqual({ kind: "cancelled" });
  });

  it("double-cancel is impossible: pending is dropped before the emits, late answers are ignored", async () => {
    const promise = runTask();
    const request = lastRequest();
    ctx.client.cancelAllPending();
    expect(await promise).toStrictEqual({ kind: "cancelled" });
    expect(ctx.pi.host.cancels).toHaveLength(1);
    // A second sweep, the single-request cancel and a late terminal answer
    // all find no pending entry left — no second :cancel goes out.
    ctx.client.cancelAllPending();
    ctx.client.cancel(request.requestId);
    ctx.pi.host.respondRaw({
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      result: { kind: "structured", value: VALID_REPORT },
    });
    expect(ctx.pi.host.cancels).toHaveLength(1);
  });

  it("cancels the local grace timer: no timeout :cancel after the sweep", async () => {
    vi.useFakeTimers();
    const promise = runTask({ timeoutMs: 1_000 });
    ctx.client.cancelAllPending();
    expect(await promise).toStrictEqual({ kind: "cancelled" });
    await vi.advanceTimersByTimeAsync(1_000 + SEAM_GRACE_MS + 1);
    expect(ctx.pi.host.cancels).toHaveLength(1);
  });
});

describe("dispose()", () => {
  it("resolves every pending run as cancelled without usage", async () => {
    const first = runTask({ nodeId: "task-1#a1" });
    const second = runTask({ nodeId: "task-2#a1" });
    ctx.client.dispose();
    expect(await first).toStrictEqual({ kind: "cancelled" });
    expect(await second).toStrictEqual({ kind: "cancelled" });
  });

  it("ignores responses and updates that arrive after dispose", async () => {
    const seen: unknown[] = [];
    const promise = runTask({ onProgress: (s) => seen.push(s) });
    const request = lastRequest();
    ctx.client.dispose();
    expect(await promise).toStrictEqual({ kind: "cancelled" });
    ctx.pi.events.emit(DELEGATION_UPDATE_EVENT, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1 },
    });
    ctx.pi.host.respondRaw({
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      result: { kind: "structured", value: VALID_REPORT },
    });
    expect(seen).toHaveLength(0);
  });

  it("a run started after dispose resolves cancelled without emitting a request", async () => {
    ctx.client.dispose();
    const before = ctx.pi.host.requests.length;
    expect(await runTask()).toStrictEqual({ kind: "cancelled" });
    expect(ctx.pi.host.requests).toHaveLength(before);
  });

  it("is idempotent", () => {
    ctx.client.dispose();
    expect(() => ctx.client.dispose()).not.toThrow();
  });
});

describe("role table (design §4.4)", () => {
  function lastRequestOf(pi: FakePi): Record<string, unknown> {
    const request = pi.host.requests.at(-1);
    if (!request) throw new Error("no request reached the bus");
    return request as unknown as Record<string, unknown>;
  }

  it("worker row is byte-identical to the pre-roles constants (pin)", () => {
    const pi = createFakePi();
    const client = createFanoutSeamClient({ events: pi.events, cwd: "/repo" });
    void client.run({
      nodeId: "task-1#a1",
      task: "brief",
      role: "worker",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const request = lastRequestOf(pi);
    expect(request.agent).toBe("fusion-worker");
    expect(request.toolBudget).toEqual({ hard: 120, block: TOOL_BLOCK });
    const schema = (request.result as { schema?: Record<string, unknown> }).schema ?? {};
    // The wire schema re-encodes the worker envelope: strict object with the
    // if/then question rule, no role-specific fields.
    expect(schema.additionalProperties).toBe(false);
    expect(schema.if).toBeDefined();
    expect(JSON.stringify(schema)).not.toContain("sources");
    expect(JSON.stringify(schema)).not.toContain("findings");
    client.dispose();
    pi.host.dispose();
  });

  it("scout row: fusion-scout agent, scout schema (sources), bash blocked", () => {
    const pi = createFakePi();
    const client = createFanoutSeamClient({ events: pi.events, cwd: "/repo" });
    void client.run({
      nodeId: "s#a1",
      task: "brief",
      role: "scout",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const request = lastRequestOf(pi);
    expect(request.agent).toBe("fusion-scout");
    expect(request.toolBudget).toEqual({
      hard: 120,
      block: [...TOOL_BLOCK, "edit", "write", "bash"],
    });
    expect(JSON.stringify((request.result as { schema?: unknown }).schema)).toContain("sources");
    client.dispose();
    pi.host.dispose();
  });

  it("researcher row: profile variant follows researcherWeb (§4.9.3)", () => {
    const expectations: Array<[("none" | "web" | "codex" | "both") | undefined, string]> = [
      [undefined, "fusion-researcher"],
      ["none", "fusion-researcher"],
      ["web", "fusion-researcher-web"],
      ["codex", "fusion-researcher-codex"],
      ["both", "fusion-researcher-both"],
    ];
    for (const [mode, agent] of expectations) {
      const pi = createFakePi();
      const client = createFanoutSeamClient({
        events: pi.events,
        cwd: "/repo",
        ...(mode !== undefined ? { researcherWeb: mode } : {}),
      });
      void client.run({
        nodeId: "r#a1",
        task: "brief",
        role: "researcher",
        model: "model-a",
        timeoutMs: 60_000,
        hardToolBudget: 120,
      });
      const request = lastRequestOf(pi) as unknown as Record<string, unknown>;
      expect(request.agent).toBe(agent);
      expect(request.toolBudget).toEqual({
        hard: 120,
        block: [...TOOL_BLOCK, "edit", "write", "bash"],
      });
      const json = JSON.stringify((request.result as { schema?: unknown }).schema);
      expect(json).toContain("sources");
      expect(json).toContain("unknowns");
      client.dispose();
      pi.host.dispose();
    }
  });

  it("reviewer row: fusion-reviewer agent, reviewer schema, bash allowed", () => {
    const pi = createFakePi();
    const client = createFanoutSeamClient({ events: pi.events, cwd: "/repo" });
    void client.run({
      nodeId: "v#a1",
      task: "brief",
      role: "reviewer",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const request = lastRequestOf(pi);
    expect(request.agent).toBe("fusion-reviewer");
    expect(request.toolBudget).toEqual({
      hard: 120,
      block: [...TOOL_BLOCK, "edit", "write"],
    });
    const json = JSON.stringify((request.result as { schema?: unknown }).schema);
    expect(json).toContain("findings");
    expect(json).toContain("checksRun");
    expect(json).toContain("verdict");
    client.dispose();
    pi.host.dispose();
  });

  it("a scout answer violating the ROLE schema maps to schemaFailed with the rejected JSON", async () => {
    const promise = ctx.client.run({
      nodeId: "task-1#a1",
      task: "brief",
      role: "scout",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const request = lastRequest();
    // A valid WORKER report is an INVALID scout report (no sources).
    ctx.pi.host.respond(request.requestId, {
      result: { kind: "structured", value: VALID_REPORT },
    });
    const outcome = await promise;
    expect(outcome.kind).toBe("schemaFailed");
    if (outcome.kind !== "schemaFailed") throw new Error("unreachable");
    expect(outcome.violatedFields).toContain("sources");
    expect(outcome.rejectedJson).toBe(JSON.stringify(VALID_REPORT));
  });

  it("host-refused rejection carries no rejectedJson (the value never existed)", async () => {
    const promise = ctx.client.run({
      nodeId: "task-1#a1",
      task: "brief",
      role: "worker",
      model: "model-a",
      timeoutMs: 60_000,
      hardToolBudget: 120,
    });
    const request = lastRequest();
    ctx.pi.host.respond(request.requestId, { status: "structured_output_failed" });
    const outcome = await promise;
    expect(outcome.kind).toBe("schemaFailed");
    if (outcome.kind !== "schemaFailed") throw new Error("unreachable");
    expect(outcome.rejectedJson).toBeUndefined();
  });
});

describe("clipRejectedJson (§4.5.2)", () => {
  it("passes a small value through verbatim", () => {
    expect(clipRejectedJson({ a: 1 })).toBe('{"a":1}');
  });

  it("clips an oversized value with an explicit truncation note", () => {
    const big = { s: "x".repeat(20_000) };
    const clipped = clipRejectedJson(big);
    expect(clipped.length).toBeLessThan(20_000);
    expect(clipped).toContain("[обрезано: исходный ответ — ");
    expect(clipped.startsWith("{")).toBe(true);
  });

  it("the limit is 16 000 chars (design pin)", () => {
    expect(REJECTED_VALUE_CHAR_LIMIT).toBe(16_000);
  });

  it("never ends the cut on a lone high surrogate (review fix M1)", () => {
    // An emoji whose high surrogate sits at index 15999: a naive slice
    // ends on 0xd83d and decodes as U+FFFD on the child's side.
    const prefix = "x".repeat(15_999);
    const value = { s: prefix + "👍" };
    const clipped = clipRejectedJson(value);
    const body = clipped.slice(0, clipped.indexOf("\n[обрезано"));
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});
