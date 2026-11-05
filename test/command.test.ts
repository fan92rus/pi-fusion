/**
 * /fusion command (design rev.5.2 F02, PLAN §82-83): the operator's slash
 * command flips `enabled` in fusion.json (the truth that survives restart),
 * adds or removes `fusion_delegate` from the active tool set, reports state,
 * and edits the pool fields with validation. The pure core is tested through
 * an injected `FusionCommandDeps` seam — the same pattern as
 * `registerFusionDelegate(pi, config)` — so these tests pin the behaviour,
 * not pi's process.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FUSION_SUBCOMMANDS,
  type FusionCommandDeps,
  getFusionArgumentCompletions,
  registerFusionCommand,
  renderFusionHelp,
  runFusionCommand,
} from "../extensions/pi-fusion/commands.ts";
import type { FieldOrigins } from "../extensions/pi-fusion/config.ts";
import { FUSION_CONFIG_DEFAULTS, type FusionConfig } from "../extensions/pi-fusion/config.ts";
import {
  getSessionActivation,
  resetForTests,
  setSessionEnabled,
} from "../extensions/pi-fusion/session-state.ts";

const TOOL = "fusion_delegate";

beforeEach(() => resetForTests());

/**
 * Records every dependency call so a test asserts on the exact effect set.
 * `config` is the global file's content (its keys count as global-sourced);
 * `project` is the project file's content, `null` when the file is absent.
 */
