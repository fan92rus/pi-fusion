/**
 * /fusion config menu (config-ui.ts): the interactive loop is tested through
 * the same injected seam as the command — scripted dialogs answer each
 * select/input/confirm in order, and the assertions pin the persisted values
 * and the notices. The layered operations run against REAL files in a temp
 * directory (config.ts), so the broken-file refusal and the empty-file
 * deletion are the production contract, not a fake's imitation. Menu rows are
 * picked through `fusionMenuItems` by id, so the tests are locale-independent
 * (the UI text itself follows the machine locale, RU or EN, like
 * pi-autoresearch's config menu).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FusionCommandDeps, FusionUIDialogs } from "../extensions/pi-fusion/commands.ts";
import {
  clearProjectFusionOverride,
  type FieldOrigins,
  FUSION_CONFIG_DEFAULTS,
  type FusionConfig,
  loadEffectiveConfig,
  loadFusionConfig,
  persistFusionConfig,
  persistProjectFusionDelta,
  projectFusionConfigPath,
} from "../extensions/pi-fusion/config.ts";
import {
  formatCurrent,
  fusionMenuItems,
  interactiveFusionConfig,
  layerOptionLabels,
  MENU_ACTIONS,
  type MenuItemId,
  RESEARCHER_WEB_OPTIONS,
  resetRowLabel,
} from "../extensions/pi-fusion/config-ui.ts";

const roots: string[] = [];

beforeEach(() => {
  // config.ts warns about broken layer files; the tests assert the outcome instead.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Real-file harness. `config` is the global file's content (only the keys
 * given, so the others read as `default`); `project` is the project file:
 * an object is written as JSON, a string is written verbatim (a broken file),
 * `null` means no file.
 */
function makeDeps(
  config?: Partial<FusionConfig>,
  project: Record<string, unknown> | string | null = null,
) {
  const root = mkdtempSync(join(tmpdir(), "fusion-config-ui-"));
  roots.push(root);
  const globalPath = join(root, "agent", "fusion.json");
  const projectDir = join(root, "project");
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  if (config !== undefined) writeFileSync(globalPath, JSON.stringify(config));
  const projectPath = projectFusionConfigPath(projectDir);
  if (typeof project === "string") writeFileSync(projectPath, project);
  else if (project !== null) writeFileSync(projectPath, JSON.stringify(project));

  let active: string[] = ["read", "bash"];
  const notices: Array<{ message: string; level: string }> = [];
  const counters = { globalWrites: 0, projectWrites: 0 };
  const deps: FusionCommandDeps = {
    toolName: "fusion_delegate",
    loadEffective: () => loadEffectiveConfig(globalPath, projectDir).config as FusionConfig,
    getOrigins: () => loadEffectiveConfig(globalPath, projectDir).origins,
    loadGlobal: () => loadFusionConfig(globalPath) as FusionConfig,
    persistGlobal: (next) => {
      counters.globalWrites += 1;
      persistFusionConfig(next, globalPath);
    },
    projectConfigExists: () => existsSync(projectPath),
    persistProjectDelta: (delta) => {
      counters.projectWrites += 1;
      persistProjectFusionDelta(delta, projectDir);
    },
    clearProjectOverride: (key) => {
      counters.projectWrites += 1;
      clearProjectFusionOverride(key, projectDir);
    },
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
    agentInstalled: () => false,
    installAgent: () => {},
    roleProfileStatuses: () => [],
    installRoleAgents: () => [],
    notify: (message, level = "info") => {
      notices.push({ message, level });
    },
    dialogs: null,
    interactiveConfig: async () => {},
    getActivation: () => ({ enabled: false, source: "default-off" }),
    setActivation: () => {},
    appendEntry: () => {},
    sessionManager: { getSessionId: () => "s", getBranch: () => [], appendEntry: () => {} },
    setStatus: () => {},
  };
  const readRaw = (path: string): Record<string, unknown> | null =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
  return {
    deps,
    globalPath,
    projectPath,
    config: (): FusionConfig => loadFusionConfig(globalPath) as FusionConfig,
    effective: (): FusionConfig =>
      loadEffectiveConfig(globalPath, projectDir).config as FusionConfig,
    origins: (): FieldOrigins => loadEffectiveConfig(globalPath, projectDir).origins,
    active: () => active,
    notices,
    persisted: () => counters.globalWrites,
    projectWrites: () => counters.projectWrites,
    projectRaw: () => readRaw(projectPath),
    projectExists: () => existsSync(projectPath),
    globalRaw: () => readRaw(globalPath),
    errors: () => notices.filter((n) => n.level === "error"),
  };
}

