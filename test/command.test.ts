/**
 * /fusion command (design rev.5.2 F02, PLAN §82-83): the operator's slash
 * command flips `enabled` in fusion.json (the truth that survives restart),
 * adds or removes `fusion_delegate` from the active tool set, reports state,
 * and edits the pool fields with validation. The pure core is tested through
 * an injected `FusionCommandDeps` seam — the same pattern as
 * `registerFusionDelegate(pi, config)` — so these tests pin the behaviour,
 * not pi's process.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  FUSION_SUBCOMMANDS,
  type FusionCommandDeps,
  getFusionArgumentCompletions,
  registerFusionCommand,
  renderFusionHelp,
  runFusionCommand,
} from "../extensions/pi-fusion/commands.ts";
import { FUSION_CONFIG_DEFAULTS, type FusionConfig } from "../extensions/pi-fusion/config.ts";
import { applyFusionSection, FUSION_SECTION_HEADING } from "../extensions/pi-fusion/guidance.ts";
import fusionExtension from "../extensions/pi-fusion/index.ts";

const TOOL = "fusion_delegate";

/** Records every dependency call so a test asserts on the exact effect set. */
function makeDeps(config?: Partial<FusionConfig>) {
  let current: FusionConfig = { ...FUSION_CONFIG_DEFAULTS, ...config };
  let active: string[] = ["read", "bash"];
  const notices: Array<{ message: string; level: string }> = [];
  const calls: string[] = [];
  const deps: FusionCommandDeps = {
    toolName: TOOL,
    loadConfig: () => {
      calls.push("load");
      return { ...current };
    },
    persistConfig: (next) => {
      calls.push(`persist`);
      current = { ...next };
    },
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      calls.push("setActiveTools");
      active = [...names];
    },
    agentInstalled: () => {
      calls.push("agentInstalled");
      return false;
    },
    installAgent: () => {
      calls.push("installAgent");
    },
    notify: (message, level = "info") => {
      notices.push({ message, level });
    },
    dialogs: null,
    interactiveConfig: async () => {
      calls.push("interactiveConfig");
    },
  };
  return {
    deps,
    config: () => current,
    active: () => active,
    notices,
    calls,
    persisted: () => calls.filter((c) => c === "persist").length,
  };
}

describe("getFusionArgumentCompletions", () => {
  it("offers every subcommand on an empty prefix", () => {
    const items: AutocompleteItem[] | null = getFusionArgumentCompletions("");
    expect(items?.map((item) => item.value)).toEqual(FUSION_SUBCOMMANDS.map((s) => s.name));
  });

  it("filters by the typed prefix", () => {
    expect(getFusionArgumentCompletions("wo")?.map((item) => item.value)).toEqual(["workers"]);
    expect(getFusionArgumentCompletions("st")?.map((item) => item.value)).toEqual(["status"]);
    expect(getFusionArgumentCompletions("conf")?.map((item) => item.value)).toEqual(["config"]);
  });

  it("returns null when a subcommand is fully typed", () => {
    // pi applies an open completion on Enter; offering the exact word would
    // make submitting take two Enters (pi-autoresearch precedent).
    expect(getFusionArgumentCompletions("on")).toBeNull();
    expect(getFusionArgumentCompletions("status")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(getFusionArgumentCompletions("zz")).toBeNull();
  });
});

describe("renderFusionHelp", () => {
  it("shows the usage line and every subcommand with a description", () => {
    const help = renderFusionHelp();
    expect(help).toContain("Usage: /fusion");
    for (const sub of FUSION_SUBCOMMANDS) {
      expect(help).toContain(sub.name);
      expect(help).toContain(sub.description);
    }
  });
});

describe("runFusionCommand: help routing", () => {
  it("prints help for empty args and touches nothing else", async () => {
    const host = makeDeps();
    await runFusionCommand("", host.deps);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0]?.level).toBe("info");
    expect(host.notices[0]?.message).toBe(renderFusionHelp());
    expect(host.calls).toEqual([]);
  });

  it("prints help for help, --help and -h", async () => {
    for (const arg of ["help", "--help", "-h"]) {
      const host = makeDeps();
      await runFusionCommand(arg, host.deps);
      expect(host.notices[0]?.message).toBe(renderFusionHelp());
      expect(host.persisted()).toBe(0);
    }
  });

  it("rejects an unknown subcommand with an error and no persist", async () => {
    const host = makeDeps();
    await runFusionCommand("restart", host.deps);
    expect(host.notices[0]?.level).toBe("error");
    expect(host.notices[0]?.message).toContain("Unknown");
    expect(host.persisted()).toBe(0);
  });
});

