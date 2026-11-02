import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_RULES } from "../extensions/pi-fusion/lead-access.ts";
import {
  BARREN_DELEGATION_LIMIT,
  emptyLeadRestrictionState,
  hostShellCustomized,
  LEAD_BLOCKED_TOOLS,
  refusalText,
  registerLeadRestrictions,
  resolveHostAgentDir,
  type ShellSettingsContext,
  shellSettingsVerdict,
  systemShellSettingsContext,
} from "../extensions/pi-fusion/restrictions.ts";
import type { FanoutResult, TaskResult } from "../extensions/pi-fusion/types.ts";

type Ctx = { cwd?: string } | undefined;
type Handler = (event: Record<string, unknown>, ctx: Ctx) => unknown;

/** A pi stand-in that records `pi.on` handlers and fires them like the host does. */
function makeHost() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    fire(name: string, event: Record<string, unknown>, ctx?: Ctx): unknown {
      let last: unknown;
      for (const handler of handlers.get(name) ?? []) last = handler(event, ctx);
      return last;
    },
    registered: () => [...handlers.keys()].sort(),
  };
}

function toolCall(toolName: string) {
  return { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input: {} };
}

function task(id: string, overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id,
    status: "done",
    summary: "ok",
    filesChanged: [],
    evidence: [],
    residualRisks: [],
    attempts: 1,
    turns: 3,
    ...overrides,
  };
}

function fanout(results: TaskResult[]): FanoutResult {
  return { results, clamps: [], usage: {}, usagePartial: false };
}

/** A completed fusion_delegate call carrying its FanoutResult as structuredContent. */
function delegated(host: ReturnType<typeof makeHost>, result: FanoutResult) {
  host.fire("tool_result", {
    type: "tool_result",
    toolCallId: "fan",
    toolName: "fusion_delegate",
    input: {},
    content: [{ type: "text", text: "rendered" }],
    structuredContent: result,
    isError: false,
  });
}

function refusedReason(host: ReturnType<typeof makeHost>, toolName: string): string {
  const verdict = host.fire("tool_call", toolCall(toolName)) as
    | { block?: boolean; reason?: string }
    | undefined;
  expect(verdict?.block).toBe(true);
  return verdict?.reason ?? "";
}

/** The barren-leg refusal: the worker leg is not running, tell the operator. */
const BARREN_TEXT = "воркер-нога не работает — скажи оператору";

/** Hermetic shell seams: a fixed env and home, and a readFile that never touches the disk. */
const HERMETIC_HOME = process.platform === "win32" ? "C:\\hermetic-home" : "/hermetic-home";
function hermeticShell(over: Partial<ShellSettingsContext> = {}): ShellSettingsContext {
  return {
    env: {},
    homedir: () => HERMETIC_HOME,
    platform: process.platform,
    readFile: (path) => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    ...over,
  };
}

const enabled = {
  isEnabled: () => true,
  isLeadSession: () => true,
  shellSettingsContext: () => hermeticShell(),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lead restrictions: blocking", () => {
  it("blocks write, edit and bash as a whole while fusion is enabled", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    for (const tool of ["write", "edit", "bash"]) {
      expect(refusedReason(host, tool)).not.toBe("");
    }
  });

  it("the default blocklist is exactly write, edit, bash, powershell, subagent (OQ-1, fusion-lead-subagent-block)", () => {
    expect([...LEAD_BLOCKED_TOOLS]).toEqual(["write", "edit", "bash", "powershell", "subagent"]);
  });

  it("blocks subagent by default with the standard blocklist text, no exception (fusion-lead-subagent-block, FR-001)", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    const reason = refusedReason(host, "subagent");
    expect(reason).toBe(refusalText("subagent", emptyLeadRestrictionState()));
    expect(reason).not.toContain("исключение");
  });

  it("blocks subagent when it is in an explicit blockedTools list, while fusion is on", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, { ...enabled, blockedTools: ["write", "subagent"] });
    expect(refusedReason(host, "subagent")).toBe(
      refusalText("subagent", emptyLeadRestrictionState()),
    );
  });

  it("an explicit blockedTools without subagent lets subagent through (the list replaces the default)", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, { ...enabled, blockedTools: ["write"] });
    expect(host.fire("tool_call", toolCall("subagent"))).toBeUndefined();
  });

  it("subagent in the blocklist is inert while fusion is off", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, {
      ...enabled,
      isEnabled: () => false,
      blockedTools: ["subagent"],
    });
    expect(host.fire("tool_call", toolCall("subagent"))).toBeUndefined();
  });

  it("passes everything when fusion is off", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, { ...enabled, isEnabled: () => false });
    expect(host.fire("tool_call", toolCall("write"))).toBeUndefined();
    expect(host.fire("tool_call", toolCall("bash"))).toBeUndefined();
  });

  it("never touches read-only tools or other extension tools", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    for (const tool of [
      "read",
      "grep",
      "find",
      "ls",
      "fusion_delegate",
      "codemode",
      "mcp__docs__search",
    ]) {
      expect(host.fire("tool_call", toolCall(tool))).toBeUndefined();
    }
  });

  it("the block does not depend on fan-out history: a successful fan-out unlocks nothing", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a", { turns: 5 })]));
    expect(refusedReason(host, "write")).not.toBe("");
    expect(refusedReason(host, "edit")).not.toBe("");
  });

  it("is inert in a pi-subagents child process (PI_SUBAGENT_CHILD=1)", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const host = makeHost();
    registerLeadRestrictions(host.api, { isEnabled: () => true });
    expect(host.fire("tool_call", toolCall("write"))).toBeUndefined();
  });

  it("blocks in the main process when PI_SUBAGENT_CHILD is not '1'", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "");
    const host = makeHost();
    registerLeadRestrictions(host.api, {
      isEnabled: () => true,
      shellSettingsContext: () => hermeticShell(),
    });
    expect(refusedReason(host, "write")).not.toBe("");
  });

  it("uses a custom blocklist when one is given", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, { ...enabled, blockedTools: ["write"] });
    expect(refusedReason(host, "write")).not.toBe("");
    expect(host.fire("tool_call", toolCall("edit"))).toBeUndefined();
  });

  it("blocks powershell by default, with no exception applied (OQ-1, TD-08)", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, {
      ...enabled,
      projectRoot: () => mkdtempSync(join(tmpdir(), "pwsh-")),
    });
    const reason = refusedReason(host, "powershell");
    expect(reason).not.toBe("");
    expect(reason).not.toContain("исключение");
  });
});

