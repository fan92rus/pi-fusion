/**
 * Degradation and result surfaces (design rev.5.2 §4 Result/Degradation,
 * §7 UX, §11; FR-005/FR-009/FR-010). Drives the REAL pool over the fake
 * delegation bus (test/fake-pi.ts) and pins what the lead finally sees:
 *
 *  - pre-flight: available() === false → one explicit order, zero workers
 *    (no client, no :request);
 *  - mid-run: unavailable_context fails just that task (seam-unavailable),
 *    the call continues to a partial result and the model is NOT excluded
 *    (a dead seam is not the model's fault);
 *  - the aggregate: rows in task-index order under shuffled completion,
 *    terminal-only usage sums (absent = unknown → usagePartial; toolCalls/
 *    durationMs of 0 are "no data"), no_changes passthrough, done with an
 *    empty filesChanged staying done, the timeout hint surviving into the
 *    text table, clamp lines and the usage line with its partial note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ValidatedFusionCall,
  ValidatedTask,
} from "../extensions/pi-fusion/contract/validate.ts";
import {
  isDegradationRefusal,
  renderDegradationRefusal,
  SEAM_UNAVAILABLE_ORDER,
} from "../extensions/pi-fusion/degradation.ts";
import {
  type DegradationRefusal,
  type FanoutConfig,
  type FanoutDeps,
  runFanout,
} from "../extensions/pi-fusion/pool/fanout.ts";
import { renderFanoutText, summarizeFanout } from "../extensions/pi-fusion/result.ts";
import { createFanoutSeamClient } from "../extensions/pi-fusion/seam/client.ts";
import type { FanoutResult } from "../extensions/pi-fusion/types.ts";
import {
  createFakePi,
  type DelegationRequest,
  type DelegationStatus,
  type FakePi,
  type RespondOverrides,
} from "./fake-pi.ts";

/** RespondOverrides without the invalid_request literal (host.respond overloads). */
type TerminalOverrides = RespondOverrides & {
  status?: Exclude<DelegationStatus, "invalid_request">;
};

/** Drains microtask cascades (dispatch → launch → :request). */
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function makeTask(id: string, extra: Partial<ValidatedTask> = {}): ValidatedTask {
  return { id, title: id, instructions: `instructions for ${id}`, role: "worker", ...extra };
}

function makeCall(tasks: ValidatedTask[], maxWorkers?: number): ValidatedFusionCall {
  return maxWorkers === undefined ? { tasks } : { tasks, maxWorkers };
}

const CONFIG: FanoutConfig = {
  workers: 4,
  maxParallel: 8,
  taskTimeoutMs: 60_000,
  workerModels: ["model-a", "model-b"],
  maxSteps: 100,
};

interface Pool {
  pi: FakePi;
  promise: Promise<FanoutResult | DegradationRefusal>;
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

function expectResult(result: FanoutResult | DegradationRefusal): FanoutResult {
  if (isDegradationRefusal(result)) {
    throw new Error("expected FanoutResult, got a degradation refusal");
  }
  return result;
}

function requestByNode(pi: FakePi, nodeId: string): DelegationRequest {
  const request = pi.host.requests.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) {
    throw new Error(`no request reached the bus for ${nodeId}`);
  }
  return request;
}

function respondByNode(pi: FakePi, nodeId: string, overrides: TerminalOverrides = {}): void {
  pi.host.respond(requestByNode(pi, nodeId).requestId, overrides);
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

describe("degradation pre-flight (FR-009)", () => {
  it("refuses with the one explicit order and zero workers", async () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    const { pi, promise, clientCreated } = startPool(makeCall(tasks), CONFIG, {
      available: () => false,
    });
    expect(clientCreated).toBe(false);
    expect(pi.host.requests).toHaveLength(0);
    const settled = await promise;
    expect(isDegradationRefusal(settled)).toBe(true);
    expect(renderDegradationRefusal(settled as DegradationRefusal)).toBe(SEAM_UNAVAILABLE_ORDER);
    expect(SEAM_UNAVAILABLE_ORDER).toBe("fusion недоступен — делай работу сам");
  });
});

