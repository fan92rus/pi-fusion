import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BARREN_DELEGATION_LIMIT,
  LEAD_BLOCKED_TOOLS,
  registerLeadRestrictions,
} from "../extensions/pi-fusion/restrictions.ts";
import type { FanoutResult, TaskResult } from "../extensions/pi-fusion/types.ts";

type Handler = (event: Record<string, unknown>) => unknown;

/** A pi stand-in that records `pi.on` handlers and fires them like the host does. */
function makeHost() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    fire(name: string, event: Record<string, unknown>): unknown {
      let last: unknown;
      for (const handler of handlers.get(name) ?? []) last = handler(event);
      return last;
    },
    registered: () => [...handlers.keys()].sort(),
  };
}

function toolCall(toolName: string) {
  return { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input: {} };
}

function task(id: string, overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id,
    status: "done",
    summary: "ok",
    filesChanged: [],
    evidence: [],
    residualRisks: [],
    attempts: 1,
    turns: 3,
    ...overrides,
  };
}

function fanout(results: TaskResult[]): FanoutResult {
  return { results, clamps: [], usage: {}, usagePartial: false };
}

/** A completed fusion_delegate call carrying its FanoutResult as structuredContent. */
function delegated(host: ReturnType<typeof makeHost>, result: FanoutResult) {
  host.fire("tool_result", {
    type: "tool_result",
    toolCallId: "fan",
    toolName: "fusion_delegate",
    input: {},
    content: [{ type: "text", text: "rendered" }],
    structuredContent: result,
    isError: false,
  });
}

function refusedReason(host: ReturnType<typeof makeHost>, toolName: string): string {
  const verdict = host.fire("tool_call", toolCall(toolName)) as
    | { block?: boolean; reason?: string }
    | undefined;
  expect(verdict?.block).toBe(true);
  return verdict?.reason ?? "";
}

/** The barren-leg refusal: the worker leg is not running, tell the operator. */
const BARREN_TEXT = "воркер-нога не работает — скажи оператору";

const enabled = { isEnabled: () => true, isLeadSession: () => true };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lead restrictions: blocking", () => {
  it("blocks write, edit and bash as a whole while fusion is enabled", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    for (const tool of ["write", "edit", "bash"]) {
      expect(refusedReason(host, tool)).not.toBe("");
    }
  });

  it("the default blocklist is exactly write, edit, bash", () => {
    expect([...LEAD_BLOCKED_TOOLS]).toEqual(["write", "edit", "bash"]);
  });

  it("passes everything when fusion is off", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, { ...enabled, isEnabled: () => false });
    expect(host.fire("tool_call", toolCall("write"))).toBeUndefined();
    expect(host.fire("tool_call", toolCall("bash"))).toBeUndefined();
  });

  it("never touches read-only tools or other extension tools", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    for (const tool of [
      "read",
      "grep",
      "find",
      "ls",
      "fusion_delegate",
      "subagent",
      "codemode",
      "mcp__docs__search",
    ]) {
      expect(host.fire("tool_call", toolCall(tool))).toBeUndefined();
    }
  });

  it("the block does not depend on fan-out history: a successful fan-out unlocks nothing", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a", { turns: 5 })]));
    expect(refusedReason(host, "write")).not.toBe("");
    expect(refusedReason(host, "edit")).not.toBe("");
  });

  it("is inert in a pi-subagents child process (PI_SUBAGENT_CHILD=1)", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const host = makeHost();
    registerLeadRestrictions(host.api, { isEnabled: () => true });
    expect(host.fire("tool_call", toolCall("write"))).toBeUndefined();
  });

  it("blocks in the main process when PI_SUBAGENT_CHILD is not '1'", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "");
    const host = makeHost();
    registerLeadRestrictions(host.api, { isEnabled: () => true });
    expect(refusedReason(host, "write")).not.toBe("");
  });

  it("uses a custom blocklist when one is given", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, { ...enabled, blockedTools: ["write"] });
    expect(refusedReason(host, "write")).not.toBe("");
    expect(host.fire("tool_call", toolCall("edit"))).toBeUndefined();
  });
});