/** Dialogs that replay scripted answers: one shift per select/input/confirm call. */
function scriptedDialogs(
  select: (string | undefined)[],
  input: (string | undefined)[] = [],
  confirm: boolean[] = [],
) {
  const selectQueue = [...select];
  const inputQueue = [...input];
  const confirmQueue = [...confirm];
  /** The option rows of every select the menu opened, in order. */
  const selects: string[][] = [];
  /** The message of every confirm the menu asked, in order. */
  const confirms: string[] = [];
  const dialogs: FusionUIDialogs & { selects: string[][]; confirms: string[] } = {
    selects,
    confirms,
    select: async (_title, options) => {
      selects.push(options);
      return selectQueue.shift();
    },
    input: async () => inputQueue.shift(),
    confirm: async (_title, message) => {
      confirms.push(message);
      return confirmQueue.shift() ?? false;
    },
  };
  return dialogs;
}

/** The localized label of a menu row, resolved by id (origin tag when `origins` is given). */
function labelFor(config: FusionConfig, id: MenuItemId, origins?: FieldOrigins): string {
  const item = fusionMenuItems(config, origins).find((entry) => entry.id === id);
  if (!item) throw new Error(`no menu item: ${id}`);
  return item.label;
}

/** The label of the loop-terminating "done" row (locale-correct). */
const DONE = MENU_ACTIONS.done;
const BACK = MENU_ACTIONS.back;
const SWITCH = MENU_ACTIONS.layer;
/** The switcher's options: the global label is the same either way; the local one notes the file. */
const GLOBAL_PICK = layerOptionLabels(false).global;
const LOCAL_MISSING = layerOptionLabels(false).local;
const LOCAL_EXISTS = layerOptionLabels(true).local;

