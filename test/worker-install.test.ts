import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultAgentDir,
  defaultWorkerAgentTargetPath,
  FUSION_ROLE_PROFILES,
  FUSION_WORKER_AGENT_FILENAME,
  FUSION_WORKER_AGENT_VERSION,
  fusionCodexExtensionEntryPath,
  fusionWebExtensionEntryPath,
  installFusionRoleAgents,
  installFusionWorkerAgent,
  parseAgentFrontmatter,
  parseAgentVersion,
  shippedAgentPathFor,
  shippedWorkerAgentPath,
} from "../extensions/pi-fusion/worker-install.ts";

const shippedContent = (): string => readFileSync(shippedWorkerAgentPath(), "utf8");

describe("worker-install installFusionWorkerAgent", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "fusion-agent-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("installs the shipped agent file into <agentDir>/agents", () => {
    const target = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
    expect(installFusionWorkerAgent({ agentDir })).toEqual({ outcome: "installed", path: target });
    expect(readFileSync(target, "utf8")).toBe(shippedContent());
  });

  it("is idempotent: a version-matched target is reported current and left untouched", () => {
    installFusionWorkerAgent({ agentDir });
    const target = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
    const mtime = statSync(target).mtimeMs;
    expect(installFusionWorkerAgent({ agentDir })).toEqual({ outcome: "current", path: target });
    expect(statSync(target).mtimeMs).toBe(mtime);
    expect(readFileSync(target, "utf8")).toBe(shippedContent());
  });

  it("does not even attempt a write when the target has the shipped version (read-only target)", () => {
    installFusionWorkerAgent({ agentDir });
    const target = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
    chmodSync(target, 0o444);
    try {
      expect(installFusionWorkerAgent({ agentDir }).outcome).toBe("current");
    } finally {
      chmodSync(target, 0o644);
    }
  });

  it("updates a target whose version header is older", () => {
    const target = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
    mkdirSync(dirname(target), { recursive: true });
    const stale = shippedContent().replace(`version: ${FUSION_WORKER_AGENT_VERSION}`, "version: 0");
    expect(stale).not.toBe(shippedContent());
    writeFileSync(target, stale, "utf8");
    expect(installFusionWorkerAgent({ agentDir })).toEqual({ outcome: "updated", path: target });
    expect(readFileSync(target, "utf8")).toBe(shippedContent());
  });

  it("updates a target that has no version header", () => {
    const target = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
    mkdirSync(dirname(target), { recursive: true });
    const headerless = shippedContent().replace(`version: ${FUSION_WORKER_AGENT_VERSION}\n`, "");
    expect(headerless).not.toBe(shippedContent());
    writeFileSync(target, headerless, "utf8");
    expect(installFusionWorkerAgent({ agentDir }).outcome).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe(shippedContent());
  });

  it("installs from an explicit sourcePath when given", () => {
    const sourcePath = join(agentDir, "custom-worker.md");
    writeFileSync(sourcePath, "---\nname: fusion-worker\nversion: 9\n---\n\nbody\n", "utf8");
    const target = join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME);
    expect(installFusionWorkerAgent({ agentDir, sourcePath })).toEqual({
      outcome: "installed",
      path: target,
    });
    expect(readFileSync(target, "utf8")).toContain("version: 9");
  });

  it("fails with the source path when the source agent file is missing", () => {
    const sourcePath = join(agentDir, "missing.md");
    expect(() => installFusionWorkerAgent({ agentDir, sourcePath })).toThrow(/missing\.md/);
  });

  it("propagates write errors and names the target path (review fix)", () => {
    const sourcePath = join(agentDir, "worker.md");
    writeFileSync(sourcePath, "---\nname: fusion-worker\nversion: 9\n---\n\nbody\n", "utf8");
    // A directory at the target path makes writeFileSync fail with EISDIR.
    mkdirSync(join(agentDir, "agents", FUSION_WORKER_AGENT_FILENAME), { recursive: true });
    expect(() => installFusionWorkerAgent({ agentDir, sourcePath })).toThrow(
      FUSION_WORKER_AGENT_FILENAME,
    );
  });

  it("defaults to ~/.pi/agent like the config bridge", () => {
    expect(defaultAgentDir()).toBe(join(homedir(), ".pi", "agent"));
    expect(defaultWorkerAgentTargetPath()).toBe(
      join(homedir(), ".pi", "agent", "agents", FUSION_WORKER_AGENT_FILENAME),
    );
  });
});