describe("refusal guard", () => {
  it("distinguishes the refusal from a fan-out result", () => {
    const refusal: DegradationRefusal = { seamUnavailable: true };
    expect(isDegradationRefusal(refusal)).toBe(true);
    expect(isDegradationRefusal({ results: [], clamps: [], usage: {}, usagePartial: false })).toBe(
      false,
    );
  });
});

describe("degradation mid-run (FR-009)", () => {
  it("fails the unavailable task seam-unavailable, continues, excludes no model", async () => {
    const tasks = ["t1", "t2", "t3", "t4"].map((id) => makeTask(id));
    const { pi, promise } = startPool(makeCall(tasks), {
      ...CONFIG,
      workerModels: ["model-a"],
    });
    // width 2 on the single model: t1/t2 go first; t1's child is lost.
    respondByNode(pi, "t1#a1", { status: "unavailable_context" });
    await tick();
    // The freed slot dispatches t3 on the SAME model: a dead seam is not a
    // model fault, so no exclusion and no no-available-model drain happens.
    expect(requestByNode(pi, "t3#a1").model).toBe("model-a");
    await driveAll(pi, (request): RespondOverrides => {
      switch (request.nodeId) {
        case "t2#a1":
          return {
            usage: {
              input: 5,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.5,
              turns: 2,
              toolCalls: 3,
              durationMs: 4000,
            },
          };
        case "t3#a1":
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
        default:
          return {};
      }
    });

    const result = expectResult(await promise);
    expect(result.results.map((row) => [row.id, row.status, row.error])).toStrictEqual([
      ["t1", "failed", "seam-unavailable"],
      ["t2", "done", undefined],
      ["t3", "no_changes", undefined],
      ["t4", "done", undefined],
    ]);
    // Every launch stayed on model-a: the seam loss excluded nothing.
    expect(pi.host.requests.map((request) => request.model)).toStrictEqual([
      "model-a",
      "model-a",
      "model-a",
      "model-a",
    ]);
    // The partial result: the finished tasks as they are, t1 honestly failed.
    expect(result.usage).toStrictEqual({
      input: 5,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.5,
      turns: 2,
      toolCalls: 3,
      durationMs: 4000,
    });
    // unavailableContext carries no usage → t1 has no terminal usage.
    expect(result.usagePartial).toBe(true);
  });
});