describe("interactiveFusionConfig", () => {
  it("immediate done changes nothing", async () => {
    const host = makeDeps();
    await interactiveFusionConfig(host.deps, scriptedDialogs([GLOBAL_PICK, DONE]));
    expect(host.persisted()).toBe(0);
    expect(host.projectWrites()).toBe(0);
    expect(host.errors()).toEqual([]);
  });

  it("shows the current snapshot on close", async () => {
    const host = makeDeps({ workers: 4 });
    await interactiveFusionConfig(host.deps, scriptedDialogs([GLOBAL_PICK, DONE]));
    // The last notice reports the saved state of the layer that was open.
    expect(host.notices.at(-1)?.message).toContain(formatCurrent(host.config()));
  });

  it("edits a number field within its bounds", async () => {
    const host = makeDeps();
    const workers = labelFor(host.config(), "workers");
    await interactiveFusionConfig(host.deps, scriptedDialogs([GLOBAL_PICK, workers, DONE], ["4"]));
    expect(host.persisted()).toBe(1);
    expect(host.config().workers).toBe(4);
    expect(host.errors()).toEqual([]);
  });

  it("rejects a non-numeric value without persisting", async () => {
    const host = makeDeps();
    const workers = labelFor(host.config(), "workers");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, workers, DONE], ["abc"]),
    );
    expect(host.persisted()).toBe(0);
    expect(host.errors()).toHaveLength(1);
  });

  it("rejects an out-of-bounds value without persisting", async () => {
    const host = makeDeps();
    const maxParallel = labelFor(host.config(), "maxParallel");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, maxParallel, DONE], ["99"]),
    );
    expect(host.persisted()).toBe(0);
    expect(host.config().maxParallel).toBe(FUSION_CONFIG_DEFAULTS.maxParallel);
    expect(host.errors()).toHaveLength(1);
  });

  it("edits the task timeout", async () => {
    const host = makeDeps();
    const timeout = labelFor(host.config(), "taskTimeoutMs");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, timeout, DONE], ["300000"]),
    );
    expect(host.config().taskTimeoutMs).toBe(300_000);
  });

  it("edits maxSteps", async () => {
    const host = makeDeps();
    const maxSteps = labelFor(host.config(), "maxSteps");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, maxSteps, DONE], ["120"]),
    );
    expect(host.config().maxSteps).toBe(120);
  });

  it("parses a comma- and space-separated model rotation", async () => {
    const host = makeDeps();
    const models = labelFor(host.config(), "workerModels");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs(
        [GLOBAL_PICK, models, DONE],
        ["vendor/alpha, vendor/beta   openai/gpt-6-luna"],
      ),
    );
    expect(host.config().workerModels).toEqual([
      "vendor/alpha",
      "vendor/beta",
      "openai/gpt-6-luna",
    ]);
  });

  it("clears a list with the clear keyword", async () => {
    const host = makeDeps();
    const blocked = labelFor(host.config(), "blockedTools");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, blocked, DONE], ["clear"]),
    );
    expect(host.config().blockedTools).toEqual([]);
  });

  it("refuses a separator-only list without persisting (review fix)", async () => {
    // ", ," parses to zero entries and would silently empty the rotation;
    // the contract reserves `clear` for that, so the input must be refused.
    const host = makeDeps();
    const models = labelFor(host.config(), "workerModels");
    await interactiveFusionConfig(host.deps, scriptedDialogs([GLOBAL_PICK, models, DONE], [", ,"]));
    expect(host.persisted()).toBe(0);
    expect(host.errors()).toHaveLength(1);
    expect(host.config().workerModels).toEqual(FUSION_CONFIG_DEFAULTS.workerModels);
  });

  it("blank input cancels an edit without persisting", async () => {
    const host = makeDeps();
    const models = labelFor(host.config(), "workerModels");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, models, DONE], [undefined]),
    );
    expect(host.persisted()).toBe(0);
    expect(host.config().workerModels).toEqual(FUSION_CONFIG_DEFAULTS.workerModels);
  });

  it("has no activation row: the menu omits enabled and the snapshot omits the mode line", () => {
    const host = makeDeps();
    const ids = fusionMenuItems(host.config()).map((item) => item.id);
    expect(ids).not.toContain("enabled");
    expect(formatCurrent(host.config())).not.toMatch(/^\s*(mode|режим):/m);
  });

  it("never changes the session's tool activation, even while editing settings", async () => {
    const host = makeDeps();
    const workers = labelFor(host.config(), "workers");
    const approval = labelFor(host.config(), "approval");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, workers, approval, MENU_ACTIONS.approvalOptional, DONE], ["4"]),
    );
    expect(host.config().workers).toBe(4);
    expect(host.active()).toEqual(["read", "bash"]);
  });

  it("toggles the approval requirement off", async () => {
    const host = makeDeps();
    const approval = labelFor(host.config(), "approval");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, approval, MENU_ACTIONS.approvalOptional, DONE]),
    );
    expect(host.config().requireApproval).toBe(false);
    expect(host.persisted()).toBe(1);
  });

  it("sets researcherWeb through the composition selector", async () => {
    const host = makeDeps();
    const row = labelFor(host.config(), "researcherWeb");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, row, RESEARCHER_WEB_OPTIONS.web, DONE]),
    );
    expect(host.config().researcherWeb).toBe("web");
    expect(host.persisted()).toBe(1);
  });

  it("researcherWeb picker: same state persists nothing, back-out persists nothing", async () => {
    const host = makeDeps({ researcherWeb: "web" });
    const row = labelFor(host.config(), "researcherWeb");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, row, RESEARCHER_WEB_OPTIONS.web, DONE]),
    );
    expect(host.persisted()).toBe(0);
    const host2 = makeDeps();
    const row2 = labelFor(host2.config(), "researcherWeb");
    await interactiveFusionConfig(
      host2.deps,
      scriptedDialogs([GLOBAL_PICK, row2, MENU_ACTIONS.back, DONE]),
    );
    expect(host2.persisted()).toBe(0);
    expect(host2.config().researcherWeb).toBe("none");
  });

  it("installs stale profiles on open and reports each outcome (B6 on the config path)", async () => {
    const host = makeDeps();
    let installed = 0;
    host.deps.roleProfileStatuses = () => [
      { name: "fusion-worker", status: "current", path: "/a/fusion-worker.md" },
      { name: "fusion-reviewer", status: "absent", path: "/a/fusion-reviewer.md" },
    ];
    host.deps.installRoleAgents = () => {
      installed += 1;
      return [{ name: "fusion-reviewer", outcome: "installed", path: "/a/fusion-reviewer.md" }];
    };
    await interactiveFusionConfig(host.deps, scriptedDialogs([GLOBAL_PICK, DONE]));
    expect(installed).toBe(1);
    const notice = host.notices.find((entry) => entry.message.includes("profiles:"));
    expect(notice?.message).toContain("fusion-reviewer: installed @ /a/fusion-reviewer.md");
    // All-current opens list every profile without installing anything.
    const host2 = makeDeps();
    host2.deps.roleProfileStatuses = () => [
      { name: "fusion-worker", status: "current", path: "/a/fusion-worker.md" },
    ];
    host2.deps.installRoleAgents = () => {
      throw new Error("must not install when every profile is current");
    };
    await interactiveFusionConfig(host2.deps, scriptedDialogs([GLOBAL_PICK, DONE]));
    const notice2 = host2.notices.find((entry) => entry.message.includes("profiles:"));
    expect(notice2?.message).toContain("fusion-worker: current @ /a/fusion-worker.md");
  });

  it("back out of a sub-editor persists nothing", async () => {
    const host = makeDeps();
    const approval = labelFor(host.config(), "approval");
    await interactiveFusionConfig(host.deps, scriptedDialogs([GLOBAL_PICK, approval, BACK, DONE]));
    expect(host.persisted()).toBe(0);
    expect(host.config().requireApproval).toBe(FUSION_CONFIG_DEFAULTS.requireApproval);
  });

  it("several edits in one session stack", async () => {
    const host = makeDeps();
    const workers = labelFor(host.config(), "workers");
    const maxSteps = labelFor(host.config(), "maxSteps");
    const timeout = labelFor(host.config(), "taskTimeoutMs");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([GLOBAL_PICK, workers, maxSteps, timeout, DONE], ["5", "42", "120000"]),
    );
    expect(host.config().workers).toBe(5);
    expect(host.config().maxSteps).toBe(42);
    expect(host.config().taskTimeoutMs).toBe(120_000);
    expect(host.persisted()).toBe(3);
  });
});