describe("worker-install frontmatter parsing", () => {
  it("reads flat scalar fields from the fenced header", () => {
    const fields = parseAgentFrontmatter(
      "---\nname: fusion-worker\ntools: read, write\n---\n\nbody\n",
    );
    expect(fields).toEqual({ name: "fusion-worker", tools: "read, write" });
  });

  it("ignores key: value lines in the body", () => {
    const fields = parseAgentFrontmatter("---\nname: a\n---\n\nversion: 99\n");
    expect(fields.version).toBeUndefined();
  });

  it("parseAgentVersion returns the header version, or undefined when absent", () => {
    expect(parseAgentVersion("---\nversion: 1\n---\n\nx\n")).toBe("1");
    expect(parseAgentVersion("---\nname: a\n---\n\nx\n")).toBeUndefined();
    expect(parseAgentVersion("no frontmatter at all")).toBeUndefined();
  });
});

describe("shipped fusion-worker agent contract", () => {
  const content = shippedContent();
  const frontmatter = parseAgentFrontmatter(content);

  it("carries a version header matching the installer constant", () => {
    expect(frontmatter.version).toBe(FUSION_WORKER_AGENT_VERSION);
    expect(parseAgentVersion(content)).toBe(FUSION_WORKER_AGENT_VERSION);
  });

  it("has the worker name and a description", () => {
    expect(frontmatter.name).toBe("fusion-worker");
    expect(frontmatter.description?.length ?? 0).toBeGreaterThan(0);
  });

  it("exposes EXACTLY the worker tool allowlist — no fusion, subagent or codemode", () => {
    expect(frontmatter.tools?.split(",").map((tool) => tool.trim())).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
    ]);
    for (const banned of ["fusion", "subagent", "codemode"]) {
      expect(frontmatter.tools).not.toMatch(new RegExp(`(^|,\\s*)${banned}(\\s*,|$)`));
    }
  });

  it("pins fresh context, replaced system prompt and no inherited skills", () => {
    expect(frontmatter.defaultContext).toBe("fresh");
    expect(frontmatter.inheritSkills).toBe("false");
    expect(frontmatter.systemPromptMode).toBe("replace");
  });

  it("states the WorkerReport schema fields and all four statuses", () => {
    for (const field of [
      "status",
      "summary",
      "filesChanged",
      "evidence",
      "residualRisks",
      "replacedExistingFiles",
      "question",
    ]) {
      expect(content).toContain(`\`${field}\``);
    }
    for (const status of ["done", "no_changes", "failed", "needs_orchestrator"]) {
      expect(content).toContain(status);
    }
  });

  it("requires question exactly for needs_orchestrator and demands check output in evidence", () => {
    expect(content).toMatch(/`needs_orchestrator`[\s\S]*?`question`/);
    expect(content).toMatch(/evidence[\s\S]*?(command|exit)/i);
  });
});

describe("worker-install FUSION_ROLE_PROFILES (design §4.6)", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "fusion-roles-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("the manifest carries exactly the seven profiles", () => {
    expect(FUSION_ROLE_PROFILES.map((profile) => profile.name)).toEqual([
      "fusion-worker",
      "fusion-scout",
      "fusion-researcher",
      "fusion-researcher-web",
      "fusion-researcher-codex",
      "fusion-researcher-both",
      "fusion-reviewer",
    ]);
    for (const profile of FUSION_ROLE_PROFILES) {
      expect(profile.filename).toBe(`${profile.name}.md`);
      expect(profile.version.length).toBeGreaterThan(0);
    }
  });

  it("installs all seven; each result carries the profile name", () => {
    const results = installFusionRoleAgents({ agentDir });
    expect(results).toHaveLength(7);
    for (const result of results) {
      expect(result.outcome).toBe("installed");
      expect(result.path).toBe(join(agentDir, "agents", `${result.name}.md`));
      expect(existsSync(result.path)).toBe(true);
    }
  });

  it("a repeat pass reports current for every profile and rewrites nothing", () => {
    installFusionRoleAgents({ agentDir });
    const mtimes = new Map(
      FUSION_ROLE_PROFILES.map((profile) => [
        profile.name,
        statSync(join(agentDir, "agents", profile.filename)).mtimeMs,
      ]),
    );
    for (const result of installFusionRoleAgents({ agentDir })) {
      expect(result.outcome).toBe("current");
      expect(statSync(result.path).mtimeMs).toBe(mtimes.get(result.name));
    }
  });

  it("updates a stale profile per entry while current ones stay untouched", () => {
    installFusionRoleAgents({ agentDir });
    const staleName = "fusion-scout";
    const stalePath = join(agentDir, "agents", "fusion-scout.md");
    const stale = readFileSync(stalePath, "utf8").replace("version: 1", "version: 0");
    expect(stale).not.toBe(readFileSync(stalePath, "utf8"));
    writeFileSync(stalePath, stale, "utf8");
    const results = installFusionRoleAgents({ agentDir });
    expect(results.find((result) => result.name === staleName)?.outcome).toBe("updated");
    const others = results.filter((result) => result.name !== staleName);
    for (const result of others) expect(result.outcome).toBe("current");
    expect(readFileSync(stalePath, "utf8")).toBe(
      readFileSync(shippedAgentPathFor("fusion-scout.md"), "utf8"),
    );
  });

  it("substitutes the extension entry placeholders with resolved absolute paths (§4.9.4)", () => {
    installFusionRoleAgents({ agentDir });
    const web = readFileSync(join(agentDir, "agents", "fusion-researcher-web.md"), "utf8");
    expect(web).toContain(fusionWebExtensionEntryPath(agentDir).replaceAll("\\", "/"));
    expect(web).not.toContain("{{FUSION_WEB_EXTENSION_ENTRY}}");
    const codex = readFileSync(join(agentDir, "agents", "fusion-researcher-codex.md"), "utf8");
    expect(codex).toContain(fusionCodexExtensionEntryPath(agentDir).replaceAll("\\", "/"));
    expect(codex).not.toContain("{{FUSION_CODEX_EXTENSION_ENTRY}}");
    const both = readFileSync(join(agentDir, "agents", "fusion-researcher-both.md"), "utf8");
    expect(both).toContain(", "); // both entries, comma-separated in one scalar
    expect(both).not.toContain("{{");
  });

  it("the version line stays literal through substitution (staleness check unaffected)", () => {
    installFusionRoleAgents({ agentDir });
    const web = readFileSync(join(agentDir, "agents", "fusion-researcher-web.md"), "utf8");
    expect(parseAgentVersion(web)).toBe("1");
    const results = installFusionRoleAgents({ agentDir });
    expect(results.find((result) => result.name === "fusion-researcher-web")?.outcome).toBe(
      "current",
    );
  });

  it("the plain researcher profile carries no web tool names", () => {
    installFusionRoleAgents({ agentDir });
    const none = readFileSync(join(agentDir, "agents", "fusion-researcher.md"), "utf8");
    const frontmatter = parseAgentFrontmatter(none);
    expect(frontmatter.tools?.split(",").map((tool) => tool.trim())).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
    expect(none).not.toContain("subagentOnlyExtensions");
  });
});