describe("runFusionCommand: on", () => {
  it("persists enabled=true, activates the tool and installs a missing agent", async () => {
    const host = makeDeps({ enabled: false });
    await runFusionCommand("on", host.deps);
    expect(host.config().enabled).toBe(true);
    expect(host.active()).toContain(TOOL);
    expect(host.calls).toContain("installAgent");
    // Every other field survives the flip.
    expect(host.config()).toEqual({ ...FUSION_CONFIG_DEFAULTS, enabled: true });
    expect(host.notices[0]?.level).toBe("info");
  });
  it("keeps the tool when already active and skips install when the agent exists", async () => {
    const host = makeDeps({ enabled: true });
    host.deps.agentInstalled = () => true;
    host.active().push(TOOL);
    await runFusionCommand("on", host.deps);
    expect(host.active()).toEqual(["read", "bash", TOOL]);
    expect(host.calls).not.toContain("installAgent");
    expect(host.calls).not.toContain("setActiveTools");
  });
});

describe("runFusionCommand: off", () => {
  it("persists enabled=false and removes the tool from the active set", async () => {
    const host = makeDeps({ enabled: true });
    host.active().push(TOOL);
    await runFusionCommand("off", host.deps);
    expect(host.config().enabled).toBe(false);
    expect(host.active()).not.toContain(TOOL);
    expect(host.active()).toEqual(["read", "bash"]);
    expect(host.calls).not.toContain("installAgent");
  });

  it("leaves the active set untouched when the tool is not in it", async () => {
    const host = makeDeps({ enabled: true });
    await runFusionCommand("off", host.deps);
    expect(host.calls).not.toContain("setActiveTools");
    expect(host.config().enabled).toBe(false);
  });
});

describe("runFusionCommand: workers", () => {
  it("persists a positive integer width and preserves the other fields", async () => {
    const host = makeDeps({ workers: 3, workerModels: ["m/a"] });
    await runFusionCommand("workers 4", host.deps);
    expect(host.config().workers).toBe(4);
    expect(host.config().workerModels).toEqual(["m/a"]);
    expect(host.notices[0]?.level).toBe("info");
  });

  it("rejects zero, negative, fractional and non-numeric widths", async () => {
    for (const arg of ["workers 0", "workers -1", "workers 1.5", "workers abc", "workers"]) {
      const host = makeDeps();
      await runFusionCommand(arg, host.deps);
      expect(host.notices[0]?.level).toBe("error");
      expect(host.persisted()).toBe(0);
    }
  });
});

describe("runFusionCommand: model", () => {
  it("persists a comma-separated rotation, trimming entries", async () => {
    const host = makeDeps();
    await runFusionCommand("model openai/gpt-5-mini, google/gemini-2.5-flash", host.deps);
    expect(host.config().workerModels).toEqual(["openai/gpt-5-mini", "google/gemini-2.5-flash"]);
    expect(host.notices[0]?.level).toBe("info");
  });

  it("rejects an empty rotation", async () => {
    for (const arg of ["model", "model , ,"]) {
      const host = makeDeps();
      await runFusionCommand(arg, host.deps);
      expect(host.notices[0]?.level).toBe("error");
      expect(host.persisted()).toBe(0);
    }
  });

  it("matches the subcommand case-insensitively and keeps model-id case (review fix)", async () => {
    const host = makeDeps();
    await runFusionCommand("MODEL Zai-Coding-CN/GLM-5.3-Flash, OpenAI/GPT-6-Luna", host.deps);
    expect(host.config().workerModels).toEqual([
      "Zai-Coding-CN/GLM-5.3-Flash",
      "OpenAI/GPT-6-Luna",
    ]);
  });
});