function makeDeps(
  config?: Partial<FusionConfig>,
  sessionId: string = "s1",
  project: Partial<FusionConfig> | null = null,
) {
  let current: FusionConfig = { ...FUSION_CONFIG_DEFAULTS, ...config };
  // Keys the global file sets; persisting a full snapshot makes every key global.
  const globalKeys = new Set<string>(Object.keys(config ?? {}));
  let projectFile: Partial<FusionConfig> | null = project === null ? null : { ...project };
  let active: string[] = ["read", "bash"];
  const notices: Array<{ message: string; level: string }> = [];
  const calls: string[] = [];
  const statusCalls: Array<[string, any]> = [];
  const branch: any[] = [];
  const sm = {
    getSessionId: () => sessionId,
    getBranch: () => branch,
    appendEntry: (type: string, data: unknown) => {
      calls.push("appendEntry");
      branch.push({ type: "custom", customType: type, data });
    },
  };
  const pi = { appendEntry: sm.appendEntry };
  const loadGlobal = () => {
    calls.push("load");
    return { ...current };
  };
  const persistGlobal = (next: FusionConfig) => {
    calls.push("persist");
    current = { ...next };
    for (const key of Object.keys(next)) globalKeys.add(key);
  };
  const deps: FusionCommandDeps = {
    toolName: TOOL,
    loadGlobal,
    persistGlobal,
    loadEffective: () => {
      calls.push("loadEffective");
      return { ...current, ...(projectFile ?? {}) } as FusionConfig;
    },
    getOrigins: () => {
      const origins: Record<string, "local" | "global" | "default"> = {};
      for (const key of Object.keys(FUSION_CONFIG_DEFAULTS)) {
        origins[key] =
          projectFile !== null && key in projectFile
            ? "local"
            : globalKeys.has(key)
              ? "global"
              : "default";
      }
      return origins as FieldOrigins;
    },
    projectConfigExists: () => projectFile !== null,
    persistProjectDelta: (delta: Partial<FusionConfig>) => {
      calls.push("persistProjectDelta");
      const defined = Object.fromEntries(
        Object.entries(delta).filter(([, value]) => value !== undefined),
      );
      projectFile = { ...(projectFile ?? {}), ...defined };
    },
    clearProjectOverride: (key: keyof FusionConfig) => {
      calls.push("clearProjectOverride");
      if (projectFile === null) return;
      const { [key]: _removed, ...rest } = projectFile;
      projectFile = Object.keys(rest).length > 0 ? rest : null;
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
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
    roleProfileStatuses: () => [],
    installRoleAgents: () => {
      calls.push("installRoleAgents");
      return [];
    },
    notify: (message: string, level = "info") => {
      notices.push({ message, level });
    },
    setStatus: (key: string, text: any) => {
      calls.push("setStatus");
      statusCalls.push([key, text]);
    },
    dialogs: null,
    interactiveConfig: async () => {
      calls.push("interactiveConfig");
    },
    getActivation: () => getSessionActivation(sm as any),
    setActivation: (value: boolean) => setSessionEnabled(pi as any, sm as any, value),
    appendEntry: (type: string, data: unknown) => sm.appendEntry(type, data),
    sessionManager: sm,
    sm,
    sessionId: () => sessionId,
  } as any;
  return {
    deps,
    config: () => current,
    project: () => projectFile,
    active: () => active,
    notices,
    calls,
    branch,
    sessionId,
    persisted: () => calls.filter((c) => c === "persist").length,
    resetSession: () => resetForTests(),
    statusCalls,
    statuses: statusCalls,
    statusWrites: statusCalls,
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
  it("activates the tool and installs stale profiles per profile (B6) without writing fusion.json", async () => {
    const host = makeDeps();
    host.deps.roleProfileStatuses = () => [
      { name: "fusion-worker", status: "current", path: "/a/fusion-worker.md" },
      { name: "fusion-scout", status: "stale", path: "/a/fusion-scout.md" },
    ];
    host.deps.installRoleAgents = () => {
      host.calls.push("installRoleAgents");
      return [
        { name: "fusion-worker", outcome: "current", path: "/a/fusion-worker.md" },
        { name: "fusion-scout", outcome: "updated", path: "/a/fusion-scout.md" },
      ];
    };
    await runFusionCommand("on", host.deps);
    expect(host.deps.getActivation().enabled).toBe(true);
    expect(host.active()).toContain(TOOL);
    expect(host.calls).toContain("installRoleAgents");
    const notice = host.notices[0]?.message ?? "";
    expect(notice).toContain("fusion: on.");
    expect(notice).toContain("fusion-worker: current @ /a/fusion-worker.md");
    expect(notice).toContain("fusion-scout: updated @ /a/fusion-scout.md");
    // Shared config is not written for activation.
    expect(host.persisted()).toBe(0);
    expect(host.notices[0]?.level).toBe("info");
  });
  it("keeps the tool when already active and skips install when every profile is current", async () => {
    const host = makeDeps();
    host.deps.setActivation(true);
    host.deps.roleProfileStatuses = () => [
      { name: "fusion-worker", status: "current", path: "/a/fusion-worker.md" },
      { name: "fusion-scout", status: "current", path: "/a/fusion-scout.md" },
    ];
    host.active().push(TOOL);
    await runFusionCommand("on", host.deps);
    expect(host.active()).toEqual(["read", "bash", TOOL]);
    expect(host.calls).not.toContain("installRoleAgents");
    expect(host.calls).not.toContain("setActiveTools");
    // Every profile is listed as current even when nothing installs (§4.6/§7).
    const notice = host.notices[0]?.message ?? "";
    expect(notice).toContain("fusion: on.");
    expect(notice).toContain("fusion-worker: current @ /a/fusion-worker.md");
    expect(notice).toContain("fusion-scout: current @ /a/fusion-scout.md");
  });
});

describe("runFusionCommand: off", () => {
  it("removes the tool from the active set without writing fusion.json", async () => {
    const host = makeDeps();
    host.deps.setActivation(true);
    host.active().push(TOOL);
    await runFusionCommand("off", host.deps);
    expect(host.deps.getActivation().enabled).toBe(false);
    expect(host.active()).not.toContain(TOOL);
    expect(host.active()).toEqual(["read", "bash"]);
    expect(host.calls).not.toContain("installAgent");
  });

  it("leaves the active set untouched when the tool is not in it", async () => {
    const host = makeDeps();
    host.deps.setActivation(true);
    await runFusionCommand("off", host.deps);
    expect(host.calls).not.toContain("setActiveTools");
    expect(host.deps.getActivation().enabled).toBe(false);
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
  it("reports enabled, models, width, timeout and per-profile statuses", async () => {
    const host = makeDeps({
      workers: 3,
      maxParallel: 3,
      taskTimeoutMs: 600_000,
      workerModels: ["m/a", "m/b"],
    });
    host.deps.setActivation(true);
    host.deps.roleProfileStatuses = () => [
      { name: "fusion-worker", status: "current", path: "/a/fusion-worker.md" },
      { name: "fusion-scout", status: "stale", path: "/a/fusion-scout.md" },
    ];
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(host.notices[0]?.level).toBe("info");
    expect(status).toContain("on");
    expect(status).toContain("m/a");
    expect(status).toContain("m/b");
    expect(status).toContain("3");
    expect(status).toContain("600000");
    expect(status).toContain("agent fusion-worker: current");
    expect(status).toContain("agent fusion-scout: stale");
    expect(status).toContain("researcherWeb: none");
    expect(host.persisted()).toBe(0);
  });

  it("reports off, the empty rotation and absent profiles", async () => {
    const host = makeDeps({ workerModels: [] });
    host.deps.roleProfileStatuses = () => [
      { name: "fusion-worker", status: "absent", path: "/a/fusion-worker.md" },
    ];
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(status).toContain("off");
    expect(status).toContain("(none");
    expect(status).toContain("agent fusion-worker: absent");
  });
});

describe("runFusionCommand: status shows the source of each field (design D8)", () => {
  it("suffixes every field with its local, global or default source", async () => {
    const host = makeDeps({ workers: 8, workerModels: ["m/a", "m/b"] }, "s1", { workers: 8 });
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(host.notices[0]?.level).toBe("info");
    expect(status).toContain("workers: 8 [local]");
    expect(status).toContain("models: m/a, m/b [global]");
    expect(status).toContain("timeout: 600000 [default]");
    expect(status).toContain("maxParallel: 3 [default]");
    expect(status).toContain("requireApproval: true [default]");
    expect(status).toContain("blockedTools: fusion_delegate, subagent, codemode [default]");
    expect(status).toContain("leadBlockedTools: write, edit, bash, powershell, subagent [default]");
    expect(status).toContain("researcherWeb: none [default]");
    expect(host.persisted()).toBe(0);
  });

  it("shows global for global-only fields and never local when no project file exists", async () => {
    const host = makeDeps({ workers: 4, maxParallel: 2 });
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(status).toContain("workers: 4 [global]");
    expect(status).toContain("maxParallel: 2 [global]");
    expect(status).not.toContain("[local]");
  });

  it("shows maxSteps with its source: the field the status used to omit (review blocker)", async () => {
    const host = makeDeps({ maxSteps: 25 });
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(status).toContain("maxSteps: 25 [global]");
  });

  it("gives each of the nine config fields its own line with a source suffix", async () => {
    const host = makeDeps({}, "s1", {
      maxSteps: 12,
      requireApproval: false,
      researcherWeb: "both",
    });
    await runFusionCommand("status", host.deps);
    const lines = (host.notices[0]?.message ?? "").split("\n");
    const labels = [
      "workers",
      "maxParallel",
      "timeout",
      "maxSteps",
      "models",
      "requireApproval",
      "blockedTools",
      "leadBlockedTools",
      "researcherWeb",
    ];
    for (const label of labels) {
      const line = lines.find((row) => row.startsWith(`${label}: `));
      expect(line, label).toBeDefined();
      expect(line, label).toMatch(/ \[(local|global|default)\]$/);
    }
    expect(lines.find((row) => row.startsWith("maxSteps: "))).toBe("maxSteps: 12 [local]");
    expect(lines.find((row) => row.startsWith("requireApproval: "))).toBe(
      "requireApproval: false [local]",
    );
    expect(lines.find((row) => row.startsWith("researcherWeb: "))).toBe(
      "researcherWeb: both [local]",
    );
  });

  it("shows the effective value of a local override, not the global one", async () => {
    const host = makeDeps({ workers: 4 }, "s1", { workers: 9 });
    await runFusionCommand("status", host.deps);
    const status = host.notices[0]?.message ?? "";
    expect(status).toContain("workers: 9 [local]");
    expect(status).not.toContain("workers: 4");
  });
});

describe("runFusionCommand: shortcuts write to the layer the value came from (design D4)", () => {
  it("workers writes the delta into an existing local file and leaves global untouched", async () => {
    const host = makeDeps({ workers: 3 }, "s1", { workers: 4 });
    await runFusionCommand("workers 5", host.deps);
    expect(host.project()).toEqual({ workers: 5 });
    expect(host.config().workers).toBe(3);
    expect(host.persisted()).toBe(0);
    expect(host.notices[0]?.level).toBe("info");
  });

  it("model writes only workerModels into an existing local file, even an empty one", async () => {
    const host = makeDeps({ workerModels: ["m/global"] }, "s1", {});
    await runFusionCommand("model vendor/a, vendor/b", host.deps);
    expect(host.project()).toEqual({ workerModels: ["vendor/a", "vendor/b"] });
    expect(host.config().workerModels).toEqual(["m/global"]);
    expect(host.persisted()).toBe(0);
  });

  it("timeout writes taskTimeoutMs into an existing local file", async () => {
    const host = makeDeps({ taskTimeoutMs: 600_000 }, "s1", { workers: 2 });
    await runFusionCommand("timeout 300000", host.deps);
    expect(host.project()).toEqual({ workers: 2, taskTimeoutMs: 300_000 });
    expect(host.config().taskTimeoutMs).toBe(600_000);
    expect(host.persisted()).toBe(0);
  });

  it("without a local file the shortcuts write global and never create the project file", async () => {
    for (const arg of ["workers 5", "model vendor/a", "timeout 300000"]) {
      const host = makeDeps({ workers: 3 });
      await runFusionCommand(arg, host.deps);
      expect(host.persisted(), arg).toBe(1);
      expect(host.calls, arg).not.toContain("persistProjectDelta");
      expect(host.project(), arg).toBeNull();
      expect(host.notices[0]?.level, arg).toBe("info");
    }
    const host = makeDeps({ workers: 3 });
    await runFusionCommand("workers 5", host.deps);
    expect(host.config().workers).toBe(5);
  });

  it("a refused local write is reported as an error and changes neither layer", async () => {
    const host = makeDeps({ workers: 3 }, "s1", {});
    host.deps.persistProjectDelta = () => {
      throw new Error("cannot write project config .pi/fusion.json: the file is not valid JSON");
    };
    await runFusionCommand("workers 5", host.deps);
    expect(host.notices[0]?.level).toBe("error");
    expect(host.notices[0]?.message).toContain("cannot write project config");
    expect(host.config().workers).toBe(3);
    expect(host.persisted()).toBe(0);
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
    const host = makeDeps({});
    const { command, ctx } = makePi(host.deps);
    await command?.handler("off", ctx);
    expect(host.active()).not.toContain(TOOL);
  });
});

describe("fusionExtension wiring (integration)", () => {
  function _makeExtensionPi() {
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

  const _commandContext = () =>
    ({ ui: { notify: () => {} } }) as unknown as ExtensionCommandContext;
});

describe("fusion footer status (command)", () => {
  it("turnFusion on calls setStatus('fusion','fusion: on')", async () => {
    const host = makeDeps();
    await runFusionCommand("on", host.deps);
    expect(host.statusCalls).toContainEqual(["fusion", "fusion: on"]);
  });

  it("turnFusion off calls setStatus('fusion','fusion: off')", async () => {
    const host = makeDeps();
    host.deps.setActivation(true);
    await runFusionCommand("off", host.deps);
    expect(host.statusCalls).toContainEqual(["fusion", "fusion: off"]);
  });

  it("idempotent on calls setStatus('fusion','fusion: on')", async () => {
    const host = makeDeps();
    host.deps.setActivation(true);
    host.active().push(TOOL);
    await runFusionCommand("on", host.deps);
    expect(host.statusCalls).toContainEqual(["fusion", "fusion: on"]);
  });

  it("idempotent off calls setStatus('fusion','fusion: off')", async () => {
    const host = makeDeps();
    await runFusionCommand("off", host.deps);
    expect(host.statusCalls).toContainEqual(["fusion", "fusion: off"]);
  });
});
