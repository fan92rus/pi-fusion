/**
 * /fusion config menu (config-ui.ts): the interactive loop is tested through
 * the same injected seam as the command — scripted dialogs answer each
 * select/input in order, and the assertions pin the persisted values and the
 * notices. Menu rows are picked through `fusionMenuItems` by id, so the
 * tests are locale-independent (the UI text itself follows the machine
 * locale, RU or EN, like pi-autoresearch's config menu).
 */

import { describe, expect, it } from "vitest";
import type { FusionCommandDeps, FusionUIDialogs } from "../extensions/pi-fusion/commands.ts";
import { FUSION_CONFIG_DEFAULTS, type FusionConfig } from "../extensions/pi-fusion/config.ts";
import {
  formatCurrent,
  fusionMenuItems,
  interactiveFusionConfig,
  MENU_ACTIONS,
  type MenuItemId,
} from "../extensions/pi-fusion/config-ui.ts";

/** Records every dependency call so a test asserts on the exact effect set. */
function makeDeps(config?: Partial<FusionConfig>) {
  let current: FusionConfig = { ...FUSION_CONFIG_DEFAULTS, ...config };
  let active: string[] = ["read", "bash"];
  const notices: Array<{ message: string; level: string }> = [];
  let persists = 0;
  const deps: FusionCommandDeps = {
    toolName: "fusion_delegate",
    loadConfig: () => ({ ...current }),
    persistConfig: (next) => {
      persists += 1;
      current = { ...next };
    },
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
    agentInstalled: () => false,
    installAgent: () => {},
    notify: (message, level = "info") => {
      notices.push({ message, level });
    },
    dialogs: null,
    interactiveConfig: async () => {},
  };
  return {
    deps,
    config: () => current,
    active: () => active,
    notices,
    persisted: () => persists,
    errors: () => notices.filter((n) => n.level === "error"),
  };
}

/** Dialogs that replay scripted answers: one shift per select/input call. */
function scriptedDialogs(
  select: (string | undefined)[],
  input: (string | undefined)[] = [],
): FusionUIDialogs {
  const selectQueue = [...select];
  const inputQueue = [...input];
  return {
    select: async () => selectQueue.shift(),
    input: async () => inputQueue.shift(),
    confirm: async () => true,
  };
}

/** The localized label of a menu row, resolved by id. */
function labelFor(config: FusionConfig, id: MenuItemId): string {
  const item = fusionMenuItems(config).find((entry) => entry.id === id);
  if (!item) throw new Error(`no menu item: ${id}`);
  return item.label;
}

/** The label of the loop-terminating "done" row (locale-correct). */
const DONE = MENU_ACTIONS.done;
const BACK = MENU_ACTIONS.back;