describe("lead restrictions: openspec/ write-edit exception (design §5)", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fusion-boundary-"));
    mkdirSync(join(root, "openspec"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const withRoot = { ...enabled, projectRoot: () => root };

  function callWith(
    host: ReturnType<typeof makeHost>,
    toolName: string,
    input: unknown,
    ctx?: Ctx,
  ) {
    return host.fire("tool_call", { type: "tool_call", toolCallId: "c1", toolName, input }, ctx) as
      | { block?: boolean; reason?: string }
      | undefined;
  }

  it("allows a write inside the openspec/ boundary and blocks one outside", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, withRoot);
    expect(
      callWith(host, "write", { path: join(root, "openspec", "changes", "x.md"), content: "y" }),
    ).toBeUndefined();
    const outside = callWith(host, "write", { path: join(root, "src", "a.ts"), content: "y" });
    expect(outside?.block).toBe(true);
    expect(outside?.reason).toContain("вне каталога документации OpenSpec");
  });

  it("takes the session cwd from ctx.cwd when no override is given", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    expect(
      callWith(
        host,
        "write",
        { path: join(root, "openspec", "z.md"), content: "y" },
        { cwd: root },
      ),
    ).toBeUndefined();
    const outside = callWith(
      host,
      "write",
      { path: join(root, "src", "a.ts"), content: "y" },
      { cwd: root },
    );
    expect(outside?.block).toBe(true);
  });

  it("blocks a write whose input carries no path (conservative)", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, withRoot);
    const verdict = callWith(host, "write", {});
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("у вызова нет пути");
  });
});

describe("lead restrictions: perl exception (design §6)", () => {
  let root = "";
  let agentDir = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fusion-perl-root-"));
    agentDir = mkdtempSync(join(tmpdir(), "fusion-perl-agent-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  // Real files under the temp root and agent dir only; env and home are injected, never the process's.
  const opts = () => ({
    ...enabled,
    projectRoot: () => root,
    agentDir: () => agentDir,
    shellSettingsContext: () => ({
      ...hermeticShell(),
      readFile: systemShellSettingsContext().readFile,
    }),
  });

  function callBash(command: string) {
    const host = makeHost();
    registerLeadRestrictions(host.api, opts());
    return host.fire("tool_call", {
      type: "tool_call",
      toolCallId: "c1",
      toolName: "bash",
      input: { command },
    }) as { block?: boolean; reason?: string } | undefined;
  }

  it("allows a single perl invocation under the host POSIX shell", () => {
    expect(callBash("perl -0777 -i -pe 's/foo/bar/g' openspec/config.yaml")).toBeUndefined();
    expect(callBash("perl -e 'print 42'")).toBeUndefined();
  });

  it("blocks shell chains even when they contain perl", () => {
    const verdict = callBash("perl -e 'x' && make");
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("не одиночный вызов perl");
    expect(callBash("cat x | perl -e 'y'")?.block).toBe(true);
    expect(callBash("perl -e 'x'; perl -e 'y'")?.block).toBe(true);
  });

  it("blocks the B1 bypass: backslash inside double quotes", () => {
    const verdict = callBash('perl -e "x\\" " ; echo SHELL_CHAIN_EXECUTED; #"');
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("backslash в двойных кавычках");
  });

  it("disables the exception when settings.json sets shellPath (§6.1.5)", () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ shellPath: "pwsh.exe" }),
      "utf8",
    );
    const verdict = callBash("perl -e 'print 42'");
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("оболочка не POSIX-совместима");
  });

  it("fails closed when settings.json is corrupt, but not when it is absent", () => {
    writeFileSync(join(agentDir, "settings.json"), "{ broken", "utf8");
    expect(callBash("perl -e 'print 42'")?.block).toBe(true);
    rmSync(join(agentDir, "settings.json"));
    expect(callBash("perl -e 'print 42'")).toBeUndefined();
  });

  it("blocks perl when the PROJECT .pi/settings.json sets shellPath (review blocker)", () => {
    // The host merges global and project settings (settings-manager deepMerge);
    // a shellPath only in the project file must disable the exception too.
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ shellPath: "pwsh.exe" }),
      "utf8",
    );
    expect(callBash("perl -e 'print 42'")?.block).toBe(true);
    expect(callBash("perl -e 'print 42'")?.reason).toContain("оболочка не POSIX-совместима");
  });

  it("blocks perl when a shellCommandPrefix is configured (review minor 13)", () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ shellCommandPrefix: "set -x;" }),
      "utf8",
    );
    expect(callBash("perl -e 'print 42'")?.block).toBe(true);
  });

  it("blocks perl on a truthy non-string shellPath (fail-closed, review minor 12)", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: 5 }), "utf8");
    expect(callBash("perl -e 'print 42'")?.block).toBe(true);
  });

  it("fails closed when the PROJECT settings are corrupt", () => {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "settings.json"), "{ nope", "utf8");
    expect(callBash("perl -e 'print 42'")?.block).toBe(true);
  });

  it("expands ~\\ in PI_CODING_AGENT_DIR the same way (review minor 14)", () => {
    if (process.platform !== "win32") return; // the ~\ form is a win32 branch
    const parent = mkdtempSync(join(tmpdir(), "fusion-home-bs-"));
    const customDir = join(parent, "custom-agent");
    mkdirSync(customDir, { recursive: true });
    try {
      writeFileSync(
        join(customDir, "settings.json"),
        JSON.stringify({ shellPath: "pwsh.exe" }),
        "utf8",
      );
      const host = makeHost();
      registerLeadRestrictions(host.api, {
        ...enabled,
        projectRoot: () => root,
        shellSettingsContext: () => ({
          env: { PI_CODING_AGENT_DIR: "~\\custom-agent", HOME: parent, USERPROFILE: parent },
          homedir: () => parent,
          platform: "win32",
          readFile: systemShellSettingsContext().readFile,
        }),
      });
      const verdict = host.fire("tool_call", {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "perl -e 'print 42'" },
      }) as { block?: boolean; reason?: string } | undefined;
      expect(verdict?.block).toBe(true);
      expect(verdict?.reason).toContain("оболочка не POSIX-совместима");
    } finally {
      rmSync(parent, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("expands ~ in PI_CODING_AGENT_DIR before reading settings (review blocker)", () => {
    // A literal-~ agent dir made the settings read ENOENT, which read as
    // "stock install" and left the perl exception ON under a custom shellPath.
    const parent = mkdtempSync(join(tmpdir(), "fusion-home-"));
    const customDir = join(parent, "custom-agent");
    mkdirSync(customDir, { recursive: true });
    try {
      writeFileSync(
        join(customDir, "settings.json"),
        JSON.stringify({ shellPath: "pwsh.exe" }),
        "utf8",
      );
      const host = makeHost();
      registerLeadRestrictions(host.api, {
        ...enabled,
        projectRoot: () => root,
        shellSettingsContext: () => ({
          env: { PI_CODING_AGENT_DIR: "~/custom-agent", HOME: parent, USERPROFILE: parent },
          homedir: () => parent,
          platform: process.platform,
          readFile: systemShellSettingsContext().readFile,
        }),
      });
      const verdict = host.fire("tool_call", {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "perl -e 'print 42'" },
      }) as { block?: boolean; reason?: string } | undefined;
      expect(verdict?.block).toBe(true);
      expect(verdict?.reason).toContain("оболочка не POSIX-совместима");
    } finally {
      rmSync(parent, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});

describe("lead restrictions: refusal text by fan-out state", () => {
  it("before the first fan-out: plan and delegate", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    expect(refusedReason(host, "write")).toContain(
      "планируй и делегируй — отправь fusion_delegate",
    );
  });

  it("after a fan-out with results: send the rework out, needs_orchestrator is a new fan-out", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a", { status: "needs_orchestrator" })]));
    const reason = refusedReason(host, "edit");
    expect(reason).toContain(
      "отправь переделку: needs_orchestrator = новый fan-out, пути в files, не захватывай работу сам",
    );
    expect(reason).not.toContain("планируй и делегируй");
  });

  it("a refused fusion_delegate (no FanoutResult) does not count as a fan-out", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    host.fire("tool_result", {
      type: "tool_result",
      toolCallId: "bad",
      toolName: "fusion_delegate",
      input: {},
      content: [{ type: "text", text: "fusion_delegate refused" }],
      isError: true,
    });
    expect(refusedReason(host, "write")).toContain("планируй и делегируй");
  });

  it("ignores tool_result of other tools even if they carry a FanoutResult shape", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    host.fire("tool_result", {
      type: "tool_result",
      toolCallId: "other",
      toolName: "subagent",
      input: {},
      content: [],
      structuredContent: fanout([task("a")]),
      isError: false,
    });
    expect(refusedReason(host, "write")).toContain("планируй и делегируй");
  });
});

