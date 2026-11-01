/**
 * Rate-limit window FR-011 (design rev.5.2 §4 pool "Окно rate-limit", §11;
 * TD-006): a per-model counter of CONSECUTIVE window-class failures —
 * window-429 bumps it, any other outcome of that model resets it; at 5 the
 * model is excluded from NEW launches only. Its running children are never
 * cancelled (zero :cancel from the pool): completed ones are accepted, failed
 * ones stay terminal with their original cause. With no active model left the
 * unstarted queue drains failed(no-available-model). Timeout on the only
 * model neither excludes nor drains; overload never counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ValidatedFusionCall,
  ValidatedTask,
} from "../extensions/pi-fusion/contract/validate.ts";
import {
  type FanoutConfig,
  type FanoutDeps,
  runFanout,
} from "../extensions/pi-fusion/pool/fanout.ts";
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

const WINDOW_429 = { status: "failed" as const, error: "HTTP 429: rate limit exceeded — quota" };
const OVERLOAD = { status: "failed" as const, error: "server busy — try again later (529)" };

const BASE_CONFIG: FanoutConfig = {
  workers: 16,
  maxParallel: 8,
  taskTimeoutMs: 60_000,
  workerModels: ["model-a", "model-b"],
  maxSteps: 100,
};

function makeTasks(count: number): ValidatedTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    title: `t${index + 1}`,
    instructions: `instructions for t${index + 1}`,
    role: "worker",
  }));
}

function startPool(
  contract: ValidatedFusionCall,
  config: FanoutConfig,
  overrides: Partial<FanoutDeps> = {},
): { pi: FakePi; promise: Promise<FanoutResult | { seamUnavailable: true }> } {
  const pi = createFakePi();
  const deps: FanoutDeps = {
    contract,
    config,
    available: () => true,
    makeClient: () => createFanoutSeamClient({ events: pi.events, cwd: "/repo" }),
    ...overrides,
  };
  return { pi, promise: runFanout(deps) };
}

function expectResult(result: FanoutResult | { seamUnavailable: true }): FanoutResult {
  if (!("results" in result)) {
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

const windowFailFor =
  (model: string) =>
  (request: DelegationRequest): TerminalOverrides =>
    request.model === model ? WINDOW_429 : {};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("model window (FR-011)", () => {
  it("excludes a model after 5 consecutive window-429s; no :cancel; children finish", async () => {
    const { pi, promise } = startPool(makeCall(makeTasks(14)), { ...BASE_CONFIG });
    await driveAll(pi, windowFailFor("model-a"));

    const result = expectResult(await promise);
    // model-a takes the round-robin half of width 4. The batch driver keeps
    // two A-launches in flight ahead of the 5th failure, so A ends with six
    // requests; t13/t14 are still queued when the 5th failure lands —
    // and both go to model-b.
    const modelsById = new Map(pi.host.requests.map((request) => [request.nodeId, request.model]));
    const aRequests = pi.host.requests.filter((request) => request.model === "model-a");
    expect(aRequests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t3#a1",
      "t5#a1",
      "t7#a1",
      "t9#a1",
      "t11#a1",
    ]);
    expect(modelsById.get("t13#a1")).toBe("model-b");
    expect(modelsById.get("t14#a1")).toBe("model-b");

    // THE explicit assert: exclusion never cancels anyone.
    expect(pi.host.cancels).toHaveLength(0);

    expect(result.results.map((row) => row.id)).toStrictEqual(
      Array.from({ length: 14 }, (_, index) => `t${index + 1}`),
    );
    for (const row of result.results) {
      const failedOnA = ["t1", "t3", "t5", "t7", "t9", "t11"].includes(row.id);
      if (failedOnA) {
        expect(row).toMatchObject({ status: "failed", error: "host:failed", attempts: 1 });
      } else {
        expect(row).toMatchObject({ status: "done", attempts: 1 });
      }
    }
  });

  it("resets the counter on any other outcome of the model (done at streak 4)", async () => {
    const { pi, promise } = startPool(makeCall18(), BASE_CONFIG);
    // t9 completes on model-a: the streak 1-2-3-4 resets to 0, so the later
    // failures never reach 5 and model-a keeps taking launches to the end.
    await driveAll(pi, (request) => {
      if (request.nodeId === "t9#a1") {
        return {};
      }
      return windowFailFor("model-a")(request);
    });

    const result = expectResult(await promise);
    const aRequests = pi.host.requests.filter((request) => request.model === "model-a");
    expect(aRequests).toHaveLength(9); // t1,t3,t5,t7,t9,t11,t13,t15,t17 — never excluded
    expect(result.results.every((row) => row.error !== "no-available-model")).toBe(true);
    const failedCount = result.results.filter((row) => row.status === "failed").length;
    expect(failedCount).toBe(8); // t9 is the reset; every other model-a launch failed
    expect(pi.host.cancels).toHaveLength(0);
  });

  it("drains the unstarted queue when the last model is excluded; children still finish", async () => {
    const { pi, promise } = startPool(makeCall(makeTasks(7)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    // Width 2: t1,t2 launch first, t3..t7 wait in the queue.
    for (const nodeId of ["t1#a1", "t3#a1", "t4#a1", "t5#a1", "t6#a1"]) {
      respondByNode(pi, nodeId, WINDOW_429);
      await tick();
    }
    // After the 5th failure model-a is gone: t7 was drained, t2 (still
    // running, a child of the excluded model) is untouched and uncancelled.
    expect(pi.host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
      "t3#a1",
      "t4#a1",
      "t5#a1",
      "t6#a1",
    ]);
    expect(pi.host.cancels).toHaveLength(0);

    // The running child finishes naturally and its result is accepted.
    respondByNode(pi, "t2#a1");
    await tick();
    const result = expectResult(await promise);
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t2")).toMatchObject({ status: "done", attempts: 1 });
    expect(byId.get("t7")).toMatchObject({
      status: "failed",
      error: "no-available-model",
      attempts: 0,
    });
    for (const id of ["t1", "t3", "t4", "t5", "t6"]) {
      expect(byId.get(id)).toMatchObject({ status: "failed", error: "host:failed", attempts: 1 });
    }
  });

  it("a timeout on the only model excludes nothing and drains nothing", async () => {
    const { pi, promise } = startPool(makeCall(makeTasks(4)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    respondByNode(pi, "t1#a1", { status: "timed_out" });
    await tick();
    // The model is untouched: the released slot goes straight back to it.
    expect(pi.host.requests.find((request) => request.nodeId === "t3#a1")?.model).toBe("model-a");
    respondByNode(pi, "t2#a1");
    await tick();
    respondByNode(pi, "t3#a1");
    await tick();
    respondByNode(pi, "t4#a1");
    await tick();

    const result = expectResult(await promise);
    expect(pi.host.requests).toHaveLength(4);
    expect(pi.host.cancels).toHaveLength(0);
    expect(result.results.every((row) => row.error !== "no-available-model")).toBe(true);
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t1")).toMatchObject({ status: "failed", error: "timeout" });
    expect(byId.get("t1")?.summary).toContain("taskTimeoutMs");
    for (const id of ["t2", "t3", "t4"]) {
      expect(byId.get(id)).toMatchObject({ status: "done" });
    }
  });

  it("overload failures never grow the window counter, even 5 in a row", async () => {
    const { pi, promise } = startPool(makeCall(makeTasks(5)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    await driveAll(pi, () => OVERLOAD);

    const result = expectResult(await promise);
    expect(pi.host.requests).toHaveLength(5);
    expect(pi.host.requests.every((request) => request.model === "model-a")).toBe(true);
    expect(pi.host.cancels).toHaveLength(0);
    expect(result.results.every((row) => row.error === "host:429-overload")).toBe(true);
    expect(result.results.every((row) => row.error !== "no-available-model")).toBe(true);
  });
});

function makeCall(tasks: ValidatedTask[], maxWorkers?: number): ValidatedFusionCall {
  return maxWorkers === undefined ? { tasks } : { tasks, maxWorkers };
}

function makeCall18(): ValidatedFusionCall {
  return makeCall(makeTasks(18));
}
