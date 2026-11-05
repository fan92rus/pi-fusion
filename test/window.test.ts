/**
 * Model cooldown (openspec/changes/fusion-model-cooldown, design D3 "Integration
 * into pool/fanout.ts", D4 "seam/client.ts: marker 403", D8 "Tests (TDD, red
 * pins first)"; spec requirements "Immediate cooldown on a window error or
 * timeout", "Duration cooldown is taken from the error", "Flying children are
 * not cancelled", "Overload is not an account", "Repeat error does not shorten
 * the cooldown", "Fully cooled rotation is fail-fast").
 *
 * FR-011's consecutive-failure STREAK IS GONE — deliberately, per design D3's
 * override: the FIRST window-class error (or the FIRST timeout) puts a model
 * into a cooldown, and a cooled model leaves dispatch for exactly the length of
 * that cooldown, not for the rest of the call. The streak pins of the earlier
 * revision of this file (5 window-429s to exclude, reset on any other outcome)
 * died with the feature and are replaced by the cooldown pins below.
 *
 * What the pool still guarantees: a model leaving the rotation never sends
 * :cancel (its flying children finish naturally and completed ones are
 * accepted), overload never cools, and a queue that cannot start drains
 * failed(no-available-model) with a summary that names the cooldowns.
 *
 * The store and the clock are INJECTED (design D1): every pin drives a virtual
 * clock, so a cooldown remainder is an exact number, never wall time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ValidatedFusionCall,
  ValidatedTask,
} from "../extensions/pi-fusion/contract/validate.ts";
import {
  type CooldownStore,
  createCooldownStore,
  formatCooldownRemaining,
} from "../extensions/pi-fusion/pool/cooldown.ts";
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

/** A window-class error the NEW marker (\b403\b, design D4) alone recognises. */
const WINDOW_403 = { status: "failed" as const, error: "403 Forbidden" };
/** A window-class error the pre-existing markers recognise. */
const WINDOW_QUOTA = { status: "failed" as const, error: "HTTP 429: rate limit exceeded — quota" };
/** A window-class error whose text carries a retry-after the parser must read. */
const WINDOW_30S = { status: "failed" as const, error: "403 Forbidden — retry after 30 seconds" };
const OVERLOAD = { status: "failed" as const, error: "server busy — try again later (529)" };
const PLAIN_FAIL = { status: "failed" as const, error: "SyntaxError in worker" };
const TIMEOUT = { status: "timed_out" as const };

const BASE_CONFIG: FanoutConfig = {
  workers: 16,
  maxParallel: 8,
  taskTimeoutMs: 60_000,
  workerModels: ["model-a", "model-b"],
  maxSteps: 100,
  modelCooldownMs: 300_000,
};

function makeTasks(count: number): ValidatedTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    title: `t${index + 1}`,
    instructions: `instructions for t${index + 1}`,
    role: "worker",
  }));
}

interface Cooldowns {
  store: CooldownStore;
  now: number;
}

/**
 * Starts a fan-out with an INJECTED cooldown store driven by a virtual clock
 * (design D1: the pool never reads wall time, the store is the caller's). The
 * store may be pre-cooled before the call starts — that is how a call begins
 * with models already off dispatch.
 */