describe("lead restrictions: barren counter", () => {
  const zeroSteps = () => fanout([task("a", { turns: 0 }), task("b", { turns: 0 })]);

  it("the limit is two consecutive barren fan-outs", () => {
    expect(BARREN_DELEGATION_LIMIT).toBe(2);
  });

  it("one barren fan-out keeps the rework text", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, zeroSteps());
    const reason = refusedReason(host, "write");
    expect(reason).not.toContain(BARREN_TEXT);
    expect(reason).toContain("отправь переделку");
  });

  it("two consecutive barren fan-outs switch the text to the operator message", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, zeroSteps());
    delegated(host, zeroSteps());
    const reason = refusedReason(host, "write");
    expect(reason).toContain(BARREN_TEXT);
    expect(reason).not.toContain("отправь переделку");
  });

  it("a fan-out that ran any step resets the barren streak", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, zeroSteps());
    delegated(host, fanout([task("a", { turns: 0 }), task("b", { turns: 1 })]));
    delegated(host, zeroSteps());
    expect(refusedReason(host, "write")).not.toContain(BARREN_TEXT);
  });

  it("steps fall back to turnsObserved when turns is absent", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    const observedZero = () => fanout([task("a", { turns: undefined, turnsObserved: 0 })]);
    delegated(host, observedZero());
    delegated(host, observedZero());
    expect(refusedReason(host, "write")).toContain(BARREN_TEXT);
  });

  it("unknown steps (no turns, no turnsObserved) are not zero: not barren", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    const unknown = () => fanout([task("a", { turns: undefined, turnsObserved: undefined })]);
    delegated(host, unknown());
    delegated(host, unknown());
    expect(refusedReason(host, "write")).not.toContain(BARREN_TEXT);
  });
});

describe("lead restrictions: run phase", () => {
  it("agent_start resets the fan-out phase back to plan-and-delegate", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a")]));
    expect(refusedReason(host, "write")).toContain("отправь переделку");
    host.fire("agent_start", { type: "agent_start" });
    expect(refusedReason(host, "write")).toContain("планируй и делегируй");
  });

  it("agent_start resets the barren streak", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    const zero = () => fanout([task("a", { turns: 0 })]);
    delegated(host, zero());
    delegated(host, zero());
    host.fire("agent_start", { type: "agent_start" });
    delegated(host, zero());
    expect(refusedReason(host, "write")).not.toContain(BARREN_TEXT);
  });

  it("turn_start does not reset: the phase survives the model requests of one run", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    delegated(host, fanout([task("a")]));
    // pi fires turn_start per model request (docs extensions.md:84); the
    // post-fan-out phase must reach the very next request.
    host.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
    expect(refusedReason(host, "write")).toContain("отправь переделку");
  });

  it("subscribes to tool_call, tool_result and agent_start", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, enabled);
    expect(host.registered()).toEqual(["agent_start", "session_start", "tool_call", "tool_result"]);
  });
});

describe("lead restrictions: host shell settings on win32 (design §6.6, tasks 9.4-B)", () => {
  // Hermetic: env, homedir, platform and readFile are injected through
  // shellSettingsContext; the fake readFile never touches the real profile.
  let T = "";
  beforeEach(() => {
    T = mkdtempSync(join(tmpdir(), "fusion-shell-win-"));
  });
  afterEach(() => {
    rmSync(T, { recursive: true, force: true });
  });

  it("resolves the host agent dir from USERPROFILE and disables the perl exception (9.4-B)", () => {
    const userprofile = win32.join(T, "userprofile");
    const project = win32.join(T, "project");
    // The full env map: HOME in /c/… form, no PI_CODING_AGENT_DIR key at all.
    const env = { HOME: "/c/Users/user", USERPROFILE: userprofile };
    const settingsPath = win32.join(userprofile, ".pi", "agent", "settings.json");
    const readFile = (path: string): string => {
      if (path === settingsPath) return JSON.stringify({ shellPath: "pwsh.exe" });
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    };
    const seams: ShellSettingsContext = {
      env,
      homedir: () => userprofile,
      platform: "win32",
      readFile,
    };

    // (1) the resolved directory, asserted directly
    expect(resolveHostAgentDir(env, seams.homedir, "win32")).toBe(
      win32.join(userprofile, ".pi", "agent"),
    );

    // (2) the verdict through the real tool_call hook
    const host = makeHost();
    registerLeadRestrictions(host.api, { ...enabled, shellSettingsContext: () => seams });
    const verdict = host.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "perl -e 'print 42'" },
      },
      { cwd: project },
    ) as { block?: boolean; reason?: string } | undefined;
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain("оболочка не POSIX-совместима");
  });
});

