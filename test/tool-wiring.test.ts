import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUSION_CONFIG_DEFAULTS,
  type FusionConfig,
} from "../extensions/pi-fusion/config-bridge.ts";
import fusionExtension, {
  FUSION_TOOL_NAME,
  registerFusionDelegate,
} from "../extensions/pi-fusion/index.ts";
import { runFanout } from "../extensions/pi-fusion/pool/fanout.ts";
import { resetForTests } from "../extensions/pi-fusion/session-state.ts";
import { createFakePiEvents } from "./fake-pi.ts";

// The seam is not under test here: the fanout stub only records the config it
// was handed and refuses as a missing seam, so no worker ever starts.
vi.mock("../extensions/pi-fusion/pool/fanout.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/pi-fusion/pool/fanout.ts")>();
  return { ...actual, runFanout: vi.fn(async () => ({ seamUnavailable: true as const })) };
});

/** One entry of the stand-in session branch (pi-coding-agent session history). */
interface BranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface RegisteredTool {
  name: string;
  exposure?: string;
  outputSchema?: unknown;
  parameters: unknown;
}

type ExecutableTool = {
  execute(
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<unknown>;
};

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
  const handlers = new Map<string, Array<(payload?: unknown, ctx?: unknown) => unknown>>();
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
    on(event: string, handler: (payload?: unknown, ctx?: unknown) => unknown) {
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
    /** Fires the handlers like the host; returns the last handler's result (the gate's verdict). */
    fire(event: string, payload: unknown = {}, c?: unknown): unknown {
      const useCtx = c ?? ctx;
      let last: unknown;
      for (const handler of handlers.get(event) ?? []) last = handler(payload, useCtx);
      return last;
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

/** A session switched on through its own branch record, as `/fusion on` writes it. */
function enabledBranch(): BranchEntry[] {
  const branch: BranchEntry[] = [];
  makeSessionManager(branch).appendEntry("pi-fusion.activation", {
    owner: "s1",
    enabled: true,
    ts: 1,
  });
  return branch;
}

describe("project layer wiring (design D6-D7, fusion-project-config task 2.2)", () => {
  let tmp: string;
  let globalFile: string;
  let projectRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fusion-wiring-"));
    globalFile = join(tmp, "global", "fusion.json");
    projectRoot = join(tmp, "project");
    mkdirSync(join(projectRoot, ".pi"), { recursive: true });
    vi.mocked(runFanout).mockClear();
    // The activation cache is keyed by session id, which every test here shares.
    resetForTests();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeGlobal = (value: unknown): void => {
    mkdirSync(join(tmp, "global"), { recursive: true });
    writeFileSync(globalFile, JSON.stringify(value), "utf8");
  };
  const writeProject = (value: unknown): void => {
    writeFileSync(join(projectRoot, ".pi", "fusion.json"), JSON.stringify(value), "utf8");
  };

  it("a local workerModels wins in the fanout: runFanout receives the local rotation", async () => {
    writeGlobal({ workerModels: ["global/m"] });
    writeProject({ workerModels: ["local/m"] });
    const host = makePi(["read", "bash"], enabledBranch());
    fusionExtension(host.api, { configPath: globalFile, projectConfigDir: projectRoot });
    const tool = host.tools.find((t) => t.name === FUSION_TOOL_NAME) as unknown as
      | ExecutableTool
      | undefined;
    await tool?.execute(
      "call-1",
      { tasks: [{ id: "t1", instructions: "do the thing" }] },
      undefined,
      undefined,
      { cwd: projectRoot, sessionManager: host.sessionManager },
    );
    expect(vi.mocked(runFanout)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runFanout).mock.calls[0]?.[0].config.workerModels).toEqual(["local/m"]);
  });

  it("without a project file the fanout reads the global rotation, as before", async () => {
    writeGlobal({ workerModels: ["global/m"] });
    const host = makePi(["read", "bash"], enabledBranch());
    fusionExtension(host.api, { configPath: globalFile, projectConfigDir: projectRoot });
    const tool = host.tools.find((t) => t.name === FUSION_TOOL_NAME) as unknown as
      | ExecutableTool
      | undefined;
    await tool?.execute(
      "call-2",
      { tasks: [{ id: "t1", instructions: "do the thing" }] },
      undefined,
      undefined,
      { cwd: projectRoot, sessionManager: host.sessionManager },
    );
    expect(vi.mocked(runFanout).mock.calls[0]?.[0].config.workerModels).toEqual(["global/m"]);
  });

  it("reads the project layer from the cwd at call time, not at load (design D6)", async () => {
    writeGlobal({ workerModels: ["global/m"] });
    // Loaded with no projectConfigDir: the layer must follow process.cwd() when
    // the tool runs, so a chdir after load has to take effect (review major 1).
    const host = makePi(["read", "bash"], enabledBranch());
    fusionExtension(host.api, { configPath: globalFile });
    const previousCwd = process.cwd();
    try {
      writeProject({ workerModels: ["local/m"] });
      process.chdir(projectRoot);
      const tool = host.tools.find((t) => t.name === FUSION_TOOL_NAME) as unknown as
        | ExecutableTool
        | undefined;
      await tool?.execute(
        "call-cwd",
        { tasks: [{ id: "t1", instructions: "do the thing" }] },
        undefined,
        undefined,
        { cwd: projectRoot, sessionManager: host.sessionManager },
      );
    } finally {
      process.chdir(previousCwd);
    }
    expect(vi.mocked(runFanout).mock.calls[0]?.[0].config.workerModels).toEqual(["local/m"]);
  });

  it("the guidance names the local workerModels, read again on every run (no restart)", () => {
    writeGlobal({ workerModels: ["global/m"] });
    const host = makePi(["read", "bash"], enabledBranch());
    fusionExtension(host.api, { configPath: globalFile, projectConfigDir: projectRoot });
    const first = { systemPromptOptions: { appendSystemPrompt: "" } };
    host.fire("before_agent_start", first);
    expect(first.systemPromptOptions.appendSystemPrompt).toContain("`global/m`");

    writeProject({ workerModels: ["local/m"] });
    const second = { systemPromptOptions: { appendSystemPrompt: "" } };
    host.fire("before_agent_start", second);
    expect(second.systemPromptOptions.appendSystemPrompt).toContain("`local/m`");
    expect(second.systemPromptOptions.appendSystemPrompt).not.toContain("`global/m`");
  });

  it("a local leadBlockedTools applies to the lead gate without a restart", () => {
    const host = makePi(["read", "bash"], enabledBranch());
    fusionExtension(host.api, { configPath: globalFile, projectConfigDir: projectRoot });
    const call = (toolName: string) => ({
      type: "tool_call",
      toolCallId: `call-${toolName}`,
      toolName,
      input: { path: "src/app.ts" },
    });
    expect(host.fire("tool_call", call("write"))).toMatchObject({ block: true });

    writeProject({ leadBlockedTools: ["edit"] });
    expect(host.fire("tool_call", call("write"))).toBeUndefined();
    expect(host.fire("tool_call", call("edit"))).toMatchObject({ block: true });
  });
});