describe("interactiveFusionConfig: layer switcher (openspec fusion-project-config, D5)", () => {
  it("is shown on entry, local option noting the missing file; global is the suggestion", async () => {
    const host = makeDeps();
    const dialogs = scriptedDialogs([GLOBAL_PICK, DONE]);
    await interactiveFusionConfig(host.deps, dialogs);
    expect(dialogs.selects[0]).toEqual([GLOBAL_PICK, LOCAL_MISSING]);
  });

  it("the default layer is local iff the project file exists (local listed first, noting the file)", async () => {
    const host = makeDeps({ workers: 4 }, { workers: 8 });
    const dialogs = scriptedDialogs([LOCAL_EXISTS, DONE]);
    await interactiveFusionConfig(host.deps, dialogs);
    expect(dialogs.selects[0]).toEqual([LOCAL_EXISTS, GLOBAL_PICK]);
    // The local layer opened: its rows carry origin tags.
    expect(dialogs.selects[1]?.some((row) => row.endsWith(" [local]"))).toBe(true);
  });

  it("switching layers writes nothing and creates no file", async () => {
    const host = makeDeps();
    const dialogs = scriptedDialogs([
      GLOBAL_PICK, // enter global
      SWITCH, // ↩️ Слой / Layer
      LOCAL_MISSING, // flip to local (file absent)
      SWITCH, // back to the switcher
      GLOBAL_PICK, // flip to global
      DONE,
    ]);
    await interactiveFusionConfig(host.deps, dialogs);
    // Returning from a layer puts the other layer first.
    expect(dialogs.selects[2]).toEqual([LOCAL_MISSING, GLOBAL_PICK]);
    expect(dialogs.selects[4]).toEqual([GLOBAL_PICK, LOCAL_MISSING]);
    expect(host.persisted()).toBe(0);
    expect(host.projectWrites()).toBe(0);
    expect(host.projectExists()).toBe(false);
    expect(host.globalRaw()).toBeNull();
  });

  it("flipping an existing local layer to global and back leaves both files byte-identical", async () => {
    const host = makeDeps({ workers: 4 }, { workers: 8 });
    const before = readFileSync(host.projectPath, "utf8");
    const beforeGlobal = readFileSync(host.globalPath, "utf8");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([LOCAL_EXISTS, SWITCH, GLOBAL_PICK, SWITCH, LOCAL_EXISTS, DONE]),
    );
    expect(readFileSync(host.projectPath, "utf8")).toBe(before);
    expect(readFileSync(host.globalPath, "utf8")).toBe(beforeGlobal);
  });
});