describe("host agent dir parity (design §6.6 rule 1, tasks 9.3)", () => {
  const WIN_HOME = "C:\\Users\\user";
  const winHome = () => WIN_HOME;
  const winDefault = win32.join(WIN_HOME, ".pi", "agent");

  it("win32: HOME never decides; USERPROFILE and the default come from homedir()", () => {
    expect(
      resolveHostAgentDir({ HOME: "/c/Users/other", USERPROFILE: WIN_HOME }, winHome, "win32"),
    ).toBe(winDefault);
  });

  it("win32: /c/… maps to a drive path (the host's normalizeWindowsShellPath)", () => {
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "/c/Users/x/agent" }, winHome, "win32")).toBe(
      "C:\\Users\\x\\agent",
    );
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "/mnt/d/a" }, winHome, "win32")).toBe(
      "D:\\a",
    );
  });

  it("win32: ~, ~/… and ~\\… expand against homedir()", () => {
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "~" }, winHome, "win32")).toBe(WIN_HOME);
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }, winHome, "win32")).toBe(
      win32.join(WIN_HOME, "custom"),
    );
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "~\\custom" }, winHome, "win32")).toBe(
      win32.join(WIN_HOME, "custom"),
    );
  });

  it("win32: file:// URLs become paths", () => {
    expect(
      resolveHostAgentDir({ PI_CODING_AGENT_DIR: "file:///C:/Users/x/agent" }, winHome, "win32"),
    ).toBe("C:\\Users\\x\\agent");
  });

  it("win32: an empty value is unset; ~user is literal; a relative path stays relative", () => {
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "" }, winHome, "win32")).toBe(winDefault);
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "~user\\x" }, winHome, "win32")).toBe(
      "~user\\x",
    );
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "rel\\dir" }, winHome, "win32")).toBe(
      "rel\\dir",
    );
  });

  it("win32: an unresolvable home-derived dir is undefined (fail-closed, rule 3)", () => {
    const throwing = () => {
      throw new Error("no home");
    };
    expect(resolveHostAgentDir({}, throwing, "win32")).toBeUndefined();
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "~/x" }, () => "", "win32")).toBeUndefined();
    expect(
      resolveHostAgentDir({ PI_CODING_AGENT_DIR: "file://host/share" }, winHome, "win32"),
    ).toBeUndefined();
    // An absolute configured dir does not need the home directory at all.
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "C:\\abs\\agent" }, throwing, "win32")).toBe(
      "C:\\abs\\agent",
    );
  });

  const POSIX_HOME = "/home/user";
  const posixHome = () => POSIX_HOME;

  it("POSIX: HOME never decides; the default is homedir()/.pi/agent", () => {
    expect(resolveHostAgentDir({ HOME: "/home/other" }, posixHome, "linux")).toBe(
      "/home/user/.pi/agent",
    );
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "" }, posixHome, "linux")).toBe(
      "/home/user/.pi/agent",
    );
  });

  it("POSIX: ~/… expands; ~\\… and /c/… are literal; file:// becomes a path", () => {
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }, posixHome, "linux")).toBe(
      "/home/user/custom",
    );
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "~\\custom" }, posixHome, "linux")).toBe(
      "~\\custom",
    );
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "/c/Users/x" }, posixHome, "linux")).toBe(
      "/c/Users/x",
    );
    expect(
      resolveHostAgentDir({ PI_CODING_AGENT_DIR: "file:///srv/agent" }, posixHome, "linux"),
    ).toBe("/srv/agent");
  });

  it("POSIX: a relative homedir() is unresolvable for a home-derived dir", () => {
    expect(resolveHostAgentDir({}, () => "relative", "linux")).toBeUndefined();
    expect(resolveHostAgentDir({ PI_CODING_AGENT_DIR: "/abs" }, () => "", "linux")).toBe("/abs");
  });
});

describe("host shell settings: files and candidates (design §6.6 rule 3, tasks 9.3)", () => {
  const POSIX_HOME = "/home/user";
  const replica = posix.join(POSIX_HOME, ".pi", "agent", "settings.json");
  const project = posix.join("/proj", ".pi", "settings.json");
  const homeCandidate = posix.join("/home/other", ".pi", "agent", "settings.json");
  const SHELL = JSON.stringify({ shellPath: "pwsh.exe" });

  /** Files map to contents; a path in `errors` throws that code; any other path is ENOENT. */
  function fakeReadFile(files: Record<string, string>, errors: Record<string, string> = {}) {
    return (path: string): string => {
      const code = errors[path];
      if (code !== undefined) throw Object.assign(new Error(`${code}: ${path}`), { code });
      const content = files[path];
      if (content !== undefined) return content;
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    };
  }

  function seams(
    files: Record<string, string> = {},
    errors: Record<string, string> = {},
    over: Partial<ShellSettingsContext> = {},
  ): ShellSettingsContext {
    return {
      env: {},
      homedir: () => POSIX_HOME,
      platform: "linux",
      readFile: fakeReadFile(files, errors),
      ...over,
    };
  }

  const verdict = (ctx: ShellSettingsContext, extra: { replicaDir?: string } = {}) =>
    shellSettingsVerdict({ ...ctx, projectRoot: "/proj", ...extra });

  it("stock when no file configures a shell and every file is absent", () => {
    expect(verdict(seams())).toBe("stock");
    expect(hostShellCustomized({}, () => POSIX_HOME, "linux", fakeReadFile({}), "/proj")).toBe(
      false,
    );
  });

  it("the project file is read and its shellPath disables perl and bd", () => {
    expect(verdict(seams({ [project]: SHELL }))).toBe("custom");
    expect(
      hostShellCustomized(
        {},
        () => POSIX_HOME,
        "linux",
        fakeReadFile({ [project]: SHELL }),
        "/proj",
      ),
    ).toBe(true);
  });

  it("a project file that fails with EACCES or holds broken JSON fails closed", () => {
    expect(verdict(seams({}, { [project]: "EACCES" }))).toBe("unreadable");
    expect(verdict(seams({ [project]: "{ nope" }))).toBe("unreadable");
    expect(verdict(seams({ [replica]: "null" }))).toBe("unreadable");
  });

  it("a configured shellCommandPrefix and a truthy non-string shellPath are custom", () => {
    expect(verdict(seams({ [replica]: JSON.stringify({ shellCommandPrefix: "set -x;" }) }))).toBe(
      "custom",
    );
    expect(verdict(seams({ [replica]: JSON.stringify({ shellPath: 5 }) }))).toBe("custom");
  });

  it("a whitespace-only shellPath is configured: the host truthy-checks it, no trim", () => {
    expect(verdict(seams({ [replica]: JSON.stringify({ shellPath: "   " }) }))).toBe("custom");
    expect(verdict(seams({ [replica]: JSON.stringify({ shellPath: "" }) }))).toBe("stock");
  });

  it("a HOME candidate with shellPath disables while the replica is ENOENT", () => {
    expect(verdict(seams({ [homeCandidate]: SHELL }, {}, { env: { HOME: "/home/other" } }))).toBe(
      "custom",
    );
  });

  it("a HOME candidate that is ENOENT means not configured, and EACCES fails closed", () => {
    expect(verdict(seams({}, {}, { env: { HOME: "/home/other" } }))).toBe("stock");
    expect(
      verdict(seams({}, { [homeCandidate]: "EACCES" }, { env: { HOME: "/home/other" } })),
    ).toBe("unreadable");
  });

  it("a HOME equal to homedir() is not an extra candidate", () => {
    expect(verdict(seams({}, { [replica]: "EACCES" }, { env: { HOME: POSIX_HOME } }))).toBe(
      "unreadable",
    );
  });

  it("an unresolvable agent dir is unresolvable, and a custom file still wins", () => {
    const throwing = () => {
      throw new Error("no home");
    };
    expect(verdict(seams({}, {}, { env: { PI_CODING_AGENT_DIR: "~/x" }, homedir: throwing }))).toBe(
      "unresolvable",
    );
    expect(
      verdict(
        seams({ [project]: SHELL }, {}, { env: { PI_CODING_AGENT_DIR: "~/x" }, homedir: throwing }),
      ),
    ).toBe("custom");
  });

  it("the agentDir override replaces the replica and needs no resolution", () => {
    const throwing = () => {
      throw new Error("no home");
    };
    expect(
      verdict(seams({ "/custom/settings.json": SHELL }, {}, { homedir: throwing }), {
        replicaDir: "/custom",
      }),
    ).toBe("custom");
  });

  it("a relative PI_CODING_AGENT_DIR stays relative and is read relative", () => {
    expect(
      verdict(
        seams(
          { "rel/agent/settings.json": SHELL },
          {},
          { env: { PI_CODING_AGENT_DIR: "rel/agent" } },
        ),
      ),
    ).toBe("custom");
  });

  describe("the refusal text names the reason (design §6.7)", () => {
    function perlReason(ctx: ShellSettingsContext): string | undefined {
      const host = makeHost();
      registerLeadRestrictions(host.api, { ...enabled, shellSettingsContext: () => ctx });
      const result = host.fire(
        "tool_call",
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "perl -e 'print 42'" },
        },
        { cwd: "/proj" },
      ) as { block?: boolean; reason?: string } | undefined;
      return result?.block ? result.reason : undefined;
    }

    it("custom keeps the rev.3 text byte for byte", () => {
      expect(perlReason(seams({ [project]: SHELL }))).toContain(
        "Причина исключения: оболочка не POSIX-совместима (задан shellPath или префикс) — исключение perl отключено",
      );
    });

    it("unreadable settings name the unreadable case", () => {
      expect(perlReason(seams({}, { [project]: "EACCES" }))).toContain(
        "Причина исключения: настройки оболочки нечитаемы или не разобраны — исключение perl отключено",
      );
    });

    it("an unresolvable agent dir names that case", () => {
      const throwing = () => {
        throw new Error("no home");
      };
      expect(
        perlReason(seams({}, {}, { env: { PI_CODING_AGENT_DIR: "~/x" }, homedir: throwing })),
      ).toContain(
        "Причина исключения: каталог настроек агента не определяется — исключение perl отключено",
      );
    });

    it("stock settings let perl through", () => {
      expect(perlReason(seams())).toBeUndefined();
    });
  });
});