describe("runFusionCommand: timeout", () => {
  it("persists a positive integer ms budget", async () => {
    const host = makeDeps({ taskTimeoutMs: 600_000 });
    await runFusionCommand("timeout 300000", host.deps);
    expect(host.config().taskTimeoutMs).toBe(300_000);
    expect(host.notices[0]?.level).toBe("info");
  });

  it("rejects zero, negative, fractional and non-numeric budgets", async () => {
    for (const arg of ["timeout 0", "timeout -5", "timeout 2.5s", "timeout", "timeout soon"]) {
      const host = makeDeps();
      await runFusionCommand(arg, host.deps);
      expect(host.notices[0]?.level).toBe("error");
      expect(host.persisted()).toBe(0);
    }
  });

  it("rejects a budget outside the config bounds without persisting (review fix)", async () => {
    for (const arg of ["timeout 1000", "timeout 29999", "timeout 3600001"]) {
      const host = makeDeps();
      await runFusionCommand(arg, host.deps);
      expect(host.notices[0]?.level).toBe("error");
      expect(host.notices[0]?.message).toContain("from 30000 to 3600000");
      expect(host.persisted()).toBe(0);
    }
  });

  it("accepts the exact config bounds", async () => {
    const low = makeDeps();
    await runFusionCommand("timeout 30000", low.deps);
    expect(low.config().taskTimeoutMs).toBe(30_000);
    const high = makeDeps();
    await runFusionCommand("timeout 3600000", high.deps);
    expect(high.config().taskTimeoutMs).toBe(3_600_000);
  });
});

describe("runFusionCommand: config", () => {
  it("refuses in headless mode with an error and never opens the menu", async () => {
    const host = makeDeps();
    let opened = false;
    host.deps.interactiveConfig = async () => {
      opened = true;
    };
    await runFusionCommand("config", host.deps);
    expect(opened).toBe(false);
    expect(host.notices).toEqual([
      {
        level: "error",
        message:
          "Interactive config requires a TUI. Edit fusion.json directly, or use /fusion workers|model|timeout.",
      },
    ]);
    expect(host.persisted()).toBe(0);
  });

  it("opens the interactive menu when dialogs are attached", async () => {
    const host = makeDeps();
    host.deps.dialogs = {
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => true,
    };
    let opened = false;
    host.deps.interactiveConfig = async () => {
      opened = true;
    };
    await runFusionCommand("config", host.deps);
    expect(opened).toBe(true);
    expect(host.persisted()).toBe(0);
  });
});

describe("runFusionCommand: status", () => {
  it("reports enabled, models, width, timeout and agent presence", async () => {
    const host = makeDeps({
      enabled: true,
      workers: 3,
      maxParallel: 3,
      taskTimeoutMs: 600_000,
      workerModels: ["m/a", "m/b"],
    });
    host.deps.agentInstalled = () => true;
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(host.notices[0]?.level).toBe("info");
    expect(status).toContain("on");
    expect(status).toContain("m/a");
    expect(status).toContain("m/b");
    expect(status).toContain("3");
    expect(status).toContain("600000");
    expect(status).toContain("installed");
    expect(host.persisted()).toBe(0);
  });

  it("reports off, the empty rotation and a missing agent", async () => {
    const host = makeDeps({ enabled: false, workerModels: [] });
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(status).toContain("off");
    expect(status).toContain("(none");
    expect(status).toContain("missing");
  });
});

describe("runFusionCommand: guidance interplay (F08)", () => {
  // The section lives in guidance.ts; it appears/disappears because the
  // facts provider reads the config the command persists — per run.
  function sectionAfterCommand(args: string, initial: Partial<FusionConfig>): Promise<string> {
    const host = makeDeps(initial);
    return runFusionCommand(args, host.deps).then(() => {
      const options: { appendSystemPrompt: string } = { appendSystemPrompt: "" };
      applyFusionSection(options, { ...host.config() });
      return options.appendSystemPrompt;
    });
  }

  it("on makes the section appear, off removes it", async () => {
    expect(await sectionAfterCommand("on", { enabled: false })).toContain(FUSION_SECTION_HEADING);
    expect(await sectionAfterCommand("off", { enabled: true })).not.toContain(
      FUSION_SECTION_HEADING,
    );
  });
});

