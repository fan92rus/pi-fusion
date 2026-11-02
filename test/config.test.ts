import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultFusionConfigPath,
  FUSION_CONFIG_DEFAULTS,
  type FusionConfig,
  loadFusionConfig,
  persistFusionConfig,
} from "../extensions/pi-fusion/config.ts";

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
        workerModels: [],
        maxSteps: 60,
        requireApproval: true,
        blockedTools: ["fusion_delegate", "subagent", "codemode"],
        leadBlockedTools: ["write", "edit", "bash", "powershell"],
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
      ["maxSteps", 1],
      ["maxSteps", 10_000],
    ] as const)("accepts boundary values %s = %p", (key, value) => {
      const loaded = loadFusionConfig(write(JSON.stringify({ [key]: value })));
      expect(loaded[key]).toBe(value);
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