describe("interactiveFusionConfig: local mode (origins, delta writes, confirm, reset)", () => {
  it("shows each field's effective value with its origin suffix", async () => {
    const host = makeDeps({ maxSteps: 90 }, { workers: 8 });
    const dialogs = scriptedDialogs([LOCAL_EXISTS, DONE]);
    await interactiveFusionConfig(host.deps, dialogs);
    const rows = dialogs.selects[1] ?? [];
    const effective = host.effective();
    const origins = host.origins();
    expect(rows).toContain(labelFor(effective, "workers", origins));
    expect(rows).toContain(labelFor(effective, "maxSteps", origins));
    expect(rows).toContain(labelFor(effective, "taskTimeoutMs", origins));
    expect(labelFor(effective, "workers", origins).endsWith(" [local]")).toBe(true);
    expect(labelFor(effective, "maxSteps", origins).endsWith(" [global]")).toBe(true);
    expect(labelFor(effective, "taskTimeoutMs", origins).endsWith(" [default]")).toBe(true);
    // Only the locally overridden field offers a reset row.
    expect(rows).toContain(resetRowLabel("workers"));
    expect(rows).not.toContain(resetRowLabel("maxSteps"));
  });

  it("editing a local-origin field writes the delta immediately, only that key", async () => {
    const host = makeDeps({ maxSteps: 90 }, { workers: 8 });
    const workers = labelFor(host.effective(), "workers", host.origins());
    const dialogs = scriptedDialogs([LOCAL_EXISTS, workers, DONE], ["4"]);
    await interactiveFusionConfig(host.deps, dialogs);
    expect(host.projectRaw()).toEqual({ workers: 4 });
    expect(host.projectWrites()).toBe(1);
    expect(dialogs.confirms).toEqual([]);
    expect(host.persisted()).toBe(0);
    // The global file is untouched by a local edit.
    expect(host.globalRaw()).toEqual({ maxSteps: 90 });
  });

  it("editing an inherited field needs a confirm; decline changes nothing", async () => {
    const host = makeDeps({ maxSteps: 90 }, { workers: 8 });
    const maxSteps = labelFor(host.effective(), "maxSteps", host.origins());
    const dialogs = scriptedDialogs([LOCAL_EXISTS, maxSteps, DONE], ["120"], [false]);
    await interactiveFusionConfig(host.deps, dialogs);
    expect(dialogs.confirms).toHaveLength(1);
    expect(dialogs.confirms[0]).toContain("maxSteps");
    expect(host.projectRaw()).toEqual({ workers: 8 });
    expect(host.projectWrites()).toBe(0);
    expect(host.errors()).toEqual([]);
  });

  it("confirming an inherited field's override writes only that key into the project file", async () => {
    const host = makeDeps({ maxSteps: 90 }, { workers: 8 });
    const maxSteps = labelFor(host.effective(), "maxSteps", host.origins());
    const dialogs = scriptedDialogs([LOCAL_EXISTS, maxSteps, DONE], ["120"], [true]);
    await interactiveFusionConfig(host.deps, dialogs);
    expect(host.projectRaw()).toEqual({ workers: 8, maxSteps: 120 });
    expect(host.globalRaw()).toEqual({ maxSteps: 90 });
  });

  it("reset removes the key and keeps the other overrides", async () => {
    const host = makeDeps({ maxSteps: 90 }, { workers: 8, taskTimeoutMs: 300_000 });
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([LOCAL_EXISTS, resetRowLabel("workers"), DONE]),
    );
    expect(host.projectRaw()).toEqual({ taskTimeoutMs: 300_000 });
    expect(host.projectExists()).toBe(true);
  });

  it("resetting the last override deletes the emptied project file (2.1 contract)", async () => {
    const host = makeDeps({ maxSteps: 90 }, { workers: 8 });
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([LOCAL_EXISTS, resetRowLabel("workers"), DONE]),
    );
    expect(host.projectExists()).toBe(false);
    expect(host.errors()).toEqual([]);
  });

  it("the local layer shows a reset row for approval as requireApproval", async () => {
    const host = makeDeps({}, { requireApproval: false });
    const dialogs = scriptedDialogs([LOCAL_EXISTS, DONE]);
    await interactiveFusionConfig(host.deps, dialogs);
    expect(dialogs.selects[1]).toContain(resetRowLabel("approval"));
    expect(resetRowLabel("approval")).toContain("requireApproval");
  });
});

