/**
 * End-to-end fan-out through the registered `fusion_delegate` tool (design
 * rev.5.2 §10.9 scenarios, §11 Integration). The tool runs on the real seam
 * client and pool; only the delegation bus is faked (test/fake-pi.ts).
 *
 * Deviation from the letter of design §10.9(б) (five tasks): scenario (б) runs
 * E2E_B_TASKS tasks. Decision by the supervisor for hi7 rework round 1, arithmetic:
 * with two models and strict round-robin, model A's launches are t1,t3,t5,t7,t9,
 * so the 5th window failure is t9's and a task queued for B exists only from
 * N=10 (t10). Five tasks would leave no queue on B at exclusion. The bd notes of
 * pi-fusion-hi7 are to record the same decision (orchestrator). Scenario (а) keeps
 * exactly five tasks.
 */
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  FUSION_CONFIG_DEFAULTS,
  type FusionConfig,
} from "../extensions/pi-fusion/config-bridge.ts";
import { registerFusionDelegate, toPiUsage } from "../extensions/pi-fusion/index.ts";
import type { FanoutResult } from "../extensions/pi-fusion/types.ts";
import {
  createFakePi,
  type DelegationRequest,
  type DelegationStatus,
  type FakeDelegationHost,
  type RespondOverrides,
} from "./fake-pi.ts";

/** Drains microtask cascades (settle → dispatch → :request). */
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const WINDOW_429 = { status: "failed" as const, error: "HTTP 429: rate limit exceeded — quota" };
const USAGE = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.5,
  turns: 2,
  toolCalls: 4,
  durationMs: 1000,
};

function report(
  status: "done" | "no_changes" | "failed" | "needs_orchestrator",
  summary: string,
  question = "which module owns this?",
) {
  return {
    kind: "structured" as const,
    value: {
      status,
      summary,
      filesChanged: status === "no_changes" ? [] : ["src/a.ts"],
      evidence: ["checked"],
      residualRisks: [],
      ...(status === "needs_orchestrator" ? { question } : {}),
    },
  };
}

function makeTasks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    instructions: `instructions for t${index + 1}`,
  }));
}

