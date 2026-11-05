/**
 * Pool mechanics (design rev.5.2 §4 pool, §11; FR-003/FR-004/FR-005,
 * B-FINAL): the clamp chain and its row order, FIFO dispatch, the per-model
 * cap of 2 at 1/2/3 models, index-ordered results, outcome → TaskResult
 * mapping, and the empty-rotation pre-flight that can never be revived.
 *
 * The pool runs against the REAL seam client over the fake delegation bus
 * (test/fake-pi.ts) — the same path production takes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ValidatedFusionCall,
  ValidatedTask,
} from "../extensions/pi-fusion/contract/validate.ts";
import {
  type CooldownEntry,
  type CooldownStore,
  createCooldownStore,
  formatCooldownRemaining,
} from "../extensions/pi-fusion/pool/cooldown.ts";
import {
  type CooldownDeps,
  type FanoutConfig,
  type FanoutDeps,
  planFanoutWidth,
  runFanout,
} from "../extensions/pi-fusion/pool/fanout.ts";
import { createFanoutSeamClient } from "../extensions/pi-fusion/seam/client.ts";
import type { FanoutResult } from "../extensions/pi-fusion/types.ts";
import {
  createFakePi,
  type DelegationRequest,
  type DelegationStatus,
  type DelegationUsage,
  type FakePi,
  type RespondOverrides,
} from "./fake-pi.ts";

/** RespondOverrides without the invalid_request literal (host.respond overloads). */
type TerminalOverrides = RespondOverrides & {
  status?: Exclude<DelegationStatus, "invalid_request">;
};

/** Drains microtask cascades (dispatch → launch → :request). */
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

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

function makeTask(id: string, extra: Partial<ValidatedTask> = {}): ValidatedTask {
  return { id, title: id, instructions: `instructions for ${id}`, role: "worker", ...extra };
}

function makeCall(tasks: ValidatedTask[], maxWorkers?: number): ValidatedFusionCall {
  return maxWorkers === undefined ? { tasks } : { tasks, maxWorkers };
}

const BASE_CONFIG: FanoutConfig = {
  workers: 4,
  maxParallel: 8,
  taskTimeoutMs: 60_000,
  workerModels: ["model-a", "model-b"],
  maxSteps: 100,
  modelCooldownMs: 300_000,
};

/** An injected cooldown store plus the virtual clock driving it (design D1). */
interface Cool {
  store: CooldownStore;
  now: number;
}

function makeCool(): Cool {
  return { store: createCooldownStore(), now: 0 };
}

const coolDeps: (cool: Cool) => Partial<FanoutDeps> = (cool) => ({
  cooldowns: {
    store: cool.store,
    clock: { now: () => cool.now },
  } satisfies CooldownDeps,
});

interface Pool {
  pi: FakePi;
  promise: Promise<FanoutResult | { seamUnavailable: true }>;
  clientCreated: boolean;
}

function startPool(
  contract: ValidatedFusionCall,
  config: FanoutConfig,
  overrides: Partial<FanoutDeps> = {},
): Pool {
  const pi = createFakePi();
  const state = { clientCreated: false };
  const deps: FanoutDeps = {
    contract,
    config,
    available: () => true,
    makeClient: () => {
      state.clientCreated = true;
      return createFanoutSeamClient({ events: pi.events, cwd: "/repo" });
    },
    ...overrides,
  };
  return { pi, promise: runFanout(deps), clientCreated: state.clientCreated };
}

function isFanoutResult(result: FanoutResult | { seamUnavailable: true }): result is FanoutResult {
  return "results" in result;
}

/** Asserts the pool returned a FanoutResult (not a degradation refusal). */
function expectResult(result: FanoutResult | { seamUnavailable: true }): FanoutResult {
  if (!isFanoutResult(result)) {
    throw new Error("expected FanoutResult, got degradation refusal");
  }
  return result;
}

function respondByNode(pi: FakePi, nodeId: string, overrides: TerminalOverrides = {}): void {
  const request = pi.host.requests.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) {
    throw new Error(`no request reached the bus for ${nodeId}`);
  }
  pi.host.respond(request.requestId, overrides);
}

/**
 * Answers every request the pool emits (new waves included) through
 * `overridesFor`, until the queue and the bus are both quiet.
 */