describe("interactiveFusionConfig: refused writes to a broken project file", () => {
  it.each([
    ["invalid JSON", "{ not json"],
    ["a JSON array", "[]"],
  ])("refuses an inherited-field override on %s; the file stays untouched", async (_name, raw) => {
    const host = makeDeps({ maxSteps: 90 }, raw);
    const maxSteps = labelFor(host.effective(), "maxSteps", host.origins());
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([LOCAL_EXISTS, maxSteps, DONE], ["120"], [true]),
    );
    expect(host.errors()).toHaveLength(1);
    expect(host.errors()[0]?.message).toContain("cannot write project config");
    expect(host.errors()[0]?.message).toContain(host.projectPath);
    expect(readFileSync(host.projectPath, "utf8")).toBe(raw);
    expect(host.globalRaw()).toEqual({ maxSteps: 90 });
  });

  it("refuses a local delta write on a broken file and leaves it byte-identical", async () => {
    const raw = "{ broken";
    const host = makeDeps({}, raw);
    const workers = labelFor(host.effective(), "workers", host.origins());
    // workers is inherited (default): the override needs its confirm first.
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([LOCAL_EXISTS, workers, DONE], ["4"], [true]),
    );
    expect(host.errors()).toHaveLength(1);
    expect(readFileSync(host.projectPath, "utf8")).toBe(raw);
  });
});

describe("interactiveFusionConfig: global mode", () => {
  it("persists full snapshots through persistGlobal and never touches the project file", async () => {
    const host = makeDeps({ workers: 3 }, { workers: 8 });
    // Enter local, flip to global through the switcher, then edit maxSteps there.
    const dialogs = scriptedDialogs(
      [LOCAL_EXISTS, SWITCH, GLOBAL_PICK, labelFor(host.config(), "maxSteps"), DONE],
      ["120"],
    );
    await interactiveFusionConfig(host.deps, dialogs);
    // The global file now holds a complete canonical snapshot.
    const raw = host.globalRaw() ?? {};
    expect(Object.keys(raw).sort()).toEqual(Object.keys(FUSION_CONFIG_DEFAULTS).sort());
    expect(raw.maxSteps).toBe(120);
    expect(host.persisted()).toBe(1);
    expect(host.projectWrites()).toBe(0);
    expect(host.projectRaw()).toEqual({ workers: 8 });
    // Global rows carry no origin tag (selects[3] is the global menu).
    expect(dialogs.selects[3]?.some((row) => /\[(local|global|default)\]$/.test(row))).toBe(false);
  });

  it("the alias fields are gone from the deps (loadConfig/persistConfig)", () => {
    const host = makeDeps();
    expect("loadConfig" in host.deps).toBe(false);
    expect("persistConfig" in host.deps).toBe(false);
  });
});