function setup(config: FusionConfig, withBus = true) {
  const fake = createFakePi();
  let tool: ToolDefinition | undefined;
  const api = {
    events: withBus ? fake.events : undefined,
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
    on: () => () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  registerFusionDelegate(api as unknown as ExtensionAPI, config);
  const execute = (params: unknown, signal?: AbortSignal) => {
    if (tool === undefined) throw new Error("fusion_delegate was not registered");
    return tool.execute("call-1", params, signal, undefined, {
      cwd: "/repo",
      signal,
    } as unknown as ExtensionToolContext);
  };
  return { host: fake.host, execute };
}

/**
 * Answers every request the pool emits (new waves included) until the bus is
 * quiet. Returns the largest number of live workers per model it observed.
 */
async function drive(
  host: FakeDelegationHost,
  decide: (request: DelegationRequest) => TerminalOverrides | null,
): Promise<Map<string, number>> {
  const maxLive = new Map<string, number>();
  for (let round = 0; ; round += 1) {
    if (round > 1000) throw new Error("drive: no progress");
    const pending = host.pendingRequestIds();
    if (pending.length === 0) break;
    const live = new Map<string, number>();
    for (const requestId of pending) {
      const request = host.getPending(requestId);
      if (request?.model !== undefined) {
        live.set(request.model, (live.get(request.model) ?? 0) + 1);
      }
    }
    for (const [model, count] of live) {
      maxLive.set(model, Math.max(maxLive.get(model) ?? 0, count));
    }
    for (const requestId of pending) {
      const request = host.getPending(requestId);
      // null keeps the request running across this round (a held child).
      const answer = request === undefined ? null : decide(request);
      if (request !== undefined && answer !== null) host.respond(requestId, answer);
    }
    await tick();
  }
  return maxLive;
}

/** A terminal answer for the fake host (invalid_request is never a worker outcome here). */
type TerminalOverrides = RespondOverrides & {
  status?: Exclude<DelegationStatus, "invalid_request">;
};

function asFanout(value: unknown): FanoutResult {
  return value as FanoutResult;
}

const CONFIG: FusionConfig = {
  ...FUSION_CONFIG_DEFAULTS,
  enabled: true,
  workers: 3,
  maxParallel: 3,
  taskTimeoutMs: 600_000,
  workerModels: ["model-a"],
  maxSteps: 60,
};

describe("E2E scenario (а): width clamp, one model, timeout", () => {
  it("5 tasks, width requested 3 → applied 2 on one model; timeout fails one task and the call goes on", async () => {
    const { host, execute } = setup(CONFIG);
    const promise = execute({ tasks: makeTasks(5), maxWorkers: 3 });
    const maxLive = await drive(host, (request) =>
      request.nodeId === "t1#a1"
        ? { status: "timed_out" }
        : { result: report("done", `${request.nodeId} finished`), usage: USAGE },
    );
    const outcome = await promise;
    const result = asFanout(outcome.structuredContent);

    // THE explicit clamp assert (design §10.9(а), n3-R6).
    expect(result.clamps).toHaveLength(1);
    expect(result.clamps[0]).toMatchObject({ field: "perModel", requested: 3, applied: 2 });
    expect(CONFIG.maxParallel).toBeGreaterThanOrEqual(3);
    expect(maxLive.get("model-a")).toBe(2);

    expect(result.results.map((row) => row.id)).toStrictEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(result.results[0]).toMatchObject({ status: "failed", error: "timeout", attempts: 1 });
    expect(result.results[0]?.summary).toContain("taskTimeoutMs");
    expect(result.results.slice(1).map((row) => row.status)).toStrictEqual([
      "done",
      "done",
      "done",
      "done",
    ]);

    // Partial usage: the timed-out task carries no terminal usage (unknown ≠ 0).
    expect(result.usagePartial).toBe(true);
    expect(result.usage.input).toBe(USAGE.input * 4);
    expect(outcome.usage).toStrictEqual(toPiUsage(result.usage));

    // Text table (design §7): one row per task in index order, clamp line, usage line.
    const lines = outcome.content[0]?.type === "text" ? outcome.content[0].text.split("\n") : [];
    expect(lines[0]).toMatch(/^t1 · failed · .* · -$/);
    expect(lines[4]).toMatch(/^t5 · done · /);
    expect(lines[5]).toBe("clamp perModel: 3 → 2 (per-model cap 2 × 1 model(s))");
    expect(lines[6]).toMatch(/^usage: input=400, .* · часть usage неизвестна$/);
    expect(outcome.details).toBe("5 task(s): 4 done, 1 failed; usage partial");
  });
});

describe("E2E: pre-flight refusal (FR-009)", () => {
  it("without a seam bus the whole call is refused with the explicit order and zero workers", async () => {
    const { host, execute } = setup(CONFIG, false);
    const outcome = await execute({ tasks: makeTasks(3) });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toStrictEqual([
      { type: "text", text: "fusion недоступен — делай работу сам" },
    ]);
    expect(outcome.structuredContent).toBeUndefined();
    expect(host.requests).toHaveLength(0);
  });
});

/**
 * Task count of scenario (б): the minimum under strict round-robin that leaves a
 * task queued for model B when A's 5th window failure lands (see the file header;
 * supervisor decision).
 */
const E2E_B_TASKS = 10;

describe("E2E scenario (б): window exclusion, mixed outcomes", () => {
  it(`${E2E_B_TASKS} tasks, width 3, 2 models: A excluded after 5 window-429s, queue on B, zero :cancel`, async () => {
    const { host, execute } = setup({
      ...CONFIG,
      workerModels: ["model-a", "model-b"],
    });
    const promise = execute({ tasks: makeTasks(E2E_B_TASKS), maxWorkers: 3 });
    let aWindowFailures = 0;
    let queuedForBAtExclusion = false;
    await drive(host, (request) => {
      if (request.model === "model-a") {
        aWindowFailures += 1;
        if (aWindowFailures === 5) {
          queuedForBAtExclusion = !host.requests.some((r) => r.nodeId === `t${E2E_B_TASKS}#a1`);
        }
        // Children of A that were already running when it was excluded finish normally.
        return aWindowFailures <= 5
          ? WINDOW_429
          : { result: report("done", `${request.nodeId} accepted after exclusion`) };
      }
      switch (request.nodeId) {
        case "t2#a1":
          return { result: report("done", "t2 done") };
        case "t4#a1":
          return { result: report("no_changes", "t4 nothing to change") };
        case "t6#a1":
          return { status: "failed", error: "boom" };
        case "t8#a1":
          return {
            result: report("needs_orchestrator", "t8 needs a decision", "t8 needs a decision"),
          };
        case "t10#a1":
          // Schema violation on the first run: one corrective run on the same model (FR-007).
          return { status: "structured_output_failed" };
        default:
          return { result: report("done", `${request.nodeId} done`) };
      }
    });
    const outcome = await promise;
    const result = asFanout(outcome.structuredContent);

    // THE explicit assert: exclusion never cancels anyone (FR-011).
    expect(host.cancels).toHaveLength(0);

    // A is never launched again after the 5th window failure: its launches are t1..t9 odd.
    const launchesOnA = host.requests
      .filter((request) => request.model === "model-a")
      .map((request) => request.nodeId);
    expect(launchesOnA).toStrictEqual(["t1#a1", "t3#a1", "t5#a1", "t7#a1", "t9#a1"]);
    expect(queuedForBAtExclusion).toBe(true);
    expect(host.requests.find((request) => request.nodeId === "t10#a1")?.model).toBe("model-b");

    expect(result.results.map((row) => row.id)).toStrictEqual(
      Array.from({ length: E2E_B_TASKS }, (_, index) => `t${index + 1}`),
    );
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t1")).toMatchObject({ status: "failed", error: "host:failed" });
    expect(byId.get("t2")).toMatchObject({ status: "done", summary: "t2 done" });
    expect(byId.get("t4")).toMatchObject({ status: "no_changes" });
    expect(byId.get("t6")).toMatchObject({ status: "failed", error: "host:failed" });
    expect(byId.get("t8")).toMatchObject({
      status: "needs_orchestrator",
      question: "t8 needs a decision",
    });
    expect(byId.get("t10")).toMatchObject({ status: "done", attempts: 2 });
    expect(host.requests.find((request) => request.nodeId === "t10#a2")?.model).toBe("model-b");
    expect(host.responses.some((response) => response.status === "invalid_request")).toBe(false);
  });
});

describe("E2E: Esc cancels in-flight children with :cancel, then the partial result comes back", () => {
  it("sends :cancel for each in-flight request before dispose; queued tasks are cancelled", async () => {
    const { host, execute } = setup({ ...CONFIG, workerModels: ["model-a", "model-b"] });
    const controller = new AbortController();
    const promise = execute({ tasks: makeTasks(4), maxWorkers: 3 }, controller.signal);
    // Width 3 → t1..t3 in flight, t4 queued.
    expect(host.pendingRequestIds()).toHaveLength(3);
    controller.abort();
    const outcome = await promise;
    const result = asFanout(outcome.structuredContent);

    const inFlight = host.requests.slice(0, 3).map((request) => request.requestId);
    expect(host.cancels.map((cancel) => cancel.requestId).sort()).toStrictEqual(
      [...inFlight].sort(),
    );
    for (const cancel of host.cancels) {
      expect(cancel.ownerRunId).toMatch(/^fusion-/);
      expect(cancel.nodeId).toMatch(/#a1$/);
    }
    expect(result.results.map((row) => row.status)).toStrictEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(result.results[3]).toMatchObject({ attempts: 0 });
  });
});

describe("E2E: schema-failed twice → one corrective run, then schema-missing (FR-007)", () => {
  it("fails the task with schemaMissing after the corrective run fails too; the other task is unaffected", async () => {
    const { host, execute } = setup(CONFIG);
    const promise = execute({ tasks: makeTasks(2) });
    await drive(host, (request) =>
      request.nodeId.startsWith("t1#")
        ? { status: "structured_output_failed" }
        : { result: report("done", "t2 done") },
    );
    const result = asFanout((await promise).structuredContent);

    expect(host.requests.map((request) => request.nodeId)).toStrictEqual([
      "t1#a1",
      "t2#a1",
      "t1#a2",
    ]);
    expect(result.results[0]).toMatchObject({
      status: "failed",
      error: "schema-missing",
      schemaMissing: true,
      attempts: 2,
    });
    expect(result.results[1]).toMatchObject({ status: "done", attempts: 1 });
    expect(host.cancels).toHaveLength(0);
  });
});

describe("E2E: a child still running on the excluded model is accepted when it completes (FR-011)", () => {
  it("the 5th window failure lands while t11 runs on A; t11 finishes after the exclusion and is kept", async () => {
    const { host, execute } = setup({
      ...CONFIG,
      workerModels: ["model-a", "model-b"],
    });
    const promise = execute({ tasks: makeTasks(11), maxWorkers: 3 });
    let aWindowFailures = 0;
    await drive(host, (request) => {
      if (request.model !== "model-a") {
        return { result: report("done", `${request.nodeId} done`) };
      }
      if (request.nodeId === "t11#a1") {
        // Still running when A is excluded: it finishes normally afterwards.
        return aWindowFailures < 5 ? null : { result: report("done", "t11 kept") };
      }
      if (request.nodeId === "t9#a1" && !host.requests.some((r) => r.nodeId === "t11#a1")) {
        // Hold the 5th failure until t11 has been launched on A.
        return null;
      }
      aWindowFailures += 1;
      return WINDOW_429;
    });
    const result = asFanout((await promise).structuredContent);

    expect(host.cancels).toHaveLength(0);
    expect(host.requests.find((request) => request.nodeId === "t11#a1")?.model).toBe("model-a");
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t9")).toMatchObject({ status: "failed", error: "host:failed" });
    expect(byId.get("t11")).toMatchObject({ status: "done", summary: "t11 kept" });
  });
});