function startPool(
  contract: ValidatedFusionCall,
  config: FanoutConfig,
  overrides: Partial<FanoutDeps> = {},
  cool: (store: CooldownStore, now: number) => void = () => {},
): { pi: FakePi; promise: Promise<FanoutResult | { seamUnavailable: true }>; cool: Cooldowns } {
  const cooldowns: Cooldowns = { store: createCooldownStore(), now: 0 };
  cool(cooldowns.store, cooldowns.now);
  const pi = createFakePi();
  const deps: FanoutDeps = {
    contract,
    config,
    available: () => true,
    cooldowns: {
      store: cooldowns.store,
      clock: { now: () => cooldowns.now },
    },
    makeClient: () => createFanoutSeamClient({ events: pi.events, cwd: "/repo" }),
    ...overrides,
  };
  return { pi, promise: runFanout(deps), cool: cooldowns };
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

/** The launches of one model, in bus order. */
const launchOrder = (pi: FakePi, model: string): string[] =>
  pi.host.requests.filter((request) => request.model === model).map((request) => request.nodeId);

const windowFailFor =
  (model: string, overrides: TerminalOverrides = WINDOW_403) =>
  (request: DelegationRequest): TerminalOverrides =>
    request.model === model ? overrides : {};

/** The cooling models of the rotation, as recorded when the call finished. */
const cooling = (cool: Cooldowns, models: readonly string[]): Array<[string, number]> =>
  cool.store.activeCooldowns(models, cool.now).map((entry) => [entry.model, entry.remainingMs]);

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cooldown: the first window error cools the model (FR-011 override)", () => {
  it("first 403 on model-a → model-a off dispatch; the queue goes to model-b; zero :cancel", async () => {
    const pool = startPool(makeCall(makeTasks(8)), { ...BASE_CONFIG });
    await driveAll(pool.pi, windowFailFor("model-a", WINDOW_403));

    const result = expectResult(await pool.promise);
    // model-a took exactly its two first-wave launches; every later task went
    // to model-b because model-a is cooling.
    expect(launchOrder(pool.pi, "model-a")).toStrictEqual(["t1#a1", "t3#a1"]);
    for (const id of ["t5#a1", "t6#a1", "t7#a1", "t8#a1"]) {
      expect(pool.pi.host.requests.find((request) => request.nodeId === id)?.model).toBe("model-b");
    }
    // THE explicit assert: a cooldown never cancels anyone.
    expect(pool.pi.host.cancels).toHaveLength(0);

    expect(result.results.map((row) => row.id)).toStrictEqual(
      Array.from({ length: 8 }, (_, index) => `t${index + 1}`),
    );
    for (const row of result.results) {
      if (row.id === "t1" || row.id === "t3") {
        expect(row).toMatchObject({ status: "failed", error: "host:failed", attempts: 1 });
      } else {
        expect(row).toMatchObject({ status: "done", attempts: 1 });
      }
    }
    // The store carries the cooldown the WHOLE call used: fallback modelCooldownMs.
    expect(cooling(pool.cool, ["model-a", "model-b"])).toStrictEqual([["model-a", 300_000]]);
  });

  it("an existing window marker behaves the same way (quota/rate limit class)", async () => {
    const pool = startPool(makeCall(makeTasks(4)), { ...BASE_CONFIG, workerModels: ["model-a"] });
    await driveAll(pool.pi, windowFailFor("model-a", WINDOW_QUOTA));

    const result = expectResult(await pool.promise);
    // Width 2 on one model: the first window failure cools it, so the queue
    // drains instead of running on it. t2 was flying when the cooldown began
    // — it was answered on its own terms, never cancelled.
    expect(pool.pi.host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
    ]);
    expect(pool.pi.host.cancels).toHaveLength(0);
    const byId = new Map(result.results.map((row) => [row.id, row]));
    for (const id of ["t1", "t2"]) {
      expect(byId.get(id)).toMatchObject({ status: "failed", error: "host:failed", attempts: 1 });
    }
    for (const id of ["t3", "t4"]) {
      expect(byId.get(id)).toMatchObject({
        status: "failed",
        error: "no-available-model",
        attempts: 0,
      });
      expect(byId.get(id)?.summary).toContain("cooling");
    }
    expect(cooling(pool.cool, ["model-a"])).toStrictEqual([["model-a", 300_000]]);
  });

  it("the first timeout cools the model too, with reason timeout (spec scenario)", async () => {
    const pool = startPool(makeCall(makeTasks(4)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    respondByNode(pool.pi, "t1#a1", TIMEOUT);
    await tick();
    respondByNode(pool.pi, "t2#a1");
    await tick();

    const result = expectResult(await pool.promise);
    // The cooled model gets no new launch: t3/t4 drained with the cooldown
    // summary; t2 (flying when the cooldown began) was accepted.
    expect(pool.pi.host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
    ]);
    expect(pool.pi.host.cancels).toHaveLength(0);
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t1")).toMatchObject({ status: "failed", error: "timeout", attempts: 1 });
    expect(byId.get("t1")?.summary).toContain("taskTimeoutMs");
    expect(byId.get("t2")).toMatchObject({ status: "done", attempts: 1 });
    for (const id of ["t3", "t4"]) {
      expect(byId.get(id)).toMatchObject({
        status: "failed",
        error: "no-available-model",
        attempts: 0,
      });
      expect(byId.get(id)?.summary).toContain("cooling");
    }
    expect(cooling(pool.cool, ["model-a"])).toStrictEqual([["model-a", 300_000]]);
  });

  it("a non-window failure and a report never cool the model (rotation unchanged)", async () => {
    const pool = startPool(makeCall(makeTasks(4)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    await driveAll(pool.pi, windowFailFor("model-a", PLAIN_FAIL));

    const result = expectResult(await pool.promise);
    expect(pool.pi.host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
      "t3#a1",
      "t4#a1",
    ]);
    expect(pool.pi.host.cancels).toHaveLength(0);
    expect(result.results.every((row) => row.error === "host:failed")).toBe(true);
    expect(cooling(pool.cool, ["model-a"])).toStrictEqual([]);
  });
});

