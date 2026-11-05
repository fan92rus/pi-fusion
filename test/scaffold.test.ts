import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fusionExtension from "../extensions/pi-fusion/index.ts";

describe("scaffold", () => {
  it("exports a loadable extension factory", () => {
    expect(typeof fusionExtension).toBe("function");
  });
});

describe("loading without a project file (openspec fusion-project-config, scenario 'Расширение грузится без проектного файла')", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-scaffold-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads silently when neither the global nor the project file exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = {
      events: undefined,
      registerTool() {},
      registerCommand() {},
      on() {},
      appendEntry() {},
      getActiveTools: () => [],
      setActiveTools() {},
    } as unknown as ExtensionAPI;
    expect(() =>
      fusionExtension(pi, {
        configPath: join(dir, "missing-global.json"),
        projectConfigDir: join(dir, "no-project"),
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