describe("shipped role agent contracts (design §4.4)", () => {
  const headerOf = (filename: string): Record<string, string> =>
    parseAgentFrontmatter(readFileSync(shippedAgentPathFor(filename), "utf8"));

  it("scout: read-only allowlist (no bash, edit, write)", () => {
    expect(
      headerOf("fusion-scout.md")
        .tools?.split(",")
        .map((tool) => tool.trim()),
    ).toEqual(["read", "grep", "find", "ls"]);
  });

  it("researcher-web: exactly web_search and web_fetch added; delivery via subagentOnlyExtensions", () => {
    const frontmatter = headerOf("fusion-researcher-web.md");
    expect(frontmatter.tools?.split(",").map((tool) => tool.trim())).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "web_search",
      "web_fetch",
    ]);
    expect(frontmatter.subagentOnlyExtensions).toBe("{{FUSION_WEB_EXTENSION_ENTRY}}");
  });

  it("researcher-codex: exactly codex_search added", () => {
    const frontmatter = headerOf("fusion-researcher-codex.md");
    expect(frontmatter.tools?.split(",").map((tool) => tool.trim())).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "codex_search",
    ]);
    expect(frontmatter.subagentOnlyExtensions).toBe("{{FUSION_CODEX_EXTENSION_ENTRY}}");
  });

  it("researcher-both: all three web names, both delivery entries", () => {
    const frontmatter = headerOf("fusion-researcher-both.md");
    expect(frontmatter.tools?.split(",").map((tool) => tool.trim())).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "web_search",
      "web_fetch",
      "codex_search",
    ]);
    expect(frontmatter.subagentOnlyExtensions).toBe(
      "{{FUSION_WEB_EXTENSION_ENTRY}}, {{FUSION_CODEX_EXTENSION_ENTRY}}",
    );
  });

  it("reviewer: bash allowed, edit and write not", () => {
    expect(
      headerOf("fusion-reviewer.md")
        .tools?.split(",")
        .map((tool) => tool.trim()),
    ).toEqual(["read", "grep", "find", "ls", "bash"]);
  });

  it("every shipped profile pins fresh context, replaced prompt, no inherited skills, and a version", () => {
    for (const profile of FUSION_ROLE_PROFILES) {
      const frontmatter = headerOf(profile.filename);
      expect(frontmatter.systemPromptMode).toBe("replace");
      expect(frontmatter.inheritProjectContext).toBe("true");
      expect(frontmatter.inheritSkills).toBe("false");
      expect(frontmatter.defaultContext).toBe("fresh");
      expect(frontmatter.version).toBe(profile.version);
      expect(frontmatter.model).toBeUndefined();
      expect(frontmatter.thinking).toBeUndefined();
      expect(frontmatter.allowNestedSubagents).toBeUndefined();
    }
  });
});
