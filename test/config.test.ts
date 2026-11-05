import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProjectFusionOverride,
  defaultFusionConfigPath,
  FUSION_CONFIG_BOUNDS,
  FUSION_CONFIG_DEFAULTS,
  type FusionConfig,
  loadEffectiveConfig,
  loadFusionConfig,
  persistFusionConfig,
  persistProjectFusionDelta,
  projectFusionConfigPath,
} from "../extensions/pi-fusion/config.ts";
import { COOLDOWN_CLAMP_MS } from "../extensions/pi-fusion/pool/fanout.ts";

const renameState = vi.hoisted(() => ({ fail: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1],
    ) => {
      if (renameState.fail) {
        renameState.fail = false;
        throw new Error("disk gone");
      }
      return actual.renameSync(oldPath, newPath);
    },
  };
});

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const CUSTOM: FusionConfig = {
  workers: 5,
  maxParallel: 4,
  taskTimeoutMs: 120_000,
  // openspec fusion-model-cooldown, design D5: a valid in-bounds cooldown.
  modelCooldownMs: 90_000,
  workerModels: ["vendor/a", "vendor/b"],
  maxSteps: 25,
  requireApproval: false,
  blockedTools: ["tool-x"],
  leadBlockedTools: ["tool-y"],
  researcherWeb: "web",
};

