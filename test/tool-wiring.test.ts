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
function makePi(initialActive: string[] = ["read", "bash"]) {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Array<() => void>>();
  let active = [...initialActive];
  const pi = {
    events: createFakePiEvents(),
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
      // Host rule (docs extensions.md:277): registering a direct tool activates it.
      if (tool.exposure === "direct" && !active.includes(tool.name)) active.push(tool.name);
    },
    registerCommand() {}, // fusionExtension now also registers /fusion
    on(event: string, handler: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };
  return {
    api: pi as unknown as ExtensionAPI,
    tools,
    active: () => active,
    fire(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

const enabledConfig: FusionConfig = { ...FUSION_CONFIG_DEFAULTS, enabled: true };
const disabledConfig: FusionConfig = { ...FUSION_CONFIG_DEFAULTS, enabled: false };

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

describe("feature flag: active set", () => {
  it("with enabled=false the tool is removed from the active set at session start", () => {
    const host = makePi();
    registerFusionDelegate(host.api, disabledConfig);
    expect(host.active()).toContain(FUSION_TOOL_NAME);
    host.fire("session_start");
    expect(host.active()).not.toContain(FUSION_TOOL_NAME);
    expect(host.active()).toEqual(["read", "bash"]);
  });

  it("with enabled=true the tool stays in the active set", () => {
    const host = makePi();
    registerFusionDelegate(host.api, enabledConfig);
    host.fire("session_start");
    expect(host.active()).toContain(FUSION_TOOL_NAME);
  });
});
