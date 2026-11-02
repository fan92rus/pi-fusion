import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  FUSION_CONFIG_DEFAULTS,
  type FusionConfig,
} from "../extensions/pi-fusion/config-bridge.ts";
import fusionExtension, {
  FUSION_TOOL_NAME,
  registerFusionDelegate,
} from "../extensions/pi-fusion/index.ts";
import { createFakePiEvents } from "./fake-pi.ts";

interface RegisteredTool {
  name: string;
  exposure?: string;
  outputSchema?: unknown;
  parameters: unknown;
}

/** A pi stand-in: records registrations and keeps the active tool set like the host does. */
function makeSessionManager(branch: any[] = []) {
  return {
    getSessionId: () => "s1",
    getBranch: () => branch,
    appendEntry: (type: string, data: unknown) => {
      branch.push({ type: "custom", customType: type, data });
    },
  };
}

function makePi(initialActive: string[] = ["read", "bash"], branch: any[] = []) {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Array<(payload?: unknown, ctx?: unknown) => void>>();
  let active = [...initialActive];
  const sm = makeSessionManager(branch);
  const statusCalls: Array<[string, any]> = [];
  const setStatus = (key: string, text: any) => {
    statusCalls.push([key, text]);
  };
  const pi: any = {
    events: createFakePiEvents(),
    appendEntry: (type: string, data: unknown) => sm.appendEntry(type, data),
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
      // Host rule (docs extensions.md:277): registering a direct tool activates it.
      if (tool.exposure === "direct" && !active.includes(tool.name)) active.push(tool.name);
    },
    registerCommand() {}, // fusionExtension now also registers /fusion
    on(event: string, handler: (payload?: unknown, ctx?: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };
  const ctx = { sessionManager: sm, ui: { setStatus } };
  return {
    api: pi as unknown as ExtensionAPI,
    tools,
    active: () => active,
    sessionManager: sm,
    statusCalls,
    statuses: statusCalls,
    statusWrites: statusCalls,
    ui: { setStatus },
    fire(event: string, payload: unknown = {}, c?: unknown) {
      const useCtx = c ?? ctx;
      for (const handler of handlers.get(event) ?? []) handler(payload, useCtx);
    },
    has: (event: string) => handlers.has(event),
  };
}

const enabledConfig: FusionConfig = { ...FUSION_CONFIG_DEFAULTS };
const disabledConfig: FusionConfig = { ...FUSION_CONFIG_DEFAULTS };

describe("fusion_delegate registration", () => {
  it("registers the tool as direct with a FanoutResult outputSchema and an object parameter schema", () => {
    const host = makePi();
    registerFusionDelegate(host.api, enabledConfig);
    const tool = host.tools.find((t) => t.name === FUSION_TOOL_NAME);
    expect(tool?.exposure).toBe("direct");
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?.parameters).toMatchObject({ type: "object" });
  });

  it("the default export registers the same tool", () => {
    const host = makePi();
    fusionExtension(host.api);
    expect(host.tools.map((t) => t.name)).toContain(FUSION_TOOL_NAME);
  });
});

describe("worker-brief request capture", () => {
  it("registerFusionDelegate hooks before_agent_start to capture the operator's prompt", () => {
    const { api, has } = makePi();
    registerFusionDelegate(api, enabledConfig);
    expect(has("before_agent_start")).toBe(true);
  });
});

describe("feature flag: active set", () => {
  it("off session removes the tool at session start", () => {
    const host = makePi();
    registerFusionDelegate(host.api, disabledConfig);
    expect(host.active()).toContain(FUSION_TOOL_NAME);
    host.fire("session_start");
    expect(host.active()).not.toContain(FUSION_TOOL_NAME);
    expect(host.active()).toEqual(["read", "bash"]);
  });

  it("on session keeps the tool at session start", () => {
    const branch: any[] = [];
    const sm = makeSessionManager(branch);
    sm.appendEntry("pi-fusion.activation", { owner: "s1", enabled: true, ts: 1 });
    const host = makePi(["read", "bash"], branch);
    registerFusionDelegate(host.api, enabledConfig);
    host.fire("session_start");
    expect(host.active()).toContain(FUSION_TOOL_NAME);
  });
});

describe("fusion footer status (session_start)", () => {
  it("resume with on-record -> setStatus('fusion','fusion: on')", () => {
    const branch: any[] = [];
    const sm = makeSessionManager(branch);
    sm.appendEntry("pi-fusion.activation", { owner: "s1", enabled: true, ts: 1 });
    const host = makePi(["read", "bash"], branch);
    registerFusionDelegate(host.api, enabledConfig);
    host.fire("session_start");
    expect(host.statusCalls).toContainEqual(["fusion", "fusion: on"]);
  });

  it("no records -> setStatus('fusion','fusion: off')", () => {
    const host = makePi();
    registerFusionDelegate(host.api, enabledConfig);
    host.fire("session_start");
    expect(host.statusCalls).toContainEqual(["fusion", "fusion: off"]);
  });

  it("ctx without setStatus is skipped silently", () => {
    const host = makePi();
    registerFusionDelegate(host.api, enabledConfig);
    const sm = host.sessionManager;
    expect(() => host.fire("session_start", {}, { sessionManager: sm })).not.toThrow();
  });
});