describe("lead restrictions: refusal text by fan-out state", () => {
  it("before the first fan-out: plan and delegate", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    expect(refusedReason(host, "write")).toContain(
      "планируй и делегируй — отправь fusion_delegate",
    );
  });

  it("after a fan-out with results: send the rework out, needs_orchestrator is a new fan-out", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a", { status: "needs_orchestrator" })]));
    const reason = refusedReason(host, "edit");
    expect(reason).toContain(
      "отправь переделку: needs_orchestrator = новый fan-out, пути в files, не захватывай работу сам",
    );
    expect(reason).not.toContain("планируй и делегируй");
  });

  it("a refused fusion_delegate (no FanoutResult) does not count as a fan-out", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    host.fire("tool_result", {
      type: "tool_result",
      toolCallId: "bad",
      toolName: "fusion_delegate",
      input: {},
      content: [{ type: "text", text: "fusion_delegate refused" }],
      isError: true,
    });
    expect(refusedReason(host, "write")).toContain("планируй и делегируй");
  });

  it("ignores tool_result of other tools even if they carry a FanoutResult shape", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    host.fire("tool_result", {
      type: "tool_result",
      toolCallId: "other",
      toolName: "subagent",
      input: {},
      content: [],
      structuredContent: fanout([task("a")]),
      isError: false,
    });
    expect(refusedReason(host, "write")).toContain("планируй и делегируй");
  });
});

describe("lead restrictions: barren counter", () => {
  const zeroSteps = () => fanout([task("a", { turns: 0 }), task("b", { turns: 0 })]);

  it("the limit is two consecutive barren fan-outs", () => {
    expect(BARREN_DELEGATION_LIMIT).toBe(2);
  });

  it("one barren fan-out keeps the rework text", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, zeroSteps());
    const reason = refusedReason(host, "write");
    expect(reason).not.toContain(BARREN_TEXT);
    expect(reason).toContain("отправь переделку");
  });

  it("two consecutive barren fan-outs switch the text to the operator message", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, zeroSteps());
    delegated(host, zeroSteps());
    const reason = refusedReason(host, "write");
    expect(reason).toContain(BARREN_TEXT);
    expect(reason).not.toContain("отправь переделку");
  });

  it("a fan-out that ran any step resets the barren streak", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, zeroSteps());
    delegated(host, fanout([task("a", { turns: 0 }), task("b", { turns: 1 })]));
    delegated(host, zeroSteps());
    expect(refusedReason(host, "write")).not.toContain(BARREN_TEXT);
  });

  it("steps fall back to turnsObserved when turns is absent", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    const observedZero = () => fanout([task("a", { turns: undefined, turnsObserved: 0 })]);
    delegated(host, observedZero());
    delegated(host, observedZero());
    expect(refusedReason(host, "write")).toContain(BARREN_TEXT);
  });

  it("unknown steps (no turns, no turnsObserved) are not zero: not barren", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    const unknown = () => fanout([task("a", { turns: undefined, turnsObserved: undefined })]);
    delegated(host, unknown());
    delegated(host, unknown());
    expect(refusedReason(host, "write")).not.toContain(BARREN_TEXT);
  });
});

describe("lead restrictions: run phase", () => {
  it("agent_start resets the fan-out phase back to plan-and-delegate", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a")]));
    expect(refusedReason(host, "write")).toContain("отправь переделку");
    host.fire("agent_start", { type: "agent_start" });
    expect(refusedReason(host, "write")).toContain("планируй и делегируй");
  });

  it("agent_start resets the barren streak", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    const zero = () => fanout([task("a", { turns: 0 })]);
    delegated(host, zero());
    delegated(host, zero());
    host.fire("agent_start", { type: "agent_start" });
    delegated(host, zero());
    expect(refusedReason(host, "write")).not.toContain(BARREN_TEXT);
  });

  it("turn_start does not reset: the phase survives the model requests of one run", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a")]));
    // pi fires turn_start per model request (docs extensions.md:84); the
    // post-fan-out phase must reach the very next request.
    host.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
    expect(refusedReason(host, "write")).toContain("отправь переделку");
  });

  it("subscribes to tool_call, tool_result and agent_start", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    expect(host.registered()).toEqual(["agent_start", "tool_call", "tool_result"]);
  });
});