describe("config: fusion.json load/persist", () => {
  let dir = "";
  let savedEnv: Partial<Record<EnvKey, string>> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-config-"));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    renameState.fail = false;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: string): string => {
    const path = join(dir, "fusion.json");
    writeFileSync(path, content, "utf8");
    return path;
  };

  const lastWarn = (): string => {
    const calls = vi.mocked(console.warn).mock.calls;
    return String(calls[calls.length - 1]?.[0]);
  };

  describe("defaultFusionConfigPath", () => {
    it("resolves the path from PI_CODING_AGENT_DIR", () => {
      process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
      expect(defaultFusionConfigPath()).toBe(join(dir, "agent", "fusion.json"));
    });

    it("expands ~ in PI_CODING_AGENT_DIR against the user home", () => {
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      process.env.PI_CODING_AGENT_DIR = "~";
      expect(defaultFusionConfigPath()).toBe(join(dir, "fusion.json"));
      process.env.PI_CODING_AGENT_DIR = "~/sub";
      expect(defaultFusionConfigPath()).toBe(join(dir, "sub", "fusion.json"));
    });

    it("falls back to ~/.pi/agent/fusion.json without the env var", () => {
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      delete process.env.PI_CODING_AGENT_DIR;
      expect(defaultFusionConfigPath()).toBe(join(dir, ".pi", "agent", "fusion.json"));
    });
  });

  describe("loadFusionConfig", () => {
    it("silently uses the design defaults when the file is absent", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = join(dir, "missing.json");
      expect(loadFusionConfig(path)).toEqual({
        workers: 3,
        maxParallel: 3,
        taskTimeoutMs: 600_000,
        modelCooldownMs: 300_000,
        workerModels: [],
        maxSteps: 60,
        requireApproval: true,
        blockedTools: ["fusion_delegate", "subagent", "codemode"],
        leadBlockedTools: ["write", "edit", "bash", "powershell", "subagent"],
        researcherWeb: "none",
      });
      expect(loadFusionConfig(path)).toEqual(FUSION_CONFIG_DEFAULTS);
      expect(warn).not.toHaveBeenCalled();
    });

    it("warns and uses the defaults for invalid JSON", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = write("{ not json");
      expect(loadFusionConfig(path)).toEqual(FUSION_CONFIG_DEFAULTS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(lastWarn()).toContain("not valid JSON");
    });

    it("warns and uses the defaults when the file is unreadable", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = join(dir, "fusion.json");
      mkdirSync(path);
      expect(loadFusionConfig(path)).toEqual(FUSION_CONFIG_DEFAULTS);
      expect(lastWarn()).toContain("unreadable");
    });

    it("warns and uses the defaults when the document is not an object", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = write("[]");
      expect(loadFusionConfig(path)).toEqual(FUSION_CONFIG_DEFAULTS);
      expect(lastWarn()).toContain("not a JSON object");
    });

    it("reads every field from fusion.json", () => {
      expect(loadFusionConfig(write(JSON.stringify(CUSTOM)))).toEqual(CUSTOM);
    });

    it("keeps the default for an ill-typed field while reading the rest", () => {
      const path = write(
        JSON.stringify({
          ...CUSTOM,
          workers: 7,
          maxParallel: 99,
          workerModels: ["m", ""],
        }),
      );
      expect(loadFusionConfig(path)).toEqual({
        ...CUSTOM,
        workers: 7,
        maxParallel: FUSION_CONFIG_DEFAULTS.maxParallel,
        workerModels: FUSION_CONFIG_DEFAULTS.workerModels,
      });
    });

    it.each([
      ["workers", 0],
      ["workers", 2.5],
      ["maxParallel", 0],
      ["maxParallel", 9],
      ["taskTimeoutMs", 29_999],
      ["taskTimeoutMs", 3_600_001],
      ["modelCooldownMs", 1_000],
      ["modelCooldownMs", 4_000_000],
      ["maxSteps", 0],
      ["maxSteps", 10_001],
      ["requireApproval", 1],
      ["workerModels", "m"],
      ["workerModels", ["m", ""]],
      ["blockedTools", [42]],
    ] as const)("falls back to the default for %s = %p", (key, value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const loaded = loadFusionConfig(write(JSON.stringify({ [key]: value })));
      expect(loaded).toEqual(FUSION_CONFIG_DEFAULTS);
      expect(lastWarn()).toContain(key);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["workers", 1],
      ["maxParallel", 1],
      ["maxParallel", 8],
      ["taskTimeoutMs", 30_000],
      ["taskTimeoutMs", 3_600_000],
      ["modelCooldownMs", 30_000],
      ["modelCooldownMs", 3_600_000],
      ["maxSteps", 1],
      ["maxSteps", 10_000],
    ] as const)("accepts boundary values %s = %p", (key, value) => {
      const loaded = loadFusionConfig(write(JSON.stringify({ [key]: value })));
      expect(loaded[key]).toBe(value);
    });

    it("the default lead block list includes subagent (fusion-lead-subagent-block, design §1)", () => {
      expect(FUSION_CONFIG_DEFAULTS.leadBlockedTools).toEqual([
        "write",
        "edit",
        "bash",
        "powershell",
        "subagent",
      ]);
      expect(loadFusionConfig(join(dir, "missing.json")).leadBlockedTools).toContain("subagent");
    });

    it("an explicit leadBlockedTools without subagent is kept as written: the list replaces the default", () => {
      const explicit = ["write", "edit", "bash", "powershell"];
      const loaded = loadFusionConfig(write(JSON.stringify({ leadBlockedTools: explicit })));
      expect([...loaded.leadBlockedTools]).toEqual(explicit);
      expect(loaded.leadBlockedTools).not.toContain("subagent");
    });

    it("accepts an empty tool list to block nothing", () => {
      const loaded = loadFusionConfig(
        write(JSON.stringify({ blockedTools: [], leadBlockedTools: [] })),
      );
      expect(loaded).toEqual({ ...FUSION_CONFIG_DEFAULTS, blockedTools: [], leadBlockedTools: [] });
    });

    it("returns a frozen snapshot that does not share arrays with the defaults", () => {
      const loaded = loadFusionConfig(join(dir, "missing.json"));
      expect(Object.isFrozen(loaded)).toBe(true);
      expect(Object.isFrozen(loaded.workerModels)).toBe(true);
      expect(Object.isFrozen(FUSION_CONFIG_DEFAULTS.blockedTools)).toBe(true);
      expect(() => loaded.blockedTools.push("sneak")).toThrow();
      expect(FUSION_CONFIG_DEFAULTS.blockedTools).toEqual([
        "fusion_delegate",
        "subagent",
        "codemode",
      ]);
    });
  });

  describe("retired enabled field", () => {
    it("warns once per process, ignores the value and never rewrites the file", async () => {
      // Fresh module instance: the once-per-process flag is module state.
      vi.resetModules();
      const fresh = await import("../extensions/pi-fusion/config.ts");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const original = JSON.stringify({ ...CUSTOM, enabled: true }, null, 2);
      const path = write(original);
      const first = fresh.loadFusionConfig(path);
      fresh.loadFusionConfig(path);
      fresh.loadFusionConfig(path);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toBe(
        `[pi-fusion] ${path}: field "enabled" is retired and ignored; fusion is switched per session with /fusion on|off`,
      );
      expect(first).not.toHaveProperty("enabled");
      expect(first).toEqual(CUSTOM);
      expect(readFileSync(path, "utf8")).toBe(original);
    });

    it("stays silent for files that carry no enabled field", async () => {
      vi.resetModules();
      const fresh = await import("../extensions/pi-fusion/config.ts");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fresh.loadFusionConfig(write(JSON.stringify(CUSTOM)));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("persistFusionConfig", () => {
    it("round-trips load -> persist -> load", () => {
      const path = join(dir, "fusion.json");
      persistFusionConfig(CUSTOM, path);
      expect(loadFusionConfig(path)).toEqual(CUSTOM);
    });

    it("modelCooldownMs survives the persist round trip (design D5)", () => {
      const path = join(dir, "fusion.json");
      persistFusionConfig({ ...FUSION_CONFIG_DEFAULTS, modelCooldownMs: 45_000 }, path);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(onDisk.modelCooldownMs).toBe(45_000);
      expect(loadFusionConfig(path).modelCooldownMs).toBe(45_000);
    });

    it("the pool's cooldown clamp stays equal to the config bounds (no drift)", () => {
      expect(COOLDOWN_CLAMP_MS).toEqual(FUSION_CONFIG_BOUNDS.modelCooldownMs);
    });

    it("replaces the previous file wholesale and leaves no temporary files", () => {
      const path = join(dir, "fusion.json");
      persistFusionConfig(CUSTOM, path);
      const second: FusionConfig = { ...CUSTOM, workers: 2 };
      persistFusionConfig(second, path);
      expect(loadFusionConfig(path)).toEqual(second);
      expect(readdirSync(dir)).toEqual(["fusion.json"]);
    });

    it("writes the full canonical document with every field", () => {
      const path = join(dir, "fusion.json");
      persistFusionConfig({ ...CUSTOM, workerModels: [], blockedTools: [] }, path);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(Object.keys(onDisk).sort()).toEqual([
        "blockedTools",
        "leadBlockedTools",
        "maxParallel",
        "maxSteps",
        "modelCooldownMs",
        "requireApproval",
        "researcherWeb",
        "taskTimeoutMs",
        "workerModels",
        "workers",
      ]);
    });

    it("never writes enabled, even when handed a legacy object that carries it", () => {
      const path = join(dir, "fusion.json");
      persistFusionConfig({ ...CUSTOM, enabled: true } as FusionConfig, path);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(onDisk).not.toHaveProperty("enabled");
    });

    it("creates missing agent directories", () => {
      const path = join(dir, "nested", "agent", "fusion.json");
      persistFusionConfig(FUSION_CONFIG_DEFAULTS, path);
      expect(loadFusionConfig(path)).toEqual(FUSION_CONFIG_DEFAULTS);
    });

    it("keeps the previous file intact and removes the temp file when the rename fails", () => {
      const path = write(JSON.stringify({ workers: 9 }));
      renameState.fail = true;
      expect(() => persistFusionConfig(FUSION_CONFIG_DEFAULTS, path)).toThrow("disk gone");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ workers: 9 });
      expect(readdirSync(dir)).toEqual(["fusion.json"]);
    });
  });
});