describe("host shell settings: USERPROFILE candidate on win32 (design §6.6 rule 3(в))", () => {
  const home = "C:\\Users\\user";
  const other = "C:\\Users\\other";
  const otherSettings = win32.join(other, ".pi", "agent", "settings.json");

  function win32Seams(userprofile: string, readFile: (path: string) => string) {
    return {
      env: { HOME: "/c/Users/user", USERPROFILE: userprofile },
      homedir: () => home,
      platform: "win32",
      readFile,
    };
  }

  it("a differing USERPROFILE settings file with shellPath disables perl", () => {
    const readFile = (path: string): string => {
      if (path === otherSettings) return JSON.stringify({ shellPath: "pwsh.exe" });
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    };
    expect(shellSettingsVerdict({ ...win32Seams(other, readFile), projectRoot: "C:\\proj" })).toBe(
      "custom",
    );
  });

  it("a USERPROFILE equal to homedir() (case-insensitively) is not an extra candidate", () => {
    const readFile = (path: string): string => {
      if (path === otherSettings) return JSON.stringify({ shellPath: "pwsh.exe" });
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    };
    expect(
      shellSettingsVerdict({
        ...win32Seams("c:\\users\\USER", readFile),
        projectRoot: "C:\\proj",
      }),
    ).toBe("stock");
  });
});

/** A settings file the lifecycle tests can edit mid-session, like a user would. */
const AGENT_SETTINGS = "/agent/settings.json";
const PROJECT_SETTINGS = "/proj/.pi/settings.json";
const SHELL_JSON = JSON.stringify({ shellPath: "pwsh.exe" });
const STOCK_JSON = JSON.stringify({ theme: "dark" });

/** Fake disk: a key is a file, any other path is ENOENT. Every read is recorded. */
function diskSeams(disk: Map<string, string>, reads: string[] = []): ShellSettingsContext {
  return {
    env: {},
    homedir: () => "/home/user",
    platform: "linux",
    readFile: (path) => {
      reads.push(path);
      const content = disk.get(path);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return content;
    },
  };
}

function lifecycleOptions(
  disk: Map<string, string>,
  reads: string[] = [],
  isLeadSession: () => boolean = () => true,
) {
  return {
    isEnabled: () => true,
    isLeadSession,
    // Pinned so the registration snapshot never reads process.cwd()'s real .pi/settings.json.
    projectRoot: () => "/proj",
    agentDir: () => "/agent",
    shellSettingsContext: () => diskSeams(disk, reads),
  };
}

function bashVerdict(host: ReturnType<typeof makeHost>) {
  return host.fire(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "perl -e 'print 42'" },
    },
    { cwd: "/proj" },
  ) as { block?: boolean; reason?: string } | undefined;
}

function startSession(host: ReturnType<typeof makeHost>, reason: string) {
  host.fire("session_start", { type: "session_start", reason }, { cwd: "/proj" });
}

