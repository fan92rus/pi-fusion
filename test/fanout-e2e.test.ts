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
 *
 * fusion-model-cooldown (design D3/D8) replaced the FR-011 streak with a
 * cooldown, so scenario (а) moves its timeout to the LAST task (a timeout now
 * cools the only model, and a cooled model drains the rest of the queue — the
 * call cannot both cool a single-model rotation and keep launching on it) and
 * scenario (б) now pins that ONE window error is enough to take model-a out of
 * dispatch for the remainder of the call. Every setup gets its own cooldown
 * store so scenarios cannot leak cooldowns into each other; the cross-call
 * scenarios below share one store, and one of them reads the process singleton
 * index.ts hands out.
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
import {
  productionCooldownStore,
  registerFusionDelegate,
  toPiUsage,
} from "../extensions/pi-fusion/index.ts";
import { type CooldownStore, createCooldownStore } from "../extensions/pi-fusion/pool/cooldown.ts";
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
const WINDOW_403 = { status: "failed" as const, error: "403 Forbidden" };
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

/** Tasks with a call-scoped id prefix, so two calls cannot collide on a nodeId. */
function makeTasksNamed(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}t${index + 1}`,
    instructions: `instructions for ${prefix}t${index + 1}`,
  }));
}

let e2eSessionCounter = 0;
function setup(
  config: FusionConfig,
  withBus = true,
  cooldownStore: CooldownStore | null = createCooldownStore(),
) {
  const fake = createFakePi();
  let tool: ToolDefinition | undefined;
  const handlers = new Map<string, Array<(payload?: unknown) => void>>();
  const api = {
    events: withBus ? fake.events : undefined,
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
    on: (event: string, handler: (payload?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  registerFusionDelegate(
    api as unknown as ExtensionAPI,
    config,
    // null = inject NOTHING, so the tool uses index.ts's process singleton.
    cooldownStore === null ? {} : { cooldownStore },
  );
  const sid = `e2e-${++e2eSessionCounter}`;
  const branch: any[] = [
    {
      type: "custom",
      customType: "pi-fusion.activation",
      data: { owner: sid, enabled: true, ts: 1 },
    },
  ];
  const sessionManager = {
    getSessionId: () => sid,
    getBranch: () => branch,
    appendEntry: (type: string, data: unknown) => {
      branch.push({ type: "custom", customType: type, data });
    },
  };
  const execute = (params: unknown, signal?: AbortSignal) => {
    if (tool === undefined) throw new Error("fusion_delegate was not registered");
    return tool.execute("call-1", params, signal, undefined, {
      cwd: "/repo",
      signal,
      sessionManager,
    } as unknown as ExtensionToolContext);
  };
  const fire = (event: string, payload?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  return {
    host: fake.host,
    execute,
    fire,
    cooldownStore: cooldownStore ?? productionCooldownStore,
  };
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
  workers: 3,
  maxParallel: 3,
  taskTimeoutMs: 600_000,
  workerModels: ["model-a"],
  maxSteps: 60,
};

describe("E2E scenario (а): width clamp, one model, timeout", () => {
  it("5 tasks, width requested 3 → applied 2 on one model; the last task times out and the call still completes", async () => {
    const { host, execute, cooldownStore } = setup(CONFIG);
    const promise = execute({ tasks: makeTasks(5), maxWorkers: 3 });
    const maxLive = await drive(host, (request) =>
      request.nodeId === "t5#a1"
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
    expect(result.results.slice(0, 4).map((row) => row.status)).toStrictEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(result.results[4]).toMatchObject({ status: "failed", error: "timeout", attempts: 1 });
    expect(result.results[4]?.summary).toContain("taskTimeoutMs");

    // Partial usage: the timed-out task carries no terminal usage (unknown ≠ 0).
    expect(result.usagePartial).toBe(true);
    expect(result.usage.input).toBe(USAGE.input * 4);
    expect(outcome.usage).toStrictEqual(toPiUsage(result.usage));

    // The timeout cooled the model (fusion-model-cooldown: a timeout is a
    // cooldown too), and the clamp chain stays a start-of-call snapshot.
    const cooled = cooldownStore.activeCooldowns(CONFIG.workerModels, Date.now());
    expect(cooled.map((entry) => entry.model)).toStrictEqual(["model-a"]);
    expect(cooled[0]?.reason).toBe("timeout");
    expect(cooled[0]?.remainingMs).toBeGreaterThan(290_000);
    expect(cooled[0]?.remainingMs).toBeLessThanOrEqual(300_000);

    // Text table (design §7): one row per task in index order, clamp line, usage line.
    const lines = outcome.content[0]?.type === "text" ? outcome.content[0].text.split("\n") : [];
    expect(lines[0]).toMatch(/^t1 · done · /);
    expect(lines[4]).toMatch(/^t5 · failed · worker hit the local deadline/);
    expect(lines[5]).toBe("clamp perModel: 3 → 2 (per-model cap 2 × 1 model(s))");
    expect(lines[6]).toMatch(/^usage: input=400, .* · часть usage неизвестна$/);
    expect(outcome.details).toBe("5 task(s): 4 done, 1 failed; usage partial");
  });
});

describe("E2E: original request quoted into briefs", () => {
  it("fires the run capture and every worker brief carries the request as context", async () => {
    const { host, execute, fire } = setup(CONFIG);
    fire("before_agent_start", {
      messageType: "user",
      prompt: "Build a turn-based game, not a landing page",
    });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(2) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    const outcome = await promise;
    const result = asFanout(outcome.structuredContent);
    expect(result.results.map((row) => row.status)).toStrictEqual(["done", "done"]);
    expect(briefs).toHaveLength(2);
    for (const brief of briefs) {
      expect(brief).toContain("ORIGINAL REQUEST — context only; your task is below");
      expect(brief).toContain("Build a turn-based game, not a landing page");
      expect(brief.indexOf("ORIGINAL REQUEST")).toBeLessThan(brief.indexOf("## "));
    }
  });

  it("a short follow-up merges with the previous request instead of replacing it", async () => {
    const { host, execute, fire } = setup(CONFIG);
    const spec = "Build a turn-based game with Three.js and a score HUD";
    fire("before_agent_start", { messageType: "user", prompt: spec });
    fire("before_agent_start", { messageType: "user", prompt: "continue" });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    // The thin-brief failure the feature guards against: "continue" alone.
    expect(briefs[0]).toContain(spec);
    expect(briefs[0]).toContain("continue");
    expect(briefs[0]).toContain("follow-up");
  });

  it("an empty user run keeps the previous request (image-only run)", async () => {
    const { host, execute, fire } = setup(CONFIG);
    fire("before_agent_start", { messageType: "user", prompt: "The real request" });
    fire("before_agent_start", { messageType: "user", prompt: "   " });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).toContain("The real request");
  });

  it("a non-user run does not touch the captured request", async () => {
    const { host, execute, fire } = setup(CONFIG);
    fire("before_agent_start", { messageType: "user", prompt: "The real request" });
    fire("before_agent_start", { messageType: "custom" });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).toContain("The real request");
  });

  it("a second long user run replaces the first", async () => {
    const { host, execute, fire } = setup(CONFIG);
    fire("before_agent_start", { messageType: "user", prompt: "First job text" });
    // At or above FOLLOW_UP_MAX_CHARS a message is a new request, not a follow-up.
    fire("before_agent_start", {
      messageType: "user",
      prompt: `Second job text. ${"More work.".repeat(40)}`,
    });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).toContain("Second job text");
    expect(briefs[0]).not.toContain("First job text");
  });

  it("an overflowed merge keeps the follow-up and clips the stale head", async () => {
    const { host, execute, fire } = setup(CONFIG);
    fire("before_agent_start", { messageType: "user", prompt: "S".repeat(16_050) });
    fire("before_agent_start", { messageType: "user", prompt: "fix the failing test NOW" });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    // The freshest instruction must survive whole, at the end; the clipped
    // body fits the budget. The body ends at the prelude separator (the
    // internal "--- follow-up ---" marker must not cut the extraction).
    expect(briefs[0]).toContain("fix the failing test NOW");
    const brief = briefs[0] ?? "";
    const blockStart = brief.indexOf("---\n") + 4;
    const blockEnd = brief.indexOf("\n\n---\n\n## ", blockStart);
    const body = (brief.slice(blockStart, blockEnd) ?? "").replace(/\n---$/, "");
    expect(body.length).toBeLessThanOrEqual(16_000);
    expect(body.endsWith("fix the failing test NOW")).toBe(true);
  });

  it("a new session resets the captured request", async () => {
    const { host, execute, fire } = setup(CONFIG);
    fire("before_agent_start", { messageType: "user", prompt: "Old session spec text" });
    fire("session_start", { reason: "new" });
    fire("before_agent_start", { messageType: "user", prompt: "continue" });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).not.toContain("Old session spec text");
    expect(briefs[0]).toContain("continue");
  });

  it("a reload keeps the captured request", async () => {
    const { host, execute, fire } = setup(CONFIG);
    fire("before_agent_start", { messageType: "user", prompt: "Kept across reload" });
    fire("session_start", { reason: "reload" });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).toContain("Kept across reload");
  });

  it("an exactly-280-char message replaces the request; 279 merges", async () => {
    const { host, execute, fire } = setup(CONFIG);
    const a280 = "A".repeat(280);
    const b280 = "B".repeat(280);
    fire("before_agent_start", { messageType: "user", prompt: a280 });
    fire("before_agent_start", { messageType: "user", prompt: b280 });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).toContain(b280);
    expect(briefs[0]).not.toContain(a280);
  });

  it("a 279-char message after a request merges as a follow-up", async () => {
    const { host, execute, fire } = setup(CONFIG);
    const a280 = "A".repeat(280);
    const c279 = "C".repeat(279);
    fire("before_agent_start", { messageType: "user", prompt: a280 });
    fire("before_agent_start", { messageType: "user", prompt: c279 });
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).toContain(a280);
    expect(briefs[0]).toContain(c279);
  });

  it("a run without a captured user prompt leaves the brief exactly the task text", async () => {
    const { host, execute } = setup(CONFIG);
    const briefs: string[] = [];
    const promise = execute({ tasks: makeTasks(1) });
    await drive(host, (request) => {
      briefs.push(request.task);
      return { result: report("done", "ok"), usage: USAGE };
    });
    await promise;
    expect(briefs[0]).not.toContain("ORIGINAL REQUEST");
    expect(briefs[0]).toContain("instructions for t1");
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

describe("E2E scenario (б): the first window error cools the model, mixed outcomes", () => {
  it(`${E2E_B_TASKS} tasks, width 3, 2 models: A cools on its first 403, queue goes to B, zero :cancel`, async () => {
    const { host, execute, cooldownStore } = setup({
      ...CONFIG,
      workerModels: ["model-a", "model-b"],
    });
    const promise = execute({ tasks: makeTasks(E2E_B_TASKS), maxWorkers: 3 });
    let cooledOnA = false;
    await drive(host, (request) => {
      if (request.model === "model-a") {
        // The FIRST window-class error is enough: model-a leaves dispatch.
        cooledOnA = true;
        return WINDOW_403;
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
    expect(cooledOnA).toBe(true);

    // THE explicit assert: a cooldown never cancels anyone; the two A children
    // that were already running settled on their own terms.
    expect(host.cancels).toHaveLength(0);

    // A is off dispatch after its first window error: only its first-wave pair
    // ever launched on it, everything after that ran on B.
    const launchesOnA = host.requests
      .filter((request) => request.model === "model-a")
      .map((request) => request.nodeId);
    expect(launchesOnA).toStrictEqual(["t1#a1", "t3#a1"]);
    for (const id of ["t5#a1", "t7#a1", "t9#a1", "t10#a1"]) {
      expect(host.requests.find((request) => request.nodeId === id)?.model).toBe("model-b");
    }

    expect(result.results.map((row) => row.id)).toStrictEqual(
      Array.from({ length: E2E_B_TASKS }, (_, index) => `t${index + 1}`),
    );
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t1")).toMatchObject({ status: "failed", error: "host:failed" });
    expect(byId.get("t3")).toMatchObject({ status: "failed", error: "host:failed" });
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

    // The cooled model is still in the store when the call finished.
    const cooled = cooldownStore.activeCooldowns(["model-a", "model-b"], Date.now());
    expect(cooled.map((entry) => [entry.model, entry.reason])).toStrictEqual([
      ["model-a", "window"],
    ]);
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

describe("E2E: researcherWeb composition selects the researcher profile (§4.9.3, wiring)", () => {
  it("config.researcherWeb reaches the seam: web → fusion-researcher-web, default → fusion-researcher", async () => {
    const { host, execute } = setup({ ...CONFIG, researcherWeb: "web" });
    const promise = execute({ tasks: [{ id: "r", instructions: "research", role: "researcher" }] });
    await drive(host, () => ({
      result: {
        kind: "structured" as const,
        value: {
          status: "done",
          summary: "r done",
          filesChanged: [],
          evidence: [],
          residualRisks: [],
          sources: [],
          unknowns: [],
        },
      },
    }));
    await promise;
    expect(host.requests[0]?.agent).toBe("fusion-researcher-web");

    // Default composition (none): the plain offline profile.
    const { host: host2, execute: execute2 } = setup(CONFIG);
    const promise2 = execute2({
      tasks: [{ id: "r2", instructions: "research", role: "researcher" }],
    });
    await drive(host2, () => ({
      result: {
        kind: "structured" as const,
        value: {
          status: "done",
          summary: "r2 done",
          filesChanged: [],
          evidence: [],
          residualRisks: [],
          sources: [],
          unknowns: [],
        },
      },
    }));
    await promise2;
    expect(host2.requests[0]?.agent).toBe("fusion-researcher");
  });
});

describe("E2E: a child still running on a cooling model is accepted when it completes", () => {
  it("the first 403 lands on A while t3 runs on A; t3 finishes after the cooldown and is kept", async () => {
    const { host, execute, cooldownStore } = setup({
      ...CONFIG,
      workerModels: ["model-a", "model-b"],
    });
    const promise = execute({ tasks: makeTasks(4), maxWorkers: 3 });
    let cooledOnA = false;
    await drive(host, (request) => {
      if (request.nodeId === "t3#a1") {
        // Still running when model-a cools: it finishes naturally, never :cancel.
        return cooledOnA ? { result: report("done", "t3 kept") } : null;
      }
      if (request.model === "model-a") {
        cooledOnA = true;
        return WINDOW_403;
      }
      return { result: report("done", `${request.nodeId} done`) };
    });
    const result = asFanout((await promise).structuredContent);

    expect(host.cancels).toHaveLength(0);
    // The queue went to the cool-free model while A was cooling.
    expect(host.requests.find((request) => request.nodeId === "t4#a1")?.model).toBe("model-b");
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("t1")).toMatchObject({ status: "failed", error: "host:failed" });
    expect(byId.get("t3")).toMatchObject({ status: "done", summary: "t3 kept" });
    expect(byId.get("t2")?.status).toBe("done");
    expect(byId.get("t4")?.status).toBe("done");
    expect(
      cooldownStore.activeCooldowns(["model-a", "model-b"], Date.now()).map((entry) => entry.model),
    ).toStrictEqual(["model-a"]);
  });
});

describe("E2E: cooldowns survive across fusion_delegate calls (fusion-model-cooldown D1, D8)", () => {
  it("the second call sees the first call's cooldown: the cooled model is skipped and the chain says so", async () => {
    const store = createCooldownStore();
    const { host, execute, cooldownStore } = setup(
      { ...CONFIG, workerModels: ["model-a", "model-b"], workers: 3, maxParallel: 3 },
      true,
      store,
    );
    expect(cooldownStore).toBe(store);

    // Call 1: one task per model; model-a hits the quota wall in its text-free
    // 403 form (the new marker), model-b completes.
    const firstPromise = execute({ tasks: makeTasksNamed("p1", 2), maxWorkers: 2 });
    await drive(host, (request) =>
      request.nodeId === "p1t1#a1" ? WINDOW_403 : { result: report("done", "p1t1 done") },
    );
    const firstResult = asFanout((await firstPromise).structuredContent);
    expect(firstResult.results.map((row) => row.status)).toStrictEqual(["failed", "done"]);
    expect(
      store
        .activeCooldowns(["model-a", "model-b"], Date.now())
        .map((entry) => [entry.model, entry.reason]),
    ).toStrictEqual([["model-a", "window"]]);

    // Call 2 shares the store: model-a is cooling, so the width chain carries
    // the cooldown row and every launch goes to model-b.
    const beforeSecond = host.requests.length;
    const secondPromise = execute({ tasks: makeTasksNamed("p2", 3), maxWorkers: 3 });
    await drive(host, (request) => ({ result: report("done", `${request.nodeId} done`) }));
    const secondOutcome = await secondPromise;
    const second = asFanout(secondOutcome.structuredContent);
    expect(host.requests.slice(beforeSecond).map((request) => request.model)).toStrictEqual([
      "model-b",
      "model-b",
      "model-b",
    ]);
    expect(second.clamps).toStrictEqual([
      { field: "cooldown", requested: 3, applied: 2, reason: expect.any(String) },
    ]);
    expect(second.results.map((row) => row.status)).toStrictEqual(["done", "done", "done"]);
    const secondLines =
      secondOutcome.content[0]?.type === "text" ? secondOutcome.content[0].text.split("\n") : [];
    expect(secondLines.some((line) => line.startsWith("clamp cooldown: 3 → 2"))).toBe(true);
  });

  it("a fully cooled rotation fails the next call up front: zero :request, honest rows", async () => {
    const store = createCooldownStore();
    const { host, execute } = setup(
      { ...CONFIG, workerModels: ["model-a", "model-b"], workers: 3, maxParallel: 3 },
      true,
      store,
    );
    // Call 1 cools BOTH models: A by a 403, B by a timeout.
    const firstPromise = execute({ tasks: makeTasksNamed("q1", 2), maxWorkers: 2 });
    await drive(host, (request) =>
      request.nodeId === "q1t1#a1" ? WINDOW_403 : { status: "timed_out" },
    );
    await firstPromise;
    expect(
      store
        .activeCooldowns(["model-a", "model-b"], Date.now())
        .map((entry) => [entry.model, entry.reason]),
    ).toStrictEqual([
      ["model-a", "window"],
      ["model-b", "timeout"],
    ]);

    const before = host.requests.length;
    const outcome = await execute({ tasks: makeTasksNamed("q2", 3), maxWorkers: 2 });
    expect(host.requests).toHaveLength(before);
    expect(host.cancels).toHaveLength(0);
    const result = asFanout(outcome.structuredContent);
    expect(result.clamps).toStrictEqual([
      { field: "cooldown", requested: 2, applied: 0, reason: expect.any(String) },
    ]);
    for (const row of result.results) {
      expect(row).toMatchObject({
        status: "failed",
        error: "no-available-model",
        attempts: 0,
      });
      expect(row.summary).toContain("model-a window");
      expect(row.summary).toContain("model-b timeout");
    }
    expect(outcome.structuredContent).toBeDefined();
    expect(outcome.isError ?? false).toBe(false);
  });

  it("without an injected store the tool cools the process singleton index.ts created", async () => {
    // `null` = no store injected: the production wiring path.
    const { host, execute, cooldownStore } = setup(CONFIG, true, null);
    expect(cooldownStore).toBe(productionCooldownStore);
    const promise = execute({ tasks: makeTasksNamed("s1", 1) });
    await drive(host, () => WINDOW_403);
    const result = asFanout((await promise).structuredContent);
    expect(result.results.map((row) => row.status)).toStrictEqual(["failed"]);
    expect(productionCooldownStore.isCooling("model-a", Date.now())).toBe(true);
    const entries = productionCooldownStore.activeCooldowns(CONFIG.workerModels, Date.now());
    expect(entries.map((entry) => [entry.model, entry.reason])).toStrictEqual([
      ["model-a", "window"],
    ]);
  });
});

describe("E2E: role reports through the full path (§4.8, §4.11)", () => {
  it("reviewer report → schemaFailed → role retry (reviewer schema, same agent) → role fields in TaskResult and renderFanoutText", async () => {
    const { host, execute } = setup(CONFIG);
    const promise = execute({
      tasks: [
        { id: "rev", instructions: "review the diff", role: "reviewer" },
        { id: "w", instructions: "plain work" },
      ],
    });
    await drive(host, (request) => {
      if (request.nodeId === "rev#a1") {
        // A valid WORKER report is an INVALID reviewer report: no findings,
        // no checksRun, no verdict → schemaFailed with the rejected value.
        return { result: report("done", "reviewed") };
      }
      if (request.nodeId === "rev#a2") {
        return {
          result: {
            kind: "structured" as const,
            value: {
              status: "done",
              summary: "reviewed with findings",
              filesChanged: [],
              evidence: ["re-rendered"],
              residualRisks: [],
              findings: ["pin drift"],
              checksRun: ["npm test"],
              verdict: "fail",
            },
          },
        };
      }
      return { result: report("done", "w done") };
    });
    const outcome = await promise;
    const result = asFanout(outcome.structuredContent);

    const a1 = host.requests.find((request) => request.nodeId === "rev#a1");
    const a2 = host.requests.find((request) => request.nodeId === "rev#a2");
    expect(a1?.agent).toBe("fusion-reviewer");
    expect(a2?.agent).toBe("fusion-reviewer"); // the SAME role profile
    expect(JSON.stringify(a2?.result)).toContain("verdict"); // role schema on the retry
    expect(a2?.task).toContain("БРИФ ЗАДАЧИ"); // report-only re-rendering context
    expect(a2?.task).toContain("Реализацию не повторять");

    expect(result.results[0]).toMatchObject({
      id: "rev",
      status: "done",
      attempts: 2,
      findings: ["pin drift"],
      checksRun: ["npm test"],
      verdict: "fail",
    });
    expect(result.results[1]).toMatchObject({ id: "w", status: "done", attempts: 1 });
    expect(result.results[1]?.findings).toBeUndefined(); // worker row stays clean

    // The lead-facing text carries the role fields (counts + verdict).
    const text = outcome.content[0]?.type === "text" ? outcome.content[0].text : "";
    expect(text).toContain("verdict: fail");
    expect(text).toContain("findings: 1");
    expect(text).toContain("checksRun: 1");
  });

  it("researcher and scout rows carry their counts; mixed roles share one queue unchanged", async () => {
    const { host, execute } = setup(CONFIG);
    const promise = execute({
      tasks: [
        { id: "s", instructions: "scout", role: "scout" },
        { id: "r", instructions: "research", role: "researcher" },
      ],
    });
    await drive(host, (request) => ({
      result: {
        kind: "structured" as const,
        value: {
          status: "done",
          summary: request.nodeId,
          filesChanged: [],
          evidence: [],
          residualRisks: [],
          sources: ["src/a.ts:12"],
          ...(request.agent === "fusion-researcher" ? { unknowns: ["live web"] } : {}),
        },
      },
    }));
    const outcome = await promise;
    const result = asFanout(outcome.structuredContent);
    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("s")).toMatchObject({ status: "done", sources: ["src/a.ts:12"] });
    expect(byId.get("r")).toMatchObject({
      status: "done",
      sources: ["src/a.ts:12"],
      unknowns: ["live web"],
    });
    const text = outcome.content[0]?.type === "text" ? outcome.content[0].text : "";
    expect(text).toContain("sources: 1");
    expect(text).toContain("unknowns: 1");
  });
});