describe("registerFusionCommand", () => {
  interface RegisteredFusionCommand {
    name: string;
    description?: string;
    getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }

  function makePi(deps: FusionCommandDeps) {
    const registered: RegisteredFusionCommand[] = [];
    const pi = {
      registerCommand(name: string, options: Omit<RegisteredFusionCommand, "name">) {
        registered.push({ name, ...options });
      },
    };
    const ctx = {
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error") =>
          deps.notify(message, level),
      },
    };
    registerFusionCommand(pi as unknown as ExtensionAPI, () => deps);
    return { command: registered[0], ctx: ctx as unknown as ExtensionCommandContext };
  }

  it("registers the fusion command with completions and the usage description", () => {
    const { command } = makePi(makeDeps().deps);
    expect(command?.name).toBe("fusion");
    expect(command?.description).toContain("fusion");
    expect(command?.getArgumentCompletions?.("")?.map((item) => item.value)).toEqual(
      FUSION_SUBCOMMANDS.map((s) => s.name),
    );
  });

  it("routes the typed args through runFusionCommand with the bound deps", async () => {
    const host = makeDeps({ enabled: false });
    const { command, ctx } = makePi(host.deps);
    await command?.handler("off", ctx);
    expect(host.config().enabled).toBe(false);
    expect(host.active()).not.toContain(TOOL);
  });
});

describe("fusionExtension wiring (integration)", () => {
  function makeExtensionPi() {
    const commands = new Map<
      string,
      { handler?: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    >();
    const tools = new Map<string, { name: string }>();
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    let activeTools = ["read", "bash"];
    const pi = {
      registerCommand: (
        name: string,
        options: { handler?: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => {
        commands.set(name, options);
      },
      registerTool: (definition: { name: string }) => {
        tools.set(definition.name, definition);
      },
      on: (event: string, handler: (event: unknown) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools = [...names];
      },
    };
    const fire = async (event: string, payload: unknown = {}): Promise<void> => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    };
    return { pi, commands, tools, fire, active: () => activeTools };
  }

  const commandContext = () => ({ ui: { notify: () => {} } }) as unknown as ExtensionCommandContext;

  it("registers /fusion and fusion_delegate; /fusion on persists, activates the tool, installs the agent and shows the section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-ext-"));
    try {
      const configPath = join(dir, "fusion.json");
      const agentDir = join(dir, "agent");
      const harness = makeExtensionPi();
      fusionExtension(harness.pi as unknown as ExtensionAPI, { configPath, agentDir });

      expect(harness.commands.has("fusion")).toBe(true);
      expect(harness.tools.has(TOOL)).toBe(true);

      // §13 feature flag: disabled at startup → session_start removes the tool.
      await harness.fire("session_start");
      expect(harness.active()).not.toContain(TOOL);

      // Guidance reads fresh per run: no section while disabled.
      const promptBefore = { appendSystemPrompt: "" };
      await harness.fire("before_agent_start", { systemPromptOptions: promptBefore });
      expect(promptBefore.appendSystemPrompt).not.toContain(FUSION_SECTION_HEADING);

      // /fusion on: persist to disk, activate the tool, install a missing agent.
      const handler = harness.commands.get("fusion")?.handler;
      expect(handler).toBeDefined();
      await handler?.("on", commandContext());

      const persisted = JSON.parse(readFileSync(configPath, "utf8")) as FusionConfig;
      expect(persisted.enabled).toBe(true);
      expect(harness.active()).toContain(TOOL);
      expect(existsSync(join(agentDir, "agents", "fusion-worker.md"))).toBe(true);

      // The next guidance run sees the persisted state.
      const promptAfter = { appendSystemPrompt: "" };
      await harness.fire("before_agent_start", { systemPromptOptions: promptAfter });
      expect(promptAfter.appendSystemPrompt).toContain(FUSION_SECTION_HEADING);

      // /fusion off: persist and drop the tool again.
      await handler?.("off", commandContext());
      const afterOff = JSON.parse(readFileSync(configPath, "utf8")) as FusionConfig;
      expect(afterOff.enabled).toBe(false);
      expect(harness.active()).not.toContain(TOOL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