describe("config: layered project overrides (.pi/fusion.json)", () => {
  let dir = "";
  let globalPath = "";
  let projectDir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-layers-"));
    globalPath = join(dir, "global", "fusion.json");
    projectDir = join(dir, "project");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    renameState.fail = false;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const writeGlobal = (document: unknown): void => {
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, JSON.stringify(document), "utf8");
  };
  const localPath = (): string => join(projectDir, ".pi", "fusion.json");
  const writeLocal = (content: string): void => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(localPath(), content, "utf8");
  };
  const readLocal = (): Record<string, unknown> =>
    JSON.parse(readFileSync(localPath(), "utf8")) as Record<string, unknown>;
  const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
  const warnings = (): string[] =>
    vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));

  describe("projectFusionConfigPath", () => {
    it("joins the project directory with .pi/fusion.json", () => {
      expect(projectFusionConfigPath(projectDir)).toBe(join(projectDir, ".pi", "fusion.json"));
    });
  });

  describe("loadEffectiveConfig", () => {
    it("without a project file the result equals the global layer, silently", () => {
      const warn = quietWarn();
      writeGlobal({ workers: 4, workerModels: ["vendor/a"] });
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config).toEqual(loadFusionConfig(globalPath));
      expect(config.workers).toBe(4);
      expect(origins.workers).toBe("global");
      expect(origins.maxSteps).toBe("default");
      expect(warn).not.toHaveBeenCalled();
    });

    it("with neither file every field is the design default and origin default", () => {
      const warn = quietWarn();
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config).toEqual(FUSION_CONFIG_DEFAULTS);
      expect(Object.keys(origins).sort()).toEqual(Object.keys(FUSION_CONFIG_DEFAULTS).sort());
      expect(Object.values(origins).every((origin) => origin === "default")).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it("a valid project file overrides its field and the rest comes from global", () => {
      quietWarn();
      writeGlobal({ workers: 4, maxSteps: 30 });
      writeLocal(JSON.stringify({ workers: 8 }));
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config.workers).toBe(8);
      expect(config.maxSteps).toBe(30);
      expect(config.requireApproval).toBe(FUSION_CONFIG_DEFAULTS.requireApproval);
      expect(origins.workers).toBe("local");
      expect(origins.maxSteps).toBe("global");
      expect(origins.requireApproval).toBe("default");
    });

    it("a partial project file that sets only taskTimeoutMs keeps every other global field", () => {
      quietWarn();
      writeGlobal({ workers: 4, workerModels: ["vendor/a"], maxSteps: 30 });
      writeLocal(JSON.stringify({ taskTimeoutMs: 120_000 }));
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config).toEqual({
        ...loadFusionConfig(globalPath),
        taskTimeoutMs: 120_000,
      });
      expect(origins.taskTimeoutMs).toBe("local");
      expect(origins.workers).toBe("global");
    });

    it("modelCooldownMs takes every layer and reports its origin (fusion-model-cooldown D5)", () => {
      quietWarn();
      writeGlobal({ modelCooldownMs: 120_000 });
      expect(loadEffectiveConfig(globalPath, projectDir).origins.modelCooldownMs).toBe("global");

      writeLocal(JSON.stringify({ modelCooldownMs: 60_000 }));
      const local = loadEffectiveConfig(globalPath, projectDir);
      expect(local.config.modelCooldownMs).toBe(60_000);
      expect(local.origins.modelCooldownMs).toBe("local");

      writeLocal(JSON.stringify({ modelCooldownMs: "5m" }));
      const invalid = loadEffectiveConfig(globalPath, projectDir);
      expect(invalid.config.modelCooldownMs).toBe(120_000);
      expect(invalid.origins.modelCooldownMs).toBe("global");
    });

    it("a local model list replaces the global one without merging", () => {
      quietWarn();
      writeGlobal({ workerModels: ["vendor/a", "vendor/b"] });
      writeLocal(JSON.stringify({ workerModels: ["vendor/c"] }));
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect([...config.workerModels]).toEqual(["vendor/c"]);
      expect(origins.workerModels).toBe("local");
    });

    it("a local leadBlockedTools list replaces the global one, not extends it", () => {
      quietWarn();
      writeGlobal({ leadBlockedTools: ["write", "edit", "bash", "subagent"] });
      writeLocal(JSON.stringify({ leadBlockedTools: ["write", "edit"] }));
      const { config } = loadEffectiveConfig(globalPath, projectDir);
      expect([...config.leadBlockedTools]).toEqual(["write", "edit"]);
    });

    it("an explicit empty list in the project file is a valid override", () => {
      const warn = quietWarn();
      writeGlobal({ workerModels: ["vendor/a"] });
      writeLocal(JSON.stringify({ workerModels: [], leadBlockedTools: [] }));
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect([...config.workerModels]).toEqual([]);
      expect([...config.leadBlockedTools]).toEqual([]);
      expect(origins.workerModels).toBe("local");
      expect(origins.leadBlockedTools).toBe("local");
      expect(warn).not.toHaveBeenCalled();
    });

    it("an invalid project field inherits and warns while other local fields still apply", () => {
      const warn = quietWarn();
      writeGlobal({ workers: 4 });
      writeLocal(JSON.stringify({ workers: 0, maxSteps: 7 }));
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config.workers).toBe(4);
      expect(origins.workers).toBe("global");
      expect(config.maxSteps).toBe(7);
      expect(origins.maxSteps).toBe("local");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warnings()[0]).toContain(localPath());
      expect(warnings()[0]).toContain('"workers"');
    });

    it("an invalid project field with no global value falls back to the default", () => {
      quietWarn();
      writeLocal(JSON.stringify({ requireApproval: "no" }));
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config.requireApproval).toBe(FUSION_CONFIG_DEFAULTS.requireApproval);
      expect(origins.requireApproval).toBe("default");
    });

    it("a broken project JSON is ignored as a whole, with one warning naming the path", () => {
      const warn = quietWarn();
      writeGlobal({ workers: 4 });
      writeLocal("{ not json");
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config).toEqual(loadFusionConfig(globalPath));
      expect(origins.workers).toBe("global");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warnings()[0]).toContain(localPath());
      expect(warnings()[0]).toContain("not valid JSON");
    });

    it.each([
      ["[]", "array"],
      ["null", "null"],
      ['"x"', "string"],
      ["42", "number"],
    ])(
      "a project document that is a %s (%s) is ignored as a whole, with one warning",
      (content) => {
        const warn = quietWarn();
        writeGlobal({ workers: 4 });
        writeLocal(content);
        const { config } = loadEffectiveConfig(globalPath, projectDir);
        expect(config).toEqual(loadFusionConfig(globalPath));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warnings()[0]).toContain("not a JSON object");
      },
    );

    it("an enabled key in the project file is retired: one warning, ignored", async () => {
      // Fresh module instance: the once-per-process retired flag is module state.
      vi.resetModules();
      const fresh = await import("../extensions/pi-fusion/config.ts");
      const warn = quietWarn();
      writeLocal(JSON.stringify({ enabled: false, workers: 6 }));
      const first = fresh.loadEffectiveConfig(globalPath, projectDir);
      fresh.loadEffectiveConfig(globalPath, projectDir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warnings()[0]).toContain('field "enabled" is retired');
      expect(first.config).not.toHaveProperty("enabled");
      expect(first.origins).not.toHaveProperty("enabled");
      expect(first.config.workers).toBe(6);
    });

    it("a project value equal to the global one is still reported as local", () => {
      quietWarn();
      writeGlobal({ workers: 4 });
      writeLocal(JSON.stringify({ workers: 4 }));
      expect(loadEffectiveConfig(globalPath, projectDir).origins.workers).toBe("local");
    });

    it("distinguishes a valid global value from a default, and an invalid global falls back to default", () => {
      const warn = quietWarn();
      writeGlobal({ workers: 4 });
      const valid = loadEffectiveConfig(globalPath, projectDir);
      expect(valid.origins.workers).toBe("global");
      expect(valid.origins.maxParallel).toBe("default");

      writeGlobal({ workers: 0 });
      const invalid = loadEffectiveConfig(globalPath, projectDir);
      expect(invalid.config.workers).toBe(FUSION_CONFIG_DEFAULTS.workers);
      expect(invalid.origins.workers).toBe("default");
      expect(warn).toHaveBeenCalled();
    });

    it("loadFusionConfig keeps today's behaviour: per-field warn, default kept, same bounds", () => {
      const warn = quietWarn();
      writeGlobal({ workers: 0, maxSteps: 12 });
      const loaded = loadFusionConfig(globalPath);
      expect(loaded.workers).toBe(FUSION_CONFIG_DEFAULTS.workers);
      expect(loaded.maxSteps).toBe(12);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warnings()[0]).toBe(
        `[pi-fusion] ${globalPath}: field "workers" has an invalid value, keeping the default`,
      );
    });
  });

  describe("warn once per path (review major 2)", () => {
    // The config is read on every tool call and every /fusion status; a broken
    // file must not repeat its warning each time (once per process, per path).
    it("a broken project file warns once across repeated effective loads", async () => {
      vi.resetModules();
      const fresh = await import("../extensions/pi-fusion/config.ts");
      quietWarn();
      writeGlobal({ workers: 4 });
      writeLocal("{ not json");
      fresh.loadEffectiveConfig(globalPath, projectDir);
      fresh.loadEffectiveConfig(globalPath, projectDir);
      fresh.loadEffectiveConfig(globalPath, projectDir);
      expect(warnings().filter((text) => text.includes(localPath()))).toHaveLength(1);
    });

    it("a second broken project file in another directory still warns once", async () => {
      vi.resetModules();
      const fresh = await import("../extensions/pi-fusion/config.ts");
      quietWarn();
      const otherDir = join(dir, "other-project");
      mkdirSync(join(otherDir, ".pi"), { recursive: true });
      writeFileSync(join(otherDir, ".pi", "fusion.json"), "[]", "utf8");
      writeLocal("{ not json");
      for (let i = 0; i < 2; i++) {
        fresh.loadEffectiveConfig(globalPath, projectDir);
        fresh.loadEffectiveConfig(globalPath, otherDir);
      }
      expect(warnings().filter((text) => text.includes(localPath()))).toHaveLength(1);
      expect(
        warnings().filter((text) => text.includes(join(otherDir, ".pi", "fusion.json"))),
      ).toHaveLength(1);
    });

    it("a broken global file warns once across repeated loads", async () => {
      vi.resetModules();
      const fresh = await import("../extensions/pi-fusion/config.ts");
      quietWarn();
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(globalPath, "{ not json", "utf8");
      fresh.loadEffectiveConfig(globalPath, projectDir);
      fresh.loadFusionConfig(globalPath);
      fresh.loadEffectiveConfig(globalPath, projectDir);
      expect(warnings().filter((text) => text.includes(globalPath))).toHaveLength(1);
    });

    it("an invalid field value warns once across repeated effective loads", async () => {
      vi.resetModules();
      const fresh = await import("../extensions/pi-fusion/config.ts");
      quietWarn();
      writeLocal(JSON.stringify({ workers: 0 }));
      fresh.loadEffectiveConfig(globalPath, projectDir);
      fresh.loadEffectiveConfig(globalPath, projectDir);
      expect(warnings().filter((text) => text.includes('"workers"'))).toHaveLength(1);
    });
  });

  describe("persistProjectFusionDelta", () => {
    it("creates the project file with only the delta keys when it is absent", () => {
      persistProjectFusionDelta({ workers: 8 }, projectDir);
      expect(readLocal()).toEqual({ workers: 8 });
    });

    it("modelCooldownMs written as a project delta reads back with local origin", () => {
      quietWarn();
      writeGlobal({ modelCooldownMs: 120_000 });
      persistProjectFusionDelta({ modelCooldownMs: 90_000 }, projectDir);
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(readLocal()).toEqual({ modelCooldownMs: 90_000 });
      expect(config.modelCooldownMs).toBe(90_000);
      expect(origins.modelCooldownMs).toBe("local");
    });

    it("merges only the delta keys and preserves unknown keys", () => {
      writeLocal(JSON.stringify({ workers: 2, note: "keep", nested: { a: 1 } }));
      persistProjectFusionDelta({ maxSteps: 10, workers: 8 }, projectDir);
      expect(readLocal()).toEqual({ workers: 8, note: "keep", nested: { a: 1 }, maxSteps: 10 });
    });

    it("writes an explicit empty list as a value", () => {
      writeLocal(JSON.stringify({ workers: 2 }));
      persistProjectFusionDelta({ workerModels: [] }, projectDir);
      expect(readLocal()).toEqual({ workers: 2, workerModels: [] });
    });

    it("skips undefined delta values instead of deleting or writing them", () => {
      writeLocal(JSON.stringify({ workers: 2 }));
      persistProjectFusionDelta({ workers: undefined, maxSteps: 5 }, projectDir);
      expect(readLocal()).toEqual({ workers: 2, maxSteps: 5 });
    });

    it.each([
      ["{ not json", "not valid JSON"],
      ["[]", "not a JSON object"],
      ["null", "not a JSON object"],
      ['"x"', "not a JSON object"],
    ])(
      "refuses to write over a project file that is %s, naming path and reason",
      (content, reason) => {
        writeLocal(content);
        expect(() => persistProjectFusionDelta({ workers: 8 }, projectDir)).toThrow(localPath());
        expect(() => persistProjectFusionDelta({ workers: 8 }, projectDir)).toThrow(reason);
        expect(readFileSync(localPath(), "utf8")).toBe(content);
        expect(readdirSync(join(projectDir, ".pi"))).toEqual(["fusion.json"]);
      },
    );
  });

  describe("clearProjectFusionOverride", () => {
    it("removes only the given key", () => {
      writeLocal(JSON.stringify({ workers: 8, note: "keep" }));
      clearProjectFusionOverride("workers", projectDir);
      expect(readLocal()).toEqual({ note: "keep" });
    });

    it("deletes the file when no keys are left", () => {
      writeLocal(JSON.stringify({ workers: 8 }));
      clearProjectFusionOverride("workers", projectDir);
      expect(existsSync(localPath())).toBe(false);
    });

    it("never leaves an empty object: the file survives while unknown keys remain", () => {
      writeLocal(JSON.stringify({ unknown: true, workers: 8, maxSteps: 9 }));
      clearProjectFusionOverride("workers", projectDir);
      clearProjectFusionOverride("maxSteps", projectDir);
      expect(readLocal()).toEqual({ unknown: true });
      clearProjectFusionOverride("unknown" as keyof FusionConfig, projectDir);
      expect(existsSync(localPath())).toBe(false);
    });

    it("is a no-op for an absent file or an absent key, leaving bytes untouched", () => {
      clearProjectFusionOverride("workers", projectDir);
      expect(existsSync(localPath())).toBe(false);
      const content = JSON.stringify({ note: "keep" }, null, 4);
      writeLocal(content);
      clearProjectFusionOverride("workers", projectDir);
      expect(readFileSync(localPath(), "utf8")).toBe(content);
    });

    it.each([
      ["{ not json", "not valid JSON"],
      ["[]", "not a JSON object"],
      ['"x"', "not a JSON object"],
    ])("refuses to clear a project file that is %s, naming path and reason", (content, reason) => {
      writeLocal(content);
      expect(() => clearProjectFusionOverride("workers", projectDir)).toThrow(localPath());
      expect(() => clearProjectFusionOverride("workers", projectDir)).toThrow(reason);
      expect(readFileSync(localPath(), "utf8")).toBe(content);
    });
  });

  describe("atomic project writes", () => {
    it("leaves no temporary files after a successful delta write or clear", () => {
      persistProjectFusionDelta({ workers: 8 }, projectDir);
      expect(readdirSync(join(projectDir, ".pi"))).toEqual(["fusion.json"]);
      persistProjectFusionDelta({ maxSteps: 9 }, projectDir);
      clearProjectFusionOverride("workers", projectDir);
      expect(readdirSync(join(projectDir, ".pi"))).toEqual(["fusion.json"]);
    });

    it("keeps the previous project file intact when the rename fails", () => {
      writeLocal(JSON.stringify({ workers: 2 }));
      renameState.fail = true;
      expect(() => persistProjectFusionDelta({ workers: 9 }, projectDir)).toThrow("disk gone");
      expect(readLocal()).toEqual({ workers: 2 });
      expect(readdirSync(join(projectDir, ".pi"))).toEqual(["fusion.json"]);
    });
  });

  describe("round trip through the effective config", () => {
    it("a delta written locally is read back with local origin", () => {
      quietWarn();
      writeGlobal({ workers: 4 });
      persistProjectFusionDelta({ workers: 8 }, projectDir);
      const { config, origins } = loadEffectiveConfig(globalPath, projectDir);
      expect(config.workers).toBe(8);
      expect(origins.workers).toBe("local");
    });
  });
});
