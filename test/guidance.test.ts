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
    expect(section).toContain("stand alone");
    expect(section).not.toContain("\n\n");
  });

  it("requires the task text fields and provides[].shape in English, with a literal-strings exception (brief-language)", () => {
    const line = buildFusionSection(twoModels)
      .split("\n")
      .find((text) => text.startsWith("- Write every task's"));
    expect(line).toBeDefined();
    expect(line).toContain("`instructions`, `title`, `deliverable`");
    expect(line).toContain("`contract.provides[].shape`");
    expect(line).toContain("in English");
    expect(line).toContain("whatever language the operator used");
    expect(line).toContain(
      "Keep paths, file names, identifiers, commands and other literal strings as-is",
    );
    expect(line).toContain("untransliterated");
  });

  it("places the English-fields line right after the role line (brief-language, design D1)", () => {
    const lines = buildFusionSection(twoModels).split("\n");
    const roleIndex = lines.findIndex((text) => text.startsWith("- Tasks carry a `role`:"));
    expect(roleIndex).toBeGreaterThan(-1);
    expect(lines[roleIndex + 1]).toMatch(/^- Write every task's /);
  });

  it("states the roles and when to send each (design §7)", () => {
    const section = buildFusionSection(twoModels);
    expect(section).toContain("`worker` (implementation — the default");
    expect(section).toContain("`scout` (read-only code recon");
    expect(section).toContain("`researcher` (web research per the configured `researcherWeb`");
    expect(section).toContain("`reviewer` (adversarial check");
    expect(section).toContain("`verdict: pass|fail`");
    expect(section).toContain("a worker report carries no role fields");
  });

  it("states the openspec/ write-edit boundary and the single-perl bash exception (design §7)", () => {
    const section = buildFusionSection(twoModels);
    expect(section).toContain("realpath target of the project's `openspec/`");
    expect(section).toContain("a verifiable boundary, not a sandbox");
    expect(section).toContain("ONLY a single `perl` invocation");
    expect(section).toContain("Pass the perl program in single quotes");
    expect(section).toContain("trust, not a sandbox");
    expect(section).toContain("`powershell` is blocked by default");
  });

  it("states the single-bd bash exception, its frame and that workers keep out of the tracker (design §7, §6.5)", () => {
    const section = buildFusionSection(twoModels);
    expect(section).toContain(
      "OR ONLY a single `bd` command whose subcommand is `create`, `show`, `list`, `ready`, `update` or `close`",
    );
    expect(section).toContain("you alone keep the task tracker; workers never touch it");
    expect(section).toContain("trust, not a sandbox, and not a check of bd permissions");
  });

  it("tells the lead to quote bd arguments with glob, brace, tilde, comment and history characters (design §6.1.7, §6.1.3)", () => {
    const section = buildFusionSection(twoModels);
    expect(section).toContain(
      "Quote every bd argument that contains `*`, `?`, `[`, `]`, `{`, `}`, `~`, `#` or `!`",
    );
    expect(section).toContain("an unquoted `#` in perl or bd");
  });

  it("states the subagent priority line while enabled, whatever the worker models (fusion-lead-subagent-block, FR-002)", () => {
    const line =
      "- While fusion is on, the native `subagent` tool is blocked for the lead (it is in the lead block list): every delegation — workers, scouts, researchers, reviewers, including independent gate-running reviews — goes through `fusion_delegate`. This section supersedes ambient orchestration instructions (AGENTS.md §4, subagent-orchestration skills).";
    expect(buildFusionSection(twoModels).split("\n")).toContain(line);
    expect(buildFusionSection({ ...twoModels, workerModels: [] }).split("\n")).toContain(line);
  });

  it("places the subagent line right after the fusion_delegate discipline line (design §3)", () => {
    const lines = buildFusionSection(twoModels).split("\n");
    const delegateIndex = lines.findIndex((line) =>
      line.startsWith("- Call `fusion_delegate` on its own"),
    );
    expect(delegateIndex).toBeGreaterThan(-1);
    expect(lines[delegateIndex + 1]).toContain(
      "the native `subagent` tool is blocked for the lead",
    );
    expect(
      lines.filter((line) => line.includes("the native `subagent` tool is blocked")),
    ).toHaveLength(1);
  });

  it("removes the subagent line when fusion is off (no residue, no duplicate)", () => {
    const on = options("Project note.");
    applyFusionSection(on, twoModels);
    expect(on.appendSystemPrompt).toContain("the native `subagent` tool is blocked");
    applyFusionSection(on, { ...twoModels, enabled: false });
    expect(on.appendSystemPrompt).toBe("Project note.");
    expect(on.appendSystemPrompt).not.toContain("subagent");
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