describe("result aggregate (FR-005/FR-010)", () => {
  it("keeps rows in task-index order under shuffled completion", async () => {
    const tasks = ["t1", "t2", "t3", "t4"].map((id) => makeTask(id));
    const { pi, promise } = startPool(makeCall(tasks), CONFIG);
    // Completion order t4 → t3 → t2 → t1 (four in flight, answered backwards).
    respondByNode(pi, "t4#a1", {
      result: {
        kind: "structured",
        value: {
          status: "done",
          summary: "fourth",
          filesChanged: ["d4.ts"],
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
    respondByNode(pi, "t2#a1", {
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
    });
    await tick();
    respondByNode(pi, "t1#a1", {
      result: {
        kind: "structured",
        value: {
          status: "done",
          summary: "first",
          filesChanged: [],
          evidence: [],
          residualRisks: [],
        },
      },
    });
    await tick();

    const result = expectResult(await promise);
    expect(result.results.map((row) => row.id)).toStrictEqual(["t1", "t2", "t3", "t4"]);
    // no_changes passes through verbatim; done over an untouched tree stays
    // done — the statuses are NOT conflated (TD-007(б)).
    expect(result.results.map((row) => row.status)).toStrictEqual([
      "done",
      "no_changes",
      "done",
      "done",
    ]);
    // The text table repeats the index order, one row per task.
    const lines = renderFanoutText(result).split("\n");
    expect(lines.slice(0, 4)).toStrictEqual([
      "t1 · done · first · -",
      "t2 · no_changes · nothing to do · -",
      "t3 · done · third · -",
      "t4 · done · fourth · d4.ts",
    ]);
  });

  it("sums terminal usage only; toolCalls/durationMs 0 are 'no data' (FR-010)", async () => {
    const tasks = ["t1", "t2", "t3"].map((id) => makeTask(id));
    const { pi, promise } = startPool(makeCall(tasks), {
      ...CONFIG,
      workerModels: ["model-a"],
    });
    // width 2: t1/t2 first; give t1 live :update snapshots before the terminal.
    const t1 = requestByNode(pi, "t1#a1");
    pi.host.update(t1.requestId, {
      usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, turns: 2 },
    });
    await driveAll(pi, (request): RespondOverrides => {
      switch (request.nodeId) {
        case "t1#a1":
          // The adapter's `?? 0` shape: toolCalls/durationMs 0 = no data.
          return {
            usage: {
              input: 100,
              output: 20,
              cacheRead: 10,
              cacheWrite: 1,
              cost: 0.5,
              turns: 5,
              toolCalls: 0,
              durationMs: 0,
            },
          };
        case "t2#a1":
          return {
            usage: {
              input: 1,
              output: 2,
              cacheRead: 3,
              cacheWrite: 4,
              cost: 0.25,
              turns: 1,
              toolCalls: 9,
              durationMs: 100,
            },
          };
        default:
          // t3: timed out with no usage at all — unknown, not zero.
          return { status: "timed_out" };
      }
    });

    const result = expectResult(await promise);
    // Terminal-only Σ over the tasks: the :update snapshot is NOT summed,
    // t1's zero toolCalls/durationMs do not appear as 0s.
    expect(result.usage).toStrictEqual({
      input: 101,
      output: 22,
      cacheRead: 13,
      cacheWrite: 5,
      cost: 0.75,
      turns: 6,
      toolCalls: 9,
      durationMs: 100,
    });
    expect(result.usagePartial).toBe(true);
    const rows = result.results;
    expect(rows[0]).toMatchObject({ status: "done", turns: 5, turnsObserved: 2 });
    expect(rows[1]).toMatchObject({ status: "done", turns: 1 });
    expect("turnsObserved" in (rows[1] ?? {})).toBe(false);
    // Timeout keeps the honest failure and the hint about the budget.
    expect(rows[2]).toMatchObject({ status: "failed", error: "timeout" });
    expect(rows[2]?.summary).toContain("taskTimeoutMs");
    // The hint survives into the text table.
    expect(renderFanoutText(result)).toContain(
      "t3 · failed · worker hit the local deadline — taskTimeoutMs may be too small · -",
    );
  });
});

describe("fan-out text surfaces (design §4 Result, §7)", () => {
  it("renders clamp lines, the usage line with the partial note, and details", async () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    const { pi, promise } = startPool(makeCall(tasks, 9), CONFIG);
    await driveAll(pi);

    const result = expectResult(await promise);
    const lines = renderFanoutText(result).split("\n");
    expect(lines).toStrictEqual([
      "t1 · done · fake-pi structured result · -",
      "t2 · done · fake-pi structured result · -",
      "clamp maxParallel: 9 → 8 (config.maxParallel is 8)",
      "clamp perModel: 8 → 4 (per-model cap 2 × 2 model(s))",
      "clamp tasks: 4 → 2 (the call carries 2 task(s))",
      "usage: unknown · часть usage неизвестна",
    ]);
    expect(summarizeFanout(result)).toBe("2 task(s): 2 done; usage partial");
  });

  it("renders a complete usage line without the partial note", () => {
    const result: FanoutResult = {
      results: [
        {
          id: "t1",
          status: "needs_orchestrator",
          summary: "blocked",
          filesChanged: ["a.ts"],
          evidence: [],
          residualRisks: [],
          question: "which branch?",
          attempts: 1,
        },
      ],
      clamps: [],
      usage: { input: 7, cost: 0.125, turns: 3 },
      usagePartial: false,
    };
    const lines = renderFanoutText(result).split("\n");
    expect(lines).toStrictEqual([
      "t1 · needs_orchestrator · blocked · a.ts",
      "usage: input=7, cost=0.125, turns=3",
    ]);
    expect(summarizeFanout(result)).toBe("1 task(s): 1 needs_orchestrator");
  });
});