describe("cooldown: overload and re-offence (spec scenarios)", () => {
  it("overload (429-overload) never cools, even 5 in a row", async () => {
    const pool = startPool(makeCall(makeTasks(5)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    await driveAll(pool.pi, () => OVERLOAD);

    const result = expectResult(await pool.promise);
    expect(pool.pi.host.requests).toHaveLength(5);
    expect(pool.pi.host.requests.every((request) => request.model === "model-a")).toBe(true);
    expect(pool.pi.host.cancels).toHaveLength(0);
    expect(result.results.every((row) => row.error === "host:429-overload")).toBe(true);
    expect(cooling(pool.cool, ["model-a"])).toStrictEqual([]);
  });

  it("a re-offence does not shorten the cooldown: 'retry after 30 seconds' keeps ~5m", async () => {
    const pool = startPool(makeCall(makeTasks(4)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    // t1 cools model-a for the fallback 5m; t2 (its flying child) re-offends
    // with a 30-second retry-after.
    respondByNode(pool.pi, "t1#a1", WINDOW_403);
    await tick();
    respondByNode(pool.pi, "t2#a1", WINDOW_30S);
    await tick();

    const result = expectResult(await pool.promise);
    expect(pool.pi.host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
    ]);
    expect(pool.pi.host.cancels).toHaveLength(0);
    const byId = new Map(result.results.map((row) => [row.id, row]));
    for (const id of ["t3", "t4"]) {
      expect(byId.get(id)).toMatchObject({
        status: "failed",
        error: "no-available-model",
        attempts: 0,
      });
    }
    // MAX rule: still the original 5 minutes, not 30 seconds.
    expect(cooling(pool.cool, ["model-a"])).toStrictEqual([["model-a", 300_000]]);
  });

  it("a re-offence by a timeout keeps the remainder and refreshes the reason", async () => {
    const pool = startPool(makeCall(makeTasks(4)), {
      ...BASE_CONFIG,
      workerModels: ["model-a"],
    });
    respondByNode(pool.pi, "t1#a1", WINDOW_403);
    await tick();
    respondByNode(pool.pi, "t2#a1", TIMEOUT);
    await tick();

    const result = expectResult(await pool.promise);
    expect(pool.pi.host.cancels).toHaveLength(0);
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t3")).toMatchObject({ status: "failed", error: "no-available-model" });
    // reason follows the latest error, remainder follows the max rule
    expect(
      pool.cool.store
        .activeCooldowns(["model-a"], pool.cool.now)
        .map((entry) => [entry.model, entry.reason, entry.remainingMs]),
    ).toStrictEqual([["model-a", "timeout", 300_000]]);
  });

  it("the remainder of a cooling model renders through the formatter (42 500ms → 43s)", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-a", "window", 42_500, 0);
    expect(
      store
        .activeCooldowns(["model-a"], 0)
        .map((entry) => formatCooldownRemaining(entry.remainingMs)),
    ).toStrictEqual(["43s"]);
  });
});

function makeCall(tasks: ValidatedTask[], maxWorkers?: number): ValidatedFusionCall {
  return maxWorkers === undefined ? { tasks } : { tasks, maxWorkers };
}
