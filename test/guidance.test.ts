import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  applyFusionSection,
  buildFusionSection,
  FUSION_SECTION_HEADING,
  type FusionGuidanceFacts,
  registerFusionGuidance,
} from "../extensions/pi-fusion/guidance.ts";
import fusionExtension from "../extensions/pi-fusion/index.ts";

const twoModels: FusionGuidanceFacts = {
  enabled: true,
  workers: 3,
  maxParallel: 3,
  taskTimeoutMs: 600_000,
  workerModels: ["glm-a", "glm-b"],
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** The options object before_agent_start hands out, with the user's own append text. */
const options = (appendSystemPrompt = "") =>
  ({ appendSystemPrompt }) as { appendSystemPrompt: string };

describe("fusion guidance section", () => {
  it("appends the ### fusion section after the existing append text when enabled", () => {
    const opts = options("Project note.");
    applyFusionSection(opts, twoModels);
    expect(opts.appendSystemPrompt.startsWith("Project note.\n\n### fusion\n")).toBe(true);
    expect(count(opts.appendSystemPrompt, FUSION_SECTION_HEADING)).toBe(1);
  });

  it("adds nothing and keeps the user text byte-identical when off", () => {
    const opts = options("Project note.");
    applyFusionSection(opts, { ...twoModels, enabled: false });
    expect(opts.appendSystemPrompt).toBe("Project note.");
    expect(opts.appendSystemPrompt.includes(FUSION_SECTION_HEADING)).toBe(false);
  });

  it("strips a section appended earlier when fusion goes off, leaving the user text intact", () => {
    const opts = options("Project note.\n\nMore notes.");
    applyFusionSection(opts, twoModels);
    applyFusionSection(opts, { ...twoModels, enabled: false });
    expect(opts.appendSystemPrompt).toBe("Project note.\n\nMore notes.");
  });

  it("is idempotent: a second before_agent_start leaves exactly one copy, byte-identical", () => {
    const once = options("Project note.");
    applyFusionSection(once, twoModels);
    const twice = options("Project note.");
    applyFusionSection(twice, twoModels);
    applyFusionSection(twice, twoModels);
    expect(twice.appendSystemPrompt).toBe(once.appendSystemPrompt);
    expect(count(twice.appendSystemPrompt, FUSION_SECTION_HEADING)).toBe(1);
  });

  it("keeps text placed after the section when it is stripped", () => {
    const opts = options(`${buildFusionSection(twoModels)}\n\nLater note.`);
    applyFusionSection(opts, { ...twoModels, enabled: false });
    expect(opts.appendSystemPrompt).toBe("Later note.");
  });

  it("never replaces the whole prompt: no forceSystemPrompt, customPrompt or systemPrompt", () => {
    const opts = options() as Record<string, unknown>;
    applyFusionSection(opts as { appendSystemPrompt: string }, twoModels);
    expect(Object.keys(opts).sort()).toEqual(["appendSystemPrompt"]);
  });

  it("states the lead's role and the delegation rules", () => {
    const section = buildFusionSection(twoModels);
    expect(section).toContain("fusion_delegate");
    expect(section).toContain("evidence");
    expect(section).toContain("needs_orchestrator");
    expect(section).toContain("files");
    expect(section).toContain("no bash");
    expect(section).toContain("stand alone");
    expect(section).not.toContain("\n\n");
  });

  it("states the machine facts: rotation, width ceiling and timeout", () => {
    const section = buildFusionSection(twoModels);
    expect(section).toContain("`glm-a`, `glm-b`");
    expect(section).toContain("round-robin");
    expect(section).toContain("`maxWorkers` defaults to 3");
    // min(maxParallel 3, 2 per model × 2 models) = 3
    expect(section).toContain("At most 3 workers run at once");
    expect(section).toContain("600000 ms");
    // 4 × taskTimeoutMs is the per-task ceiling
    expect(section).toContain("2400000 ms");
  });

  it("clamps the width ceiling by the per-model cap when there is one model", () => {
    const section = buildFusionSection({ ...twoModels, workerModels: ["glm-a"] });
    // min(maxParallel 3, 2 per model × 1 model) = 2
    expect(section).toContain("At most 2 workers run at once");
    expect(section).not.toContain("At most 3 workers run at once");
  });

  it("says plainly when no worker model is configured instead of stating a width", () => {
    const section = buildFusionSection({ ...twoModels, workerModels: [] });
    expect(section).toContain("No worker models are configured");
    expect(section).not.toContain("round-robin");
    expect(section).not.toContain("At most");
  });
});

describe("registerFusionGuidance", () => {
  /** A pi stand-in that records before_agent_start handlers, like the host dispatches them. */
  function makePi() {
    const handlers: Array<
      (event: { systemPromptOptions: { appendSystemPrompt: string } }) => unknown
    > = [];
    const pi = {
      on(event: string, handler: (typeof handlers)[number]) {
        if (event === "before_agent_start") handlers.push(handler);
        return () => {};
      },
    } as unknown as ExtensionAPI;
    return {
      pi,
      fire(appendSystemPrompt: string) {
        const event = { systemPromptOptions: { appendSystemPrompt } };
        const results = handlers.map((handler) => handler(event));
        return { appendSystemPrompt: event.systemPromptOptions.appendSystemPrompt, results };
      },
    };
  }

  it("applies the facts read at each before_agent_start and returns nothing", () => {
    const host = makePi();
    let current: FusionGuidanceFacts = twoModels;
    registerFusionGuidance(host.pi, () => current);

    const on = host.fire("Note.");
    expect(on.results).toEqual([undefined]);
    expect(count(on.appendSystemPrompt, FUSION_SECTION_HEADING)).toBe(1);

    const again = host.fire(on.appendSystemPrompt);
    expect(again.appendSystemPrompt).toBe(on.appendSystemPrompt);

    current = { ...twoModels, enabled: false };
    expect(host.fire(again.appendSystemPrompt).appendSystemPrompt).toBe("Note.");
  });

  it("is wired by the extension entry point", () => {
    const registered: string[] = [];
    const pi = {
      on(event: string) {
        registered.push(event);
        return () => {};
      },
      registerTool() {},
      registerCommand() {}, // fusionExtension now also registers /fusion
      getActiveTools: () => [],
      setActiveTools() {},
      events: { on() {}, emit() {} },
    } as unknown as ExtensionAPI;
    fusionExtension(pi);
    expect(registered).toContain("before_agent_start");
  });
});