describe("interactiveFusionConfig", () => {
  it("immediate done changes nothing", async () => {
    const host = makeDeps();
    await interactiveFusionConfig(host.deps, scriptedDialogs([DONE]));
    expect(host.persisted()).toBe(0);
    expect(host.errors()).toEqual([]);
  });

  it("shows the current snapshot on open and on close", async () => {
    const host = makeDeps({ workers: 4 });
    await interactiveFusionConfig(host.deps, scriptedDialogs([DONE]));
    // The first notice is the snapshot; the last one reports the saved state.
    expect(host.notices[0]?.message).toContain(formatCurrent(host.config()));
    expect(host.notices.at(-1)?.message).toContain(formatCurrent(host.config()));
  });

  it("edits a number field within its bounds", async () => {
    const host = makeDeps();
    const workers = labelFor(host.config(), "workers");
    await interactiveFusionConfig(host.deps, scriptedDialogs([workers, DONE], ["4"]));
    expect(host.persisted()).toBe(1);
    expect(host.config().workers).toBe(4);
    expect(host.errors()).toEqual([]);
  });

  it("rejects a non-numeric value without persisting", async () => {
    const host = makeDeps();
    const workers = labelFor(host.config(), "workers");
    await interactiveFusionConfig(host.deps, scriptedDialogs([workers, DONE], ["abc"]));
    expect(host.persisted()).toBe(0);
    expect(host.errors()).toHaveLength(1);
  });

  it("rejects an out-of-bounds value without persisting", async () => {
    const host = makeDeps();
    const maxParallel = labelFor(host.config(), "maxParallel");
    await interactiveFusionConfig(host.deps, scriptedDialogs([maxParallel, DONE], ["99"]));
    expect(host.persisted()).toBe(0);
    expect(host.config().maxParallel).toBe(FUSION_CONFIG_DEFAULTS.maxParallel);
    expect(host.errors()).toHaveLength(1);
  });

  it("edits the task timeout", async () => {
    const host = makeDeps();
    const timeout = labelFor(host.config(), "taskTimeoutMs");
    await interactiveFusionConfig(host.deps, scriptedDialogs([timeout, DONE], ["300000"]));
    expect(host.config().taskTimeoutMs).toBe(300_000);
  });

  it("edits maxSteps", async () => {
    const host = makeDeps();
    const maxSteps = labelFor(host.config(), "maxSteps");
    await interactiveFusionConfig(host.deps, scriptedDialogs([maxSteps, DONE], ["120"]));
    expect(host.config().maxSteps).toBe(120);
  });

  it("parses a comma- and space-separated model rotation", async () => {
    const host = makeDeps();
    const models = labelFor(host.config(), "workerModels");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([models, DONE], ["vendor/alpha, vendor/beta   openai/gpt-6-luna"]),
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
    await interactiveFusionConfig(host.deps, scriptedDialogs([blocked, DONE], ["clear"]));
    expect(host.config().blockedTools).toEqual([]);
  });

  it("refuses a separator-only list without persisting (review fix)", async () => {
    // ", ," parses to zero entries and would silently empty the rotation;
    // the contract reserves `clear` for that, so the input must be refused.
    const host = makeDeps();
    const models = labelFor(host.config(), "workerModels");
    await interactiveFusionConfig(host.deps, scriptedDialogs([models, DONE], [", ,"]));
    expect(host.persisted()).toBe(0);
    expect(host.errors()).toHaveLength(1);
    expect(host.config().workerModels).toEqual(FUSION_CONFIG_DEFAULTS.workerModels);
  });

  it("blank input cancels an edit without persisting", async () => {
    const host = makeDeps();
    const models = labelFor(host.config(), "workerModels");
    await interactiveFusionConfig(host.deps, scriptedDialogs([models, DONE], [undefined]));
    expect(host.persisted()).toBe(0);
    expect(host.config().workerModels).toEqual(FUSION_CONFIG_DEFAULTS.workerModels);
  });

  it("flips fusion on through the subcommand path: tool in, agent installed", async () => {
    const host = makeDeps({ enabled: false });
    const enabled = labelFor(host.config(), "enabled");
    await interactiveFusionConfig(host.deps, scriptedDialogs([enabled, MENU_ACTIONS.turnOn, DONE]));
    expect(host.config().enabled).toBe(true);
    expect(host.active()).toContain("fusion_delegate");
    expect(host.persisted()).toBe(1);
  });

  it("keeps the mode unchanged when the same state is picked", async () => {
    const host = makeDeps({ enabled: false });
    const enabled = labelFor(host.config(), "enabled");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([enabled, MENU_ACTIONS.turnOff, DONE]),
    );
    expect(host.persisted()).toBe(0);
    expect(host.config().enabled).toBe(false);
  });

  it("toggles the approval requirement off", async () => {
    const host = makeDeps();
    const approval = labelFor(host.config(), "approval");
    await interactiveFusionConfig(
      host.deps,
      scriptedDialogs([approval, MENU_ACTIONS.approvalOptional, DONE]),
    );
    expect(host.config().requireApproval).toBe(false);
    expect(host.persisted()).toBe(1);
  });

  it("back out of a sub-editor persists nothing", async () => {
    const host = makeDeps();
    const approval = labelFor(host.config(), "approval");
    await interactiveFusionConfig(host.deps, scriptedDialogs([approval, BACK, DONE]));
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
      scriptedDialogs([workers, maxSteps, timeout, DONE], ["5", "42", "120000"]),
    );
    expect(host.config().workers).toBe(5);
    expect(host.config().maxSteps).toBe(42);
    expect(host.config().taskTimeoutMs).toBe(120_000);
    expect(host.persisted()).toBe(3);
  });
});