async function driveAll(
  pi: FakePi,
  overridesFor: (request: DelegationRequest) => RespondOverrides = () => ({}),
): Promise<void> {
  for (;;) {
    const pending = pi.host.pendingRequestIds();
    if (pending.length === 0) {
      break;
    }
    for (const requestId of pending) {
      const request = pi.host.getPending(requestId);
      if (request !== undefined) {
        const { status, ...rest } = overridesFor(request);
        if (status === "invalid_request") {
          pi.host.respond(requestId, { ...rest, status });
        } else {
          pi.host.respond(requestId, status === undefined ? rest : { ...rest, status });
        }
      }
    }
    await tick();
  }
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clamp chain (FR-003, MINOR-3-R7)", () => {
  it("clamps on maxParallel first, the row carries W_req as requested", () => {
    const plan = planFanoutWidth(
      makeCall([makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4"), makeTask("t5")], 8),
      { ...BASE_CONFIG, maxParallel: 3, workerModels: ["model-a", "model-b", "model-c"] },
    );
    expect(plan.width).toBe(3);
    expect(plan.clamps).toStrictEqual([
      { field: "maxParallel", requested: 8, applied: 3, reason: expect.any(String) },
    ]);
  });

  it("clamps on perModel with capacity = 2 × |workerModels| (design example)", () => {
    const plan = planFanoutWidth(
      makeCall([makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4"), makeTask("t5")], 9),
      { ...BASE_CONFIG, maxParallel: 20, workerModels: ["model-a", "model-b"] },
    );
    expect(plan.width).toBe(4);
    expect(plan.clamps).toStrictEqual([
      { field: "perModel", requested: 9, applied: 4, reason: expect.any(String) },
    ]);
  });

  it("applies factors in order maxParallel → perModel → tasks, rows in that order", () => {
    const plan = planFanoutWidth(
      makeCall([makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4"), makeTask("t5")], 8),
      { ...BASE_CONFIG, workerModels: ["model-a", "model-b", "model-c"] },
    );
    expect(plan.width).toBe(5);
    expect(plan.clamps.map((row) => [row.field, row.requested, row.applied])).toStrictEqual([
      ["perModel", 8, 6],
      ["tasks", 6, 5],
    ]);
  });

  it("emits no rows when nothing binds; W_req defaults to config.workers", () => {
    const plan = planFanoutWidth(
      makeCall([makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4")]),
      BASE_CONFIG,
    );
    expect(plan.width).toBe(4);
    expect(plan.clamps).toStrictEqual([]);
  });

  it("width requested 3 → factual 2 with one model: exactly one perModel row (n3-R6)", async () => {
    const tasks = ["t1", "t2", "t3", "t4", "t5"].map((id) => makeTask(id));
    const { pi, promise } = startPool(makeCall(tasks, 3), {
      ...BASE_CONFIG,
      maxParallel: 8,
      workerModels: ["model-a"],
    });
    // First wave is emitted synchronously: capped at capacity 2.
    expect(pi.host.requests).toHaveLength(2);
    await driveAll(pi);
    const result = expectResult(await promise);
    expect(result.clamps).toStrictEqual([
      { field: "perModel", requested: 3, applied: 2, reason: expect.any(String) },
    ]);
  });

  it("the pool enforces the clamped width in its first dispatch wave", async () => {
    const tasks = ["t1", "t2", "t3", "t4", "t5"].map((id) => makeTask(id));
    const { pi, promise } = startPool(makeCall(tasks, 9), {
      ...BASE_CONFIG,
      maxParallel: 20,
      workerModels: ["model-a", "model-b"],
    });
    expect(pi.host.requests).toHaveLength(4);
    await driveAll(pi);
    expectResult(await promise);
  });
});

describe("FIFO schedule (FR-003/FR-004)", () => {
  it("dispatches queued tasks in index order as slots release", async () => {
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => makeTask(id));
    const { pi, promise } = startPool(makeCall(tasks), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    expect(pi.host.requests.map((request) => request.nodeId)).toStrictEqual(["t1#a1", "t2#a1"]);
    respondByNode(pi, "t1#a1");
    await tick();
    expect(pi.host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
      "t3#a1",
    ]);
    respondByNode(pi, "t2#a1");
    await tick();
    respondByNode(pi, "t3#a1");
    await tick();
    respondByNode(pi, "t4#a1");
    await tick();
    respondByNode(pi, "t5#a1");
    await tick();
    respondByNode(pi, "t6#a1");
    await tick();
    expect(pi.host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
      "t3#a1",
      "t4#a1",
      "t5#a1",
      "t6#a1",
    ]);
    const result = expectResult(await promise);
    expect(result.results.map((row) => row.id)).toStrictEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("keeps ≤2 live workers per model at 1, 2 and 3 models, rotating round-robin", async () => {
    for (const models of [["model-a"], ["model-a", "model-b"], ["model-a", "model-b", "model-c"]]) {
      const tasks = Array.from({ length: 8 }, (_, index) => makeTask(`t${index + 1}`));
      const { pi, promise } = startPool(makeCall(tasks), {
        ...BASE_CONFIG,
        workers: 16,
        workerModels: models,
      });
      const firstWave = pi.host.requests.map((request) => request.model ?? "?");
      const perModel = new Map<string, number>();
      for (const model of firstWave) {
        perModel.set(model, (perModel.get(model) ?? 0) + 1);
      }
      for (const model of models) {
        expect(perModel.get(model) ?? 0).toBeLessThanOrEqual(2);
      }
      // Round-robin: the first wave walks the rotation in order.
      const expected: string[] = [];
      while (expected.length < Math.min(2 * models.length, 8)) {
        expected.push(models[expected.length % models.length] as string);
      }
      expect(firstWave).toStrictEqual(expected);
      await driveAll(pi);
      expectResult(await promise);
    }
  });

  it("holds the per-model cap of 2 through the whole churn, total ≤ width", async () => {
    const tasks = Array.from({ length: 10 }, (_, index) => makeTask(`t${index + 1}`));
    const { pi, promise } = startPool(makeCall(tasks), BASE_CONFIG);
    for (;;) {
      const pending = pi.host.pendingRequestIds();
      if (pending.length === 0) {
        break;
      }
      const byModel = new Map<string, number>();
      for (const requestId of pending) {
        const model = pi.host.getPending(requestId)?.model;
        if (model !== undefined) {
          byModel.set(model, (byModel.get(model) ?? 0) + 1);
        }
      }
      for (const count of byModel.values()) {
        expect(count).toBeLessThanOrEqual(2);
      }
      expect(pending.length).toBeLessThanOrEqual(4);
      const first = pending[0];
      if (first === undefined) {
        break;
      }
      pi.host.respond(first);
      await tick();
    }
    const result = expectResult(await promise);
    expect(result.results.every((row) => row.status === "done")).toBe(true);
  });
});

describe("result assembly (FR-005)", () => {
  it("returns rows in task-index order regardless of completion order", async () => {
    const tasks = ["t1", "t2", "t3", "t4"].map((id) => makeTask(id));
    const { pi, promise } = startPool(makeCall(tasks), BASE_CONFIG);
    respondByNode(pi, "t4#a1", {
      result: {
        kind: "structured",
        value: {
          status: "done",
          summary: "fourth",
          filesChanged: [],
          evidence: [],
          residualRisks: [],
        },
      },
    });
    await tick();
    respondByNode(pi, "t3#a1", {
      result: {
        kind: "structured",
        value: {
          status: "done",
          summary: "third",
          filesChanged: [],
          evidence: [],
          residualRisks: [],
        },
      },
    });
    await tick();
    respondByNode(pi, "t2#a1");
    await tick();
    respondByNode(pi, "t1#a1");
    await tick();
    const result = expectResult(await promise);
    expect(result.results.map((row) => row.summary)).toStrictEqual([
      "fake-pi structured result",
      "fake-pi structured result",
      "third",
      "fourth",
    ]);
  });

  it("maps every seam outcome onto TaskResult and sums terminal usage only", async () => {
    const tasks = Array.from({ length: 12 }, (_, index) => makeTask(`t${index + 1}`));
    // t4/t5 carry absurd budgets to pin the 4× ceilings.
    tasks[3] = makeTask("t4", { timeoutMs: 10_000_000 });
    tasks[4] = makeTask("t5", { maxSteps: 10_000 });
    const { pi, promise } = startPool(makeCall(tasks), {
      ...BASE_CONFIG,
      workers: 16,
      workerModels: ["model-a", "model-b", "model-c"],
    });
    expect(pi.host.requests).toHaveLength(6);
    const t1Request = pi.host.requests.find((request) => request.nodeId === "t1#a1");
    expect(t1Request).toMatchObject({ timeoutMs: 60_000, toolBudget: { hard: 100 } });
    const t4Request = pi.host.requests.find((request) => request.nodeId === "t4#a1");
    expect(t4Request?.timeoutMs).toBe(240_000);
    const t5Request = pi.host.requests.find((request) => request.nodeId === "t5#a1");
    expect(t5Request?.toolBudget?.hard).toBe(400);
    expect(t1Request?.task).toBe("## t1\n\ninstructions for t1");

    const t1Id = t1Request?.requestId ?? "";
    pi.host.update(t1Id, {
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, turns: 2 },
    });
    await driveAll(pi, (request): RespondOverrides => {
      switch (request.nodeId) {
        case "t1#a1":
          return { usage: USAGE };
        case "t2#a1":
          return {
            result: {
              kind: "structured",
              value: {
                status: "no_changes",
                summary: "nothing to do",
                filesChanged: [],
                evidence: [],
                residualRisks: [],
              },
            },
          };
        case "t3#a1":
          return {
            result: {
              kind: "structured",
              value: {
                status: "needs_orchestrator",
                question: "which branch?",
                summary: "blocked",
                filesChanged: [],
                evidence: [],
                residualRisks: [],
              },
            },
          };
        case "t4#a1":
          return { status: "timed_out" };
        case "t5#a1":
          return { status: "interrupted" };
        case "t6#a1":
          return { status: "structured_output_failed" };
        case "t7#a1":
          return { status: "unavailable_context" };
        case "t8#a1":
          return { status: "tool_budget_exhausted" };
        case "t9#a1":
          return { status: "acceptance_failed" };
        case "t10#a1":
          return { status: "invalid_request", error: "malformed" };
        case "t11#a1":
          return { status: "duplicate_node", error: "node busy" };
        default:
          return { status: "failed", error: "boom" };
      }
    });

    const result = expectResult(await promise);
    expect(result.results.map((row) => row.id)).toStrictEqual(tasks.map((task) => task.id));
    const [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12] = result.results;
    expect(t1).toMatchObject({ status: "done", attempts: 1, turns: 4, turnsObserved: 2 });
    expect(t2?.status).toBe("no_changes");
    expect(t3).toMatchObject({ status: "needs_orchestrator", question: "which branch?" });
    expect(t4).toMatchObject({ status: "failed", error: "timeout" });
    expect(t4?.summary).toContain("taskTimeoutMs");
    expect(t5).toMatchObject({ status: "failed", error: "interrupted" });
    // FR-007 (agreed edit, pi-fusion-hi7): structured_output_failed gets one
    // corrective run on the same model (t6#a2); its default answer is failed.
    const t6First = pi.host.requests.find((request) => request.nodeId === "t6#a1");
    expect(pi.host.requests.find((request) => request.nodeId === "t6#a2")?.model).toBe(
      t6First?.model,
    );
    expect(t6).toMatchObject({
      status: "failed",
      error: "host:failed",
      attempts: 2,
    });
    expect(t7).toMatchObject({ status: "failed", error: "seam-unavailable" });
    expect(t8).toMatchObject({ status: "failed", error: "max_steps" });
    expect(t9).toMatchObject({ status: "failed", error: "acceptance-failed" });
    expect(t10).toMatchObject({ status: "failed", error: "host:invalid_request" });
    expect(t11).toMatchObject({ status: "failed", error: "host:duplicate_node" });
    expect(t12).toMatchObject({ status: "failed", error: "host:failed" });
    expect(result.usage).toStrictEqual({
      input: 1000,
      output: 200,
      cacheRead: 300,
      cacheWrite: 40,
      cost: 0.25,
      turns: 4,
      toolCalls: 7,
      durationMs: 9000,
    });
    expect(result.usagePartial).toBe(true);
    expect(result.clamps.map((row) => [row.field, row.requested, row.applied])).toStrictEqual([
      ["maxParallel", 16, 8],
      ["perModel", 8, 6],
    ]);
  });
});

describe("degradation pre-flight (FR-009)", () => {
  it("refuses the whole call without creating a client or emitting a request", async () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    const { pi, promise, clientCreated } = startPool(makeCall(tasks), BASE_CONFIG, {
      available: () => false,
    });
    expect(clientCreated).toBe(false);
    expect(pi.host.requests).toHaveLength(0);
    await expect(promise).resolves.toStrictEqual({ seamUnavailable: true });
  });
});

describe("abort signal (design §8 Esc row)", () => {
  it("cancels queued and in-flight tasks and returns the partial result", async () => {
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => makeTask(id));
    const controller = new AbortController();
    const { pi, promise } = startPool(makeCall(tasks), BASE_CONFIG, {
      signal: controller.signal,
    });
    expect(pi.host.requests).toHaveLength(4);
    controller.abort();
    const result = expectResult(await promise);
    expect(pi.host.requests).toHaveLength(4);
    expect(result.results.map((row) => row.status)).toStrictEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(result.results.slice(0, 4).map((row) => row.attempts)).toStrictEqual([1, 1, 1, 1]);
    expect(result.results.slice(4).map((row) => row.attempts)).toStrictEqual([0, 0]);
  });

  it("Esc mid-run: exactly one :cancel with the full body per in-flight child; completed results are kept", async () => {
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => makeTask(id));
    const controller = new AbortController();
    const { pi, promise } = startPool(makeCall(tasks), BASE_CONFIG, {
      signal: controller.signal,
    });
    expect(pi.host.requests).toHaveLength(4);
    // t1 finishes naturally; its released slot launches t5 (FIFO).
    respondByNode(pi, "t1#a1");
    await tick();
    expect(pi.host.requests).toHaveLength(5);
    const inFlightAtAbort = pi.host.pendingRequestIds().sort();
    expect(inFlightAtAbort).toHaveLength(4);

    controller.abort();
    await tick();
    const result = expectResult(await promise);

    // Exactly one :cancel per in-flight child, never for the finished t1.
    expect(pi.host.cancels.map((cancel) => cancel.requestId).sort()).toStrictEqual(inFlightAtAbort);
    for (const cancel of pi.host.cancels) {
      const request = pi.host.requests.find((r) => r.requestId === cancel.requestId);
      expect(cancel).toStrictEqual({
        requestId: request?.requestId,
        ownerRunId: expect.stringMatching(/^fusion-/),
        nodeId: request?.nodeId,
      });
      expect(pi.host.cancelsFor(cancel.requestId)).toHaveLength(1);
    }

    expect(result.results.map((row) => row.id)).toStrictEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(result.results[0]).toMatchObject({
      status: "done",
      summary: "fake-pi structured result",
    });
    expect(result.results.slice(1, 5).map((row) => row.status)).toStrictEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(result.results.slice(1, 5).map((row) => row.attempts)).toStrictEqual([1, 1, 1, 1]);
    expect(result.results[5]).toMatchObject({ status: "cancelled", attempts: 0 });
  });
});

describe("empty rotation (B-FINAL, FR-003)", () => {
  it("fails every task immediately and can never be revived by passing time", async () => {
    vi.useFakeTimers();
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")];
    const { pi, promise } = startPool(makeCall(tasks, 7), {
      ...BASE_CONFIG,
      workerModels: [],
    });
    expect(pi.host.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    const result = expectResult(await promise);
    expect(pi.host.requests).toHaveLength(0);
    expect(result.clamps).toStrictEqual([
      { field: "noModels", requested: 7, applied: 0, reason: expect.any(String) },
    ]);
    expect(result.results.map((row) => row.id)).toStrictEqual(["t1", "t2", "t3"]);
    for (const row of result.results) {
      expect(row).toMatchObject({
        status: "failed",
        error: "no-available-model",
        attempts: 0,
      });
    }
    expect(result.usagePartial).toBe(true);
    expect(result.usage).toStrictEqual({});
  });
});

describe("cooldown width (fusion-model-cooldown D3, D7, D8)", () => {
  // Blocker 3.1: the cooldown row is pinned STRICTLY — the reason carries the
  // number of SKIPPED models AND their time remainders (spec "Fully cooled
  // rotation is fail-fast": the clamp chain MUST name the skipped count and the
  // time remainders), formatted by the pool's own `formatCooldownRemaining`.
  const coolingTwo: CooldownEntry[] = [
    { model: "model-a", reason: "window", remainingMs: 270_000 },
    { model: "model-b", reason: "timeout", remainingMs: 90_000 },
  ];
  it("plan: 3 models, 2 cooling, workers 4, maxParallel 8, 4 tasks → cooldown row 4 → 2", () => {
    const plan = planFanoutWidth(
      makeCall(["t1", "t2", "t3", "t4"].map((id) => makeTask(id))),
      { ...BASE_CONFIG, maxParallel: 8, workerModels: ["model-a", "model-b", "model-c"] },
      coolingTwo,
    );
    expect(plan.width).toBe(2);
    expect(plan.clamps).toStrictEqual([
      {
        field: "cooldown",
        requested: 4,
        applied: 2,
        reason:
          `per-model cap 2 × 1 of 3 model(s) cool — ${coolingTwo.length} model(s) cooling down ` +
          `(up to ${formatCooldownRemaining(270_000)} left: ` +
          `model-a window ${formatCooldownRemaining(270_000)}, ` +
          `model-b timeout ${formatCooldownRemaining(90_000)})`,
      },
    ]);
    // The pin says it in the reviewer's words: the count AND a remainder token.
    const reason = plan.clamps[0]?.reason ?? "";
    expect(reason).toMatch(/cooling down/);
    expect(reason).toMatch(/\d+s/);
    expect(reason).toContain(`${coolingTwo.length} model(s) cooling down`);
    expect(reason).toContain(formatCooldownRemaining(270_000));
    expect(reason).toContain(formatCooldownRemaining(90_000));
  });

  it("plan: a non-binding cooldown adds no row (3 models, 1 cooling, workers 3)", () => {
    const plan = planFanoutWidth(
      makeCall(["t1", "t2", "t3"].map((id) => makeTask(id))),
      {
        ...BASE_CONFIG,
        workers: 3,
        maxParallel: 8,
        workerModels: ["model-a", "model-b", "model-c"],
      },
      [{ model: "model-a", reason: "window", remainingMs: 45_000 }],
    );
    expect(plan.width).toBe(3);
    expect(plan.clamps).toStrictEqual([]);
  });

  it("plan: every model cooling → width 0 and the cooldown row (B-FINAL shape)", () => {
    const plan = planFanoutWidth(
      makeCall(
        ["t1", "t2", "t3"].map((id) => makeTask(id)),
        4,
      ),
      {
        ...BASE_CONFIG,
        maxParallel: 8,
        workerModels: ["model-a", "model-b", "model-c"],
      },
      [
        { model: "model-a", reason: "window", remainingMs: 600_000 },
        { model: "model-b", reason: "timeout", remainingMs: 90_000 },
        { model: "model-c", reason: "window", remainingMs: 45_500 },
      ],
    );
    expect(plan.width).toBe(0);
    expect(plan.clamps).toStrictEqual([
      {
        field: "cooldown",
        requested: 4,
        applied: 0,
        reason:
          `all 3 model(s) cooling down (up to ${formatCooldownRemaining(600_000)} left: ` +
          `model-a window ${formatCooldownRemaining(600_000)}, ` +
          `model-b timeout ${formatCooldownRemaining(90_000)}, ` +
          `model-c window ${formatCooldownRemaining(45_500)}) — the rotation is empty at plan time`,
      },
    ]);
    // Even the fail-fast row carries the remainders, not just "N cooling down".
    expect(plan.clamps[0]?.reason).toMatch(/cooling down/);
    expect(plan.clamps[0]?.reason).toMatch(/\d+s/);
  });

  it("plan: the full rotation keeps the chain byte-identical to no cooling", () => {
    const call = makeCall(
      ["t1", "t2", "t3", "t4", "t5"].map((id) => makeTask(id)),
      9,
    );
    const config = { ...BASE_CONFIG, maxParallel: 20, workerModels: ["model-a", "model-b"] };
    expect(planFanoutWidth(call, config, [])).toStrictEqual(planFanoutWidth(call, config));
  });

  it("runtime: a partial cooldown leaves the one cool-free model with ≤2 live workers", async () => {
    const cool = makeCool();
    cool.store.enterCooldown("model-a", "window", 600_000, cool.now);
    cool.store.enterCooldown("model-b", "timeout", 600_000, cool.now);
    const { pi, promise } = startPool(
      makeCall(["t1", "t2", "t3", "t4"].map((id) => makeTask(id))),
      {
        ...BASE_CONFIG,
        workers: 4,
        maxParallel: 8,
        workerModels: ["model-a", "model-b", "model-c"],
      },
      coolDeps(cool),
    );
    for (;;) {
      const pending = pi.host.pendingRequestIds();
      if (pending.length === 0) {
        break;
      }
      expect(pending.length).toBeLessThanOrEqual(2);
      const first = pending[0];
      if (first === undefined) {
        break;
      }
      pi.host.respond(first);
      await tick();
    }
    const result = expectResult(await promise);
    // The runtime row mirrors the plan row STRICTLY: same count, same remainders
    // (the store was read at plan time with cool.now === 0).
    expect(result.clamps).toStrictEqual([
      {
        field: "cooldown",
        requested: 4,
        applied: 2,
        reason:
          `per-model cap 2 × 1 of 3 model(s) cool — 2 model(s) cooling down (up to ` +
          `600s left: model-a window ${formatCooldownRemaining(600_000)}, ` +
          `model-b timeout ${formatCooldownRemaining(600_000)})`,
      },
    ]);
    expect(pi.host.requests.every((request) => request.model === "model-c")).toBe(true);
    expect(result.results.every((row) => row.status === "done")).toBe(true);
    expect(pi.host.cancels).toHaveLength(0);
  });

  it("runtime: every model cooling at the start fails the call up front with zero :request", async () => {
    const cool = makeCool();
    cool.store.enterCooldown("model-a", "window", 600_000, cool.now);
    cool.store.enterCooldown("model-b", "timeout", 90_000, cool.now);
    const { pi, promise } = startPool(
      makeCall(
        ["t1", "t2", "t3"].map((id) => makeTask(id)),
        4,
      ),
      { ...BASE_CONFIG, maxParallel: 8 },
      coolDeps(cool),
    );
    const result = expectResult(await promise);
    expect(pi.host.requests).toHaveLength(0);
    expect(pi.host.cancels).toHaveLength(0);
    // The fail-fast row carries the same remainders the summary names.
    expect(result.clamps).toStrictEqual([
      {
        field: "cooldown",
        requested: 4,
        applied: 0,
        reason:
          `all 2 model(s) cooling down (up to ${formatCooldownRemaining(600_000)} left: ` +
          `model-a window ${formatCooldownRemaining(600_000)}, ` +
          `model-b timeout ${formatCooldownRemaining(90_000)}) — the rotation is empty at plan time`,
      },
    ]);
    expect(result.results.map((row) => row.id)).toStrictEqual(["t1", "t2", "t3"]);
    for (const row of result.results) {
      expect(row).toMatchObject({
        status: "failed",
        error: "no-available-model",
        attempts: 0,
      });
      // The honest summary names every cooling model, its reason and remainder.
      expect(row.summary).toContain(`model-a window ${formatCooldownRemaining(600_000)}`);
      expect(row.summary).toContain(`model-b timeout ${formatCooldownRemaining(90_000)}`);
    }
    expect(result.usage).toStrictEqual({});
    expect(result.usagePartial).toBe(true);
  });

  it("runtime: a retry-after read from the error sets the duration (90 seconds → 90 000)", async () => {
    const cool = makeCool();
    const { pi, promise } = startPool(
      makeCall([makeTask("t1")]),
      {
        ...BASE_CONFIG,
        workers: 1,
        maxParallel: 1,
        workerModels: ["model-a"],
        modelCooldownMs: 120_000,
      },
      coolDeps(cool),
    );
    respondByNode(pi, "t1#a1", {
      status: "failed",
      error: "HTTP 429: rate limit exceeded — try again in 90 seconds",
    });
    const result = expectResult(await promise);
    expect(result.results[0]).toMatchObject({
      status: "failed",
      error: "host:failed",
      attempts: 1,
    });
    expect(cool.store.activeCooldowns(["model-a"], cool.now)).toStrictEqual([
      { model: "model-a", reason: "window", remainingMs: 90_000 },
    ]);
  });

  it("runtime: a bare 403 with no time cools for modelCooldownMs (marker + fallback)", async () => {
    const cool = makeCool();
    const { pi, promise } = startPool(
      makeCall([makeTask("t1")]),
      {
        ...BASE_CONFIG,
        workers: 1,
        maxParallel: 1,
        workerModels: ["model-a"],
        modelCooldownMs: 120_000,
      },
      coolDeps(cool),
    );
    respondByNode(pi, "t1#a1", { status: "failed", error: "403 Forbidden" });
    const result = expectResult(await promise);
    expect(result.results[0]).toMatchObject({
      status: "failed",
      error: "host:failed",
      attempts: 1,
    });
    expect(cool.store.activeCooldowns(["model-a"], cool.now)).toStrictEqual([
      { model: "model-a", reason: "window", remainingMs: 120_000 },
    ]);
  });

  it("runtime: a timeout cools for modelCooldownMs with reason timeout", async () => {
    const cool = makeCool();
    const { pi, promise } = startPool(
      makeCall([makeTask("t1")]),
      {
        ...BASE_CONFIG,
        workers: 1,
        maxParallel: 1,
        workerModels: ["model-a"],
        modelCooldownMs: 120_000,
      },
      coolDeps(cool),
    );
    respondByNode(pi, "t1#a1", { status: "timed_out" });
    const result = expectResult(await promise);
    expect(result.results[0]).toMatchObject({ status: "failed", error: "timeout", attempts: 1 });
    expect(cool.store.activeCooldowns(["model-a"], cool.now)).toStrictEqual([
      { model: "model-a", reason: "timeout", remainingMs: 120_000 },
    ]);
  });

  it("runtime: a parsed retry-after clamps into the config bounds", async () => {
    for (const [error, clamped] of [
      ["quota exceeded, retry after 2 hours", 3_600_000],
      ["rate limit exceeded, retry in 1s", 30_000],
    ] as const) {
      const cool = makeCool();
      const { pi, promise } = startPool(
        makeCall([makeTask("t1")]),
        {
          ...BASE_CONFIG,
          workers: 1,
          maxParallel: 1,
          workerModels: ["model-a"],
          modelCooldownMs: 120_000,
        },
        coolDeps(cool),
      );
      respondByNode(pi, "t1#a1", { status: "failed", error });
      const result = expectResult(await promise);
      expect(result.results[0]).toMatchObject({
        status: "failed",
        error: "host:failed",
        attempts: 1,
      });
      expect(cool.store.activeCooldowns(["model-a"], cool.now)).toStrictEqual([
        { model: "model-a", reason: "window", remainingMs: clamped },
      ]);
    }
  });

  it("runtime: an expired cooldown returns the model to dispatch mid-call", async () => {
    const cool = makeCool();
    cool.store.enterCooldown("model-a", "window", 60_000, cool.now);
    const { pi, promise } = startPool(
      makeCall(["t1", "t2", "t3", "t4"].map((id) => makeTask(id))),
      { ...BASE_CONFIG, maxParallel: 8, workerModels: ["model-a", "model-b"] },
      coolDeps(cool),
    );
    // model-a is cooling, so the first wave is model-b only (clamped width 2).
    expect(pi.host.requests.map((request) => request.nodeId)).toStrictEqual(["t1#a1", "t2#a1"]);
    expect(pi.host.requests.every((request) => request.model === "model-b")).toBe(true);

    respondByNode(pi, "t1#a1");
    await tick();
    // t3 goes to the still-saturated model-b, model-a is still cooling.
    const t3 = pi.host.requests.find((request) => request.nodeId === "t3#a1");
    expect(t3?.model).toBe("model-b");

    // Past the expiry model-a is back in the rotation and takes t4.
    cool.now = 61_000;
    respondByNode(pi, "t2#a1");
    await tick();
    const t4 = pi.host.requests.find((request) => request.nodeId === "t4#a1");
    expect(t4?.model).toBe("model-a");

    for (const id of ["t3#a1", "t4#a1"]) {
      respondByNode(pi, id);
      await tick();
    }
    const result = expectResult(await promise);
    // The snapshot row is the START-of-call one: model-a cooled for a minute at
    // cool.now === 0, so the row names that model and its 60s remainder even
    // though the model came back mid-call (clamps are not rewritten).
    expect(result.clamps).toStrictEqual([
      {
        field: "cooldown",
        requested: 4,
        applied: 2,
        reason:
          `per-model cap 2 × 1 of 2 model(s) cool — 1 model(s) cooling down (up to ` +
          `60s left: model-a window ${formatCooldownRemaining(60_000)})`,
      },
    ]);
    expect(result.results.every((row) => row.status === "done")).toBe(true);
    expect(pi.host.cancels).toHaveLength(0);
  });
});
