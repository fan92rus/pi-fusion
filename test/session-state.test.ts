import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_ENTRY_TYPE,
  applySessionStart,
  getSessionActivation,
  isSessionEnabled,
  resetForTests,
  setActivationEnvSource,
  setSessionEnabled,
} from "../extensions/pi-fusion/session-state.ts";

function makeSm(sessionId: string, branch: any[] = []) {
  return {
    getSessionId: () => sessionId,
    getBranch: () => branch,
  };
}

function entry(owner: string, enabled: boolean, _branch = "main") {
  return { type: "custom", customType: ACTIVATION_ENTRY_TYPE, data: { owner, enabled, ts: 1 } };
}

describe("session-state", () => {
  beforeEach(() => resetForTests());

  it("set/get returns enabled+source", () => {
    const sm = makeSm("s1");
    const pi = { appendEntry: vi.fn() };
    setSessionEnabled(pi as any, sm as any, true);
    const act = getSessionActivation(sm as any);
    expect(act).toEqual({ enabled: true, source: "memory" });
    expect(isSessionEnabled(sm as any)).toBe(true);
  });

  it("owner filter: own record applies, foreign ignored", () => {
    const branch = [entry("other", true), entry("s1", false)];
    const sm = makeSm("s1", branch as any);
    const act = getSessionActivation(sm as any);
    expect(act).toEqual({ enabled: false, source: "history" });
  });

  it("fork reproduction: parent on -> fork with foreign on -> off", () => {
    const branch = [entry("parent", true)];
    const sm = makeSm("child", branch as any);
    const act = getSessionActivation(sm as any);
    expect(act).toEqual({ enabled: false, source: "default-off" });
  });

  it("restore only from active branch (getBranch), record on other branch ignored", () => {
    const getBranch = vi.fn(() => [] as any[]);
    const sm = { getSessionId: () => "s1", getBranch };
    const act = getSessionActivation(sm as any);
    expect(act).toEqual({ enabled: false, source: "default-off" });
    expect(getBranch).toHaveBeenCalled();
  });

  it("empty history -> default-off cached", () => {
    const sm = makeSm("s1", []);
    const a1 = getSessionActivation(sm as any);
    const a2 = getSessionActivation(sm as any);
    expect(a1).toEqual({ enabled: false, source: "default-off" });
    expect(a2).toBe(a1);
  });

  it("last applicable wins", () => {
    const branch = [entry("s1", true), entry("s1", false), entry("s1", true)];
    const sm = makeSm("s1", branch as any);
    const act = getSessionActivation(sm as any);
    expect(act).toEqual({ enabled: true, source: "history" });
  });

  it("restore overwrites source memory->history on reload", () => {
    const sm = makeSm("s1", [entry("s1", true)]);
    const pi = { appendEntry: vi.fn() };
    // seed memory
    setSessionEnabled(pi as any, makeSm("s1", []) as any, true);
    // now reload with history
    const act = applySessionStart(pi as any, sm as any);
    expect(act).toEqual({ enabled: true, source: "history" });
    expect(getSessionActivation(sm as any)).toEqual({ enabled: true, source: "history" });
  });

  it("env: 1 -> on source env + immediate appendEntry with owner=sessionId", () => {
    const sm = makeSm("s1", []);
    const pi = { appendEntry: vi.fn() };
    const act = applySessionStart(pi as any, sm as any, { env: "1", now: () => 42 });
    expect(act).toEqual({ enabled: true, source: "env" });
    expect(pi.appendEntry).toHaveBeenCalledWith(ACTIVATION_ENTRY_TYPE, {
      owner: "s1",
      enabled: true,
      ts: 42,
    });
  });

  it("after env activation second restore goes history path", () => {
    const sm = makeSm("s1", []);
    const pi = { appendEntry: vi.fn() };
    applySessionStart(pi as any, sm as any, { env: "1", now: () => 42 });
    // now branch contains the written record
    const branch = [entry("s1", true)];
    const _sm2 = makeSm("s1", branch as any);
    // cache already has env; clear by reset? Instead use new sid? Use reset
    resetForTests();
    const pi2 = { appendEntry: vi.fn() };
    applySessionStart(pi2 as any, sm as any, { env: "1" }); // writes record into? sm branch still empty
    // simulate persisted: build sm with record
    const sm3 = makeSm("s1", [entry("s1", true)]);
    resetForTests();
    // seed cache via env? no. Direct restore
    const act = getSessionActivation(sm3 as any);
    expect(act.source).toBe("history");
  });

  it("env true/yes (case-insensitive) works", () => {
    for (const v of ["true", "TRUE", "Yes", "yes"]) {
      resetForTests();
      const sm = makeSm(`s${v}`, []);
      const pi = { appendEntry: vi.fn() };
      const act = applySessionStart(pi as any, sm as any, { env: v });
      expect(act).toEqual({ enabled: true, source: "env" });
    }
  });

  it("empty env = not set without warn", () => {
    const sm = makeSm("s1", []);
    const pi = { appendEntry: vi.fn() };
    const warn = vi.fn();
    const act = applySessionStart(pi as any, sm as any, { env: "", warn });
    expect(act).toEqual({ enabled: false, source: "default-off" });
    expect(warn).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("'x' env -> warn and default-off", () => {
    const sm = makeSm("s1", []);
    const pi = { appendEntry: vi.fn() };
    const warn = vi.fn();
    const act = applySessionStart(pi as any, sm as any, { env: "x", warn });
    expect(act).toEqual({ enabled: false, source: "default-off" });
    expect(warn).toHaveBeenCalled();
  });

  it("explicit off record wins over env on reload", () => {
    const branch = [entry("s1", false)];
    const sm = makeSm("s1", branch as any);
    const pi = { appendEntry: vi.fn() };
    const act = applySessionStart(pi as any, sm as any, { env: "1" });
    expect(act).toEqual({ enabled: false, source: "history" });
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("idempotent set does not write entry and compares with lazily restored", () => {
    const branch = [entry("s1", true)];
    const sm = makeSm("s1", branch as any);
    const pi = { appendEntry: vi.fn() };
    // first restore
    getSessionActivation(sm as any);
    setSessionEnabled(pi as any, sm as any, true);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("set writes entry when value differs", () => {
    const sm = makeSm("s1", []);
    const pi = { appendEntry: vi.fn() };
    setSessionEnabled(pi as any, sm as any, true, { now: 7 });
    expect(pi.appendEntry).toHaveBeenCalledWith(ACTIVATION_ENTRY_TYPE, {
      owner: "s1",
      enabled: true,
      ts: 7,
    });
    expect(getSessionActivation(sm as any)).toEqual({ enabled: true, source: "memory" });
  });

  it("idempotent off in disabled session no write", () => {
    const sm = makeSm("s1", []);
    const pi = { appendEntry: vi.fn() };
    setSessionEnabled(pi as any, sm as any, false);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("two sessionIds isolated", () => {
    const pi = { appendEntry: vi.fn() };
    const smA = makeSm("A", []);
    const smB = makeSm("B", []);
    setSessionEnabled(pi as any, smA as any, true);
    expect(isSessionEnabled(smA as any)).toBe(true);
    expect(isSessionEnabled(smB as any)).toBe(false);
  });

  it("getBranch throws propagates from getSessionActivation", () => {
    const sm = {
      getSessionId: () => "s1",
      getBranch: () => {
        throw new Error("boom");
      },
    };
    expect(() => getSessionActivation(sm as any)).toThrow("boom");
  });

  it("resetForTests clears store", () => {
    const sm = makeSm("s1", []);
    const pi = { appendEntry: vi.fn() };
    setSessionEnabled(pi as any, sm as any, true);
    resetForTests();
    const act = getSessionActivation(sm as any);
    expect(act).toEqual({ enabled: false, source: "default-off" });
  });

  it("env module setter works", () => {
    // use module setter
    setActivationEnvSource(() => "yes");
    const sm = makeSm("sX", []);
    const pi = { appendEntry: vi.fn() };
    const act = applySessionStart(pi as any, sm as any);
    expect(act).toEqual({ enabled: true, source: "env" });
    resetForTests();
  });
});