describe("lead restrictions: shell snapshot lifecycle (fail-closed, no TOCTOU claim)", () => {
  it("a runtime that starts custom stays closed after the file turns stock, without a restart", () => {
    const disk = new Map([[AGENT_SETTINGS, SHELL_JSON]]);
    const host = makeHost();
    registerLeadRestrictions(host.api, lifecycleOptions(disk));
    disk.set(AGENT_SETTINGS, STOCK_JSON);
    expect(bashVerdict(host)?.block).toBe(true);
    expect(bashVerdict(host)?.reason).toContain("оболочка не POSIX-совместима");
    disk.delete(AGENT_SETTINGS);
    expect(bashVerdict(host)?.block).toBe(true);
  });

  it("a runtime that started custom from the project file stays closed when that file turns stock", () => {
    const disk = new Map([[PROJECT_SETTINGS, SHELL_JSON]]);
    const host = makeHost();
    registerLeadRestrictions(host.api, lifecycleOptions(disk));
    startSession(host, "startup");
    disk.set(PROJECT_SETTINGS, STOCK_JSON);
    expect(bashVerdict(host)?.block).toBe(true);
  });

  it("a stock runtime that turns custom is closed at once, the reverse path", () => {
    const disk = new Map<string, string>();
    const host = makeHost();
    registerLeadRestrictions(host.api, lifecycleOptions(disk));
    expect(bashVerdict(host)).toBeUndefined();
    disk.set(AGENT_SETTINGS, SHELL_JSON);
    expect(bashVerdict(host)?.block).toBe(true);
    expect(bashVerdict(host)?.reason).toContain("оболочка не POSIX-совместима");
  });

  it.each(["new", "reload"])(
    "session_start (%s) re-snapshots: stock after custom lets perl through",
    (reason) => {
      const disk = new Map([[AGENT_SETTINGS, SHELL_JSON]]);
      const host = makeHost();
      registerLeadRestrictions(host.api, lifecycleOptions(disk));
      disk.delete(AGENT_SETTINGS);
      expect(bashVerdict(host)?.block).toBe(true);
      startSession(host, reason);
      expect(bashVerdict(host)).toBeUndefined();
    },
  );

  it("session_start re-snapshots the other way: custom written before a new session closes perl", () => {
    const disk = new Map<string, string>();
    const host = makeHost();
    registerLeadRestrictions(host.api, lifecycleOptions(disk));
    disk.set(AGENT_SETTINGS, SHELL_JSON);
    startSession(host, "new");
    expect(bashVerdict(host)?.block).toBe(true);
  });

  it("a custom snapshot holds until the next session_start, whatever the disk says in between", () => {
    const disk = new Map([[AGENT_SETTINGS, SHELL_JSON]]);
    const host = makeHost();
    registerLeadRestrictions(host.api, lifecycleOptions(disk));
    startSession(host, "new");
    disk.delete(AGENT_SETTINGS);
    expect(bashVerdict(host)?.block).toBe(true);
    startSession(host, "new");
    expect(bashVerdict(host)).toBeUndefined();
  });

  it("reads only the injected agent and project settings, never the real profile", () => {
    const reads: string[] = [];
    const disk = new Map<string, string>();
    const host = makeHost();
    registerLeadRestrictions(host.api, lifecycleOptions(disk, reads));
    bashVerdict(host);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((path) => path === AGENT_SETTINGS || path === PROJECT_SETTINGS)).toBe(true);
  });

  it("a child worker reads no settings at registration", () => {
    const reads: string[] = [];
    const host = makeHost();
    registerLeadRestrictions(
      host.api,
      lifecycleOptions(new Map(), reads, () => false),
    );
    expect(reads).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* bd exception at the gate (design §6.5, §6.7; tasks 8.7)              */
/* Hermetic: a fake disk (ENOENT unless listed), a fixed home, linux.   */
/* ------------------------------------------------------------------ */

const BD_HOME = "/home/user";
const BD_REPLICA = "/home/user/.pi/agent/settings.json";
const BD_PROJECT = "/proj/.pi/settings.json";
const BD_SHELL = JSON.stringify({ shellPath: "pwsh.exe" });
const BD_STOCK = JSON.stringify({ theme: "dark" });
const BD_NOT_CONFIGURED = "Причина исключения: ";
const MERGED =
  "разрешены только одиночный вызов perl или одиночная команда bd (create/show/list/ready/update/close) — ";

/** Fake disk: a path listed in `errors` throws that code; a listed file is its content; anything else is ENOENT. */
function bdFs(files: Record<string, string>, errors: Record<string, string> = {}) {
  return (path: string): string => {
    const code = errors[path];
    if (code !== undefined) throw Object.assign(new Error(`${code}: ${path}`), { code });
    const content = files[path];
    if (content !== undefined) return content;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
}

type Verdict = { block?: boolean; reason?: string } | undefined;

/** One tool_call through the real gate, with the shell seams injected; the gate reads no real file. */
function gateCall(
  toolName: string,
  input: Record<string, unknown>,
  seams: Partial<ShellSettingsContext> = {},
  lead: () => boolean = () => true,
): Verdict {
  const host = makeHost();
  registerLeadRestrictions(host.api, {
    isEnabled: () => true,
    isLeadSession: lead,
    projectRoot: () => "/proj",
    shellSettingsContext: () => ({
      env: {},
      homedir: () => BD_HOME,
      platform: "linux",
      readFile: bdFs({}),
      ...seams,
    }),
  });
  return host.fire(
    "tool_call",
    { type: "tool_call", toolCallId: "c1", toolName, input },
    { cwd: "/proj" },
  ) as Verdict;
}

function bash(command: string, seams: Partial<ShellSettingsContext> = {}): Verdict {
  return gateCall("bash", { command }, seams);
}

/** The reason of a refused bash call; empty when the call passes. */
function bashReason(command: string, seams: Partial<ShellSettingsContext> = {}): string {
  const verdict = bash(command, seams);
  expect(verdict?.block, command).toBe(true);
  return verdict?.reason ?? "";
}

describe("lead restrictions: bash bd exception passes the six subcommands (design §6.5.1)", () => {
  it.each([
    "bd create 'Задача: сделать X'",
    "bd show pi-fusion-8t2",
    "bd list",
    "bd ready",
    "bd update pi-fusion-8t2 --claim",
    "bd close pi-fusion-8t2",
    '"bd" list',
    "'bd' 'list'",
    "bd create '*' \"~\"",
  ])("allows %j under the stock shell", (command) => {
    expect(bash(command)).toBeUndefined();
  });

  it("the perl exception keeps passing next to it", () => {
    expect(bash("perl -e 'print 42'")).toBeUndefined();
    expect(bash("perl -e 'x' *")).toBeUndefined();
  });
});

describe("lead restrictions: bash bd refusals name the bd branch (design §6.5.1, §6.7)", () => {
  it("a foreign subcommand carries the exact bd reason", () => {
    for (const command of ["bd init", "bd dolt push", "bd remember 'x'", "bd prime", "bd"]) {
      expect(bashReason(command)).toContain(
        `${BD_NOT_CONFIGURED}не одиночный вызов bd — argv[1] — не подкоманда из списка create/show/list/ready/update/close`,
      );
    }
  });

  it("the refusal keeps the refusal line of the gate in front of the reason", () => {
    const reason = bashReason("bd init");
    expect(reason.startsWith("bash не выполнен: fusion включён, код пишут воркеры")).toBe(true);
  });

  it("a flag before the subcommand is refused with the subcommand reason", () => {
    expect(bashReason("bd --json list")).toContain(
      "не одиночный вызов bd — argv[1] — не подкоманда из списка create/show/list/ready/update/close",
    );
  });

  it("a metacharacter names the first found character", () => {
    expect(bashReason("bd create x; bd list")).toContain(
      `${BD_NOT_CONFIGURED}не одиночный вызов bd — метасимвол ";" вне кавычек`,
    );
    expect(bashReason("bd list &")).toContain(
      `${BD_NOT_CONFIGURED}не одиночный вызов bd — метасимвол "&" вне кавычек`,
    );
  });

  it("an unquoted expansion character refuses with its exact text", () => {
    expect(bashReason("bd list *")).toContain(
      `${BD_NOT_CONFIGURED}не одиночный вызов bd — неквотированный символ раскрытия оболочки "*"`,
    );
    expect(bashReason("bd show ~")).toContain(
      `не одиночный вызов bd — неквотированный символ раскрытия оболочки "~"`,
    );
  });

  it("an unquoted # refuses for bd (B-NEW)", () => {
    expect(bashReason("bd list #x")).toContain(
      `${BD_NOT_CONFIGURED}не одиночный вызов bd — неквотированный "#" вне кавычек (комментарий оболочки)`,
    );
    expect(bashReason("bd list x # note")).toContain(
      `не одиночный вызов bd — неквотированный "#" вне кавычек (комментарий оболочки)`,
    );
  });

  it("an unclosed quote and a backslash inside double quotes refuse for bd", () => {
    expect(bashReason("bd 'unclosed")).toContain(
      `${BD_NOT_CONFIGURED}не одиночный вызов bd — незакрытая одинарная кавычка`,
    );
    expect(bashReason('bd "x\\" " ; bd list')).toContain(
      `не одиночный вызов bd — backslash в двойных кавычках (эскейп не поддерживается)`,
    );
  });
});

describe("lead restrictions: the merged formula for every other first word (design §6.5.1, §6.7)", () => {
  it.each([
    ["echo x && bd list", `${MERGED}первый токен не perl и не bd`],
    ["cat x | perl -e 'y'", `${MERGED}первый токен не perl и не bd`],
    ["ls", `${MERGED}первый токен не perl и не bd`],
    ["BD list", `${MERGED}первый токен не perl и не bd`],
    ["command bd list", `${MERGED}первый токен не perl и не bd`],
    ['"" list', `${MERGED}первый токен не perl и не bd`],
    ["   ", `${MERGED}пустая команда`],
    ["", `${MERGED}пустая команда`],
    ["perl#x", `${MERGED}неквотированный "#" вне кавычек (комментарий оболочки)`],
  ])("%j", (command, text) => {
    expect(bashReason(command)).toContain(`${BD_NOT_CONFIGURED}${text}`);
  });

  it("a bash call without a command names both exceptions (rev.4 text)", () => {
    expect(gateCall("bash", {})?.reason).toContain(
      `${BD_NOT_CONFIGURED}у вызова нет команды — исключения perl и bd не применяются`,
    );
  });

  it("perl refusals keep the rev.3 text byte for byte", () => {
    expect(bashReason("perl -e 'x' && make")).toContain(
      `${BD_NOT_CONFIGURED}не одиночный вызов perl — метасимвол "&" вне кавычек`,
    );
    expect(bashReason('"perl" -e x && make')).toContain(
      `${BD_NOT_CONFIGURED}не одиночный вызов perl — метасимвол "&" вне кавычек`,
    );
  });

  it("the B-NEW exploit is refused for perl and for bd: no line after the # runs", () => {
    expect(bashReason("perl -e 'print 1' #'\nprintf MARKER\n#'")).toContain(
      `не одиночный вызов perl — неквотированный "#" вне кавычек (комментарий оболочки)`,
    );
    expect(bashReason("bd list #'\nprintf MARKER\n#'")).toContain(
      `не одиночный вызов bd — неквотированный "#" вне кавычек (комментарий оболочки)`,
    );
  });

  it("the powershell tool gets no bd exception, whatever it runs", () => {
    const verdict = gateCall("powershell", { command: "bd list" });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).not.toContain("Причина исключения");
    expect(verdict?.reason).not.toContain("исключение");
  });
});

describe("lead restrictions: shell settings disable the bd exception with its own text (design §6.5.3, §6.7)", () => {
  const CUSTOM_BD =
    "оболочка не POSIX-совместима (задан shellPath или префикс) — исключение bd отключено";
  const CUSTOM_PERL =
    "оболочка не POSIX-совместима (задан shellPath или префикс) — исключение perl отключено";
  const UNREADABLE_BD = "настройки оболочки нечитаемы или не разобраны — исключение bd отключено";
  const UNREADABLE_PERL =
    "настройки оболочки нечитаемы или не разобраны — исключение perl отключено";
  const UNRESOLVABLE_BD = "каталог настроек агента не определяется — исключение bd отключено";
  const UNRESOLVABLE_PERL = "каталог настроек агента не определяется — исключение perl отключено";
  const noHome = () => {
    throw new Error("no home");
  };

  it("a replica shellPath disables bd and perl, each with its own text", () => {
    const seams = { readFile: bdFs({ [BD_REPLICA]: BD_SHELL }) };
    expect(bashReason("bd list", seams)).toContain(`${BD_NOT_CONFIGURED}${CUSTOM_BD}`);
    expect(bashReason("perl -e 'print 42'", seams)).toContain(`${BD_NOT_CONFIGURED}${CUSTOM_PERL}`);
  });

  it("a shellCommandPrefix in the replica is custom too", () => {
    const seams = {
      readFile: bdFs({ [BD_REPLICA]: JSON.stringify({ shellCommandPrefix: "set -x;" }) }),
    };
    expect(bashReason("bd list", seams)).toContain(CUSTOM_BD);
  });

  it("a PROJECT shellPath disables bd too (merged settings)", () => {
    const seams = { readFile: bdFs({ [BD_PROJECT]: BD_SHELL }) };
    expect(bashReason("bd list", seams)).toContain(CUSTOM_BD);
  });

  it("a PROJECT file that is absent is the stock install: bd passes", () => {
    expect(bash("bd list", { readFile: bdFs({ [BD_PROJECT]: BD_STOCK }) })).toBeUndefined();
    expect(bash("bd list", { readFile: bdFs({}) })).toBeUndefined();
  });

  it("an unreadable replica (EACCES) and broken JSON disable bd with the unreadable text", () => {
    expect(bashReason("bd list", { readFile: bdFs({}, { [BD_REPLICA]: "EACCES" }) })).toContain(
      `${BD_NOT_CONFIGURED}${UNREADABLE_BD}`,
    );
    expect(bashReason("bd list", { readFile: bdFs({ [BD_REPLICA]: "{ broken" }) })).toContain(
      `${BD_NOT_CONFIGURED}${UNREADABLE_BD}`,
    );
    expect(
      bashReason("perl -e 'print 42'", { readFile: bdFs({ [BD_REPLICA]: "{ broken" }) }),
    ).toContain(`${BD_NOT_CONFIGURED}${UNREADABLE_PERL}`);
  });

  it("an unreadable PROJECT file (EACCES, broken JSON) disables bd", () => {
    expect(bashReason("bd list", { readFile: bdFs({}, { [BD_PROJECT]: "EACCES" }) })).toContain(
      UNREADABLE_BD,
    );
    expect(bashReason("bd list", { readFile: bdFs({ [BD_PROJECT]: "{ nope" }) })).toContain(
      UNREADABLE_BD,
    );
  });

  it("the replica ENOENT is the stock install: bd is allowed", () => {
    expect(bash("bd list", { readFile: bdFs({}) })).toBeUndefined();
  });

  it("a HOME candidate that is ENOENT means not configured: bd is allowed", () => {
    expect(bash("bd list", { env: { HOME: "/home/other" }, readFile: bdFs({}) })).toBeUndefined();
  });

  it("a HOME candidate with shellPath disables bd while the replica is ENOENT", () => {
    const seams = {
      env: { HOME: "/home/other" },
      readFile: bdFs({ "/home/other/.pi/agent/settings.json": BD_SHELL }),
    };
    expect(bashReason("bd list", seams)).toContain(CUSTOM_BD);
  });

  it("a HOME candidate that fails with EACCES fails closed for bd", () => {
    const seams = {
      env: { HOME: "/home/other" },
      readFile: bdFs({}, { "/home/other/.pi/agent/settings.json": "EACCES" }),
    };
    expect(bashReason("bd list", seams)).toContain(UNREADABLE_BD);
  });

  it("an unresolvable agent dir disables bd and perl with their own texts", () => {
    expect(bashReason("bd list", { homedir: noHome })).toContain(
      `${BD_NOT_CONFIGURED}${UNRESOLVABLE_BD}`,
    );
    expect(bashReason("perl -e 'print 42'", { homedir: noHome })).toContain(
      `${BD_NOT_CONFIGURED}${UNRESOLVABLE_PERL}`,
    );
    expect(bashReason("bd list", { homedir: () => "" })).toContain(UNRESOLVABLE_BD);
  });

  it("an unresolvable dir with a custom project file still says custom", () => {
    const seams = { homedir: noHome, readFile: bdFs({ [BD_PROJECT]: BD_SHELL }) };
    expect(bashReason("bd list", seams)).toContain(CUSTOM_BD);
  });

  it("a stock install lets bd and perl through", () => {
    expect(bash("bd list")).toBeUndefined();
    expect(bash("perl -e 'print 42'")).toBeUndefined();
  });
});

describe("lead restrictions: the child session stays inert for bash bd, write and edit (design §6.5.4)", () => {
  it("a child worker (isLeadSession = false) passes bd, write and edit", () => {
    const lead = () => false;
    expect(gateCall("bash", { command: "bd list" }, {}, lead)).toBeUndefined();
    expect(gateCall("bash", { command: "bd init" }, {}, lead)).toBeUndefined();
    expect(gateCall("write", { path: "/proj/src/a.ts" }, {}, lead)).toBeUndefined();
    expect(gateCall("edit", { path: "/proj/src/a.ts" }, {}, lead)).toBeUndefined();
  });

  it("PI_SUBAGENT_CHILD=1 makes the default lead check false: bd passes", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const host = makeHost();
    registerLeadRestrictions(host.api, { isEnabled: () => true });
    expect(
      host.fire("tool_call", {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "bd list" },
      }),
    ).toBeUndefined();
  });
});

describe("lead restrictions: the design §6.7 refusal texts are byte-exact (tasks 8.5)", () => {
  const PREFIX = "Причина исключения: ";
  /** The text after the gate's "Причина исключения: " prefix; the whole reason must end here. */
  const causeOf = (verdict: Verdict): string => {
    const reason = verdict?.reason ?? "";
    expect(reason, reason).toContain(PREFIX);
    return reason.slice(reason.indexOf(PREFIX) + PREFIX.length);
  };
  const MERGED_UNIFIED =
    "разрешены только одиночный вызов perl или одиночная команда bd (create/show/list/ready/update/close) — первый токен не perl и не bd";
  const SHELL = JSON.stringify({ shellPath: "pwsh.exe" });

  it("bd: the subcommand text, the merged text for other first words, the empty command", () => {
    expect(causeOf(bash("bd init"))).toBe(
      "не одиночный вызов bd — argv[1] — не подкоманда из списка create/show/list/ready/update/close",
    );
    expect(causeOf(bash("ls"))).toBe(MERGED_UNIFIED);
    expect(causeOf(bash("cat x | perl -e 'y'"))).toBe(MERGED_UNIFIED);
    expect(causeOf(bash("echo x && bd list"))).toBe(MERGED_UNIFIED);
    expect(causeOf(bash("   "))).toBe(
      "разрешены только одиночный вызов perl или одиночная команда bd (create/show/list/ready/update/close) — пустая команда",
    );
    expect(causeOf(gateCall("bash", {}))).toBe(
      "у вызова нет команды — исключения perl и bd не применяются",
    );
  });

  it("the # reason is the same string for perl and bd", () => {
    const HASH = 'неквотированный "#" вне кавычек (комментарий оболочки)';
    expect(causeOf(bash("perl -e 'x' # note"))).toBe(`не одиночный вызов perl — ${HASH}`);
    expect(causeOf(bash("bd list x # note"))).toBe(`не одиночный вызов bd — ${HASH}`);
  });

  it("shellPath: the perl text is the rev.3 text; the bd text is its own", () => {
    const seams = { readFile: bdFs({ [BD_REPLICA]: SHELL }) };
    expect(causeOf(bash("perl -e 'print 42'", seams))).toBe(
      "оболочка не POSIX-совместима (задан shellPath или префикс) — исключение perl отключено",
    );
    expect(causeOf(bash("bd list", seams))).toBe(
      "оболочка не POSIX-совместима (задан shellPath или префикс) — исключение bd отключено",
    );
  });

  it("unreadable settings and an unresolvable agent dir each have their own bd text", () => {
    expect(causeOf(bash("bd list", { readFile: bdFs({}, { [BD_REPLICA]: "EACCES" }) }))).toBe(
      "настройки оболочки нечитаемы или не разобраны — исключение bd отключено",
    );
    expect(causeOf(bash("bd list", { homedir: () => "" }))).toBe(
      "каталог настроек агента не определяется — исключение bd отключено",
    );
  });
});

/* ------------------------------------------------------------------ */
/* git gate at the bash gate (fusion-git-gate; design §1, §2, FR-006)  */
/* ------------------------------------------------------------------ */

const GIT_NOT_SINGLE = "Причина исключения: не одиночный вызов git — ";
const CUSTOM_GIT =
  "оболочка не POSIX-совместима (задан shellPath или префикс) — исключение git отключено";

/** The table reason of one git subcommand row (design §2). */
function gitRuleReason(sub: string): string {
  const rule = GIT_RULES.find((row) => row.sub === sub);
  if (rule === undefined) throw new Error(`no GIT_RULES row for ${sub}`);
  return rule.reason;
}

describe("lead restrictions: bash git gate allows ordinary git on a stock install (design §2, FR-002)", () => {
  it.each([
    "git status",
    "git log --oneline -5",
    "git diff --cached",
    "git add extensions/a.ts",
    "git add .",
    'git commit -m "feat: x"',
    "git commit -a -m x",
    "git push origin main",
    "git push -u origin main",
    "git pull --rebase",
    "git fetch origin",
    "git checkout -b feat",
    "git switch -c feat",
    "git stash list",
    "git remote -v",
    "git restore --staged f",
    "git worktree list",
    "git merge --no-edit main",
  ])("%s passes", (command) => {
    expect(bash(command)).toBeUndefined();
  });
});

describe("lead restrictions: bash git gate refuses with the table reason (design §2, FR-003..FR-005)", () => {
  it.each([
    ["git push --force origin main", "push"],
    ["git push origin +main", "push"],
    ["git push origin :main", "push"],
    ["git reset --hard", "reset"],
    ["git checkout -f main", "checkout"],
    ["git clean -fd", "clean"],
    ["git branch -D x", "branch"],
    ["git commit --amend -m x", "commit"],
    ["git commit", "commit"],
    ["git rebase -i HEAD", "rebase"],
    ["git rm x", "rm"],
  ])("%s names the %s row", (command, sub) => {
    expect(bashReason(command)).toContain(`${GIT_NOT_SINGLE}${gitRuleReason(sub)}`);
  });

  it("a chain, a substitution or a global option keeps the classifier's reason", () => {
    expect(bashReason("git status; rm -rf x")).toContain(
      `${GIT_NOT_SINGLE}метасимвол ";" вне кавычек`,
    );
    expect(bashReason("git status $(id)")).toContain(`${GIT_NOT_SINGLE}метасимвол "$" вне кавычек`);
    expect(bashReason("git -C /tmp status")).toContain(
      `${GIT_NOT_SINGLE}глобальные опции git до подкоманды запрещены`,
    );
  });
});

describe("lead restrictions: a non-stock shell disables the git classification (design §6.5.3 pattern)", () => {
  it("a replica shellPath refuses git with the git text, even for an allowed form", () => {
    const seams = { readFile: bdFs({ [BD_REPLICA]: BD_SHELL }) };
    expect(bashReason("git status", seams)).toContain(`Причина исключения: ${CUSTOM_GIT}`);
  });

  it("a stock shell lets the same allowed git call through", () => {
    expect(bash("git status", { readFile: bdFs({ [BD_REPLICA]: BD_STOCK }) })).toBeUndefined();
  });
});

describe("lead restrictions: the git gate is inert when fusion is off or in a child (FR-006)", () => {
  it("a child worker passes a forbidden git call", () => {
    expect(
      gateCall("bash", { command: "git push --force origin main" }, {}, () => false),
    ).toBeUndefined();
  });

  it("fusion off passes a forbidden git call", () => {
    const host = makeHost();
    registerLeadRestrictions(host.api, {
      isEnabled: () => false,
      isLeadSession: () => true,
      projectRoot: () => "/proj",
      shellSettingsContext: () => hermeticShell(),
    });
    const verdict = host.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git push --force origin main" },
      },
      { cwd: "/proj" },
    );
    expect(verdict).toBeUndefined();
  });
});
