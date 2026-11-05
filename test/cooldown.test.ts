/**
 * Cooldown core (openspec/changes/fusion-model-cooldown: design D1 "New core
 * pool/cooldown.ts" + the Clock injection, D2 "Parser retry-after", D8 "Tests
 * (TDD, red pins first)"; spec requirements "Duration cooldown is taken from
 * the error", "Repeat error does not shorten the cooldown", "Cooldown
 * visibility to the operator").
 *
 * Written BEFORE the implementation (TDD red), so every pin here is the frozen
 * spec translated to numbers:
 *  - the trigger set is exactly retry|wait|again|try|back and "in" alone is NOT
 *    a trigger — "error 500 in 30s" must stay undefined (D2: no random numbers);
 *  - the parser is raw: values outside FUSION_CONFIG_BOUNDS.modelCooldownMs come
 *    back unclamped, clamping is the fan-out integration site's job (task 2.2);
 *  - the store never shortens an active cooldown (max rule) and the reason follows
 *    the latest error; the expiry boundary is exclusive (until === at is over);
 *  - createCooldownStore() is a factory: two stores share nothing, and the
 *    production singleton (task 2.2) is one factory call wired in index.ts.
 */
import { describe, expect, it } from "vitest";
import {
  type Clock,
  type CooldownEntry,
  createCooldownStore,
  defaultClock,
  formatCooldownRemaining,
  parseRetryAfterMs,
} from "../extensions/pi-fusion/pool/cooldown.ts";

describe("cooldown: parseRetryAfterMs (design D2)", () => {
  it("seconds: try again in N s/sec/secs/seconds (case-insensitive)", () => {
    expect(parseRetryAfterMs("try again in 90 seconds")).toBe(90_000);
    expect(parseRetryAfterMs("Please retry after 45 sec.")).toBe(45_000);
    expect(parseRetryAfterMs("Please try again in 7 secs")).toBe(7_000);
    expect(parseRetryAfterMs("wait 30s")).toBe(30_000);
    expect(parseRetryAfterMs("Too Many Requests — TRY AGAIN IN 20 SECONDS")).toBe(20_000);
  });

  it("minutes: retry after N m/min/mins/minutes", () => {
    expect(parseRetryAfterMs("retry after 10 minutes")).toBe(600_000);
    expect(parseRetryAfterMs("retry after 2 min")).toBe(120_000);
    expect(parseRetryAfterMs("please retry after 3 mins")).toBe(180_000);
    expect(parseRetryAfterMs("please wait 15m")).toBe(900_000);
    expect(parseRetryAfterMs("Rate limit reached. Please retry after 1 minute.")).toBe(60_000);
  });

  it("hours: retry in N h/hr/hrs/hours", () => {
    expect(parseRetryAfterMs("retry in 2 hours")).toBe(7_200_000);
    expect(parseRetryAfterMs("try again in 1 hour")).toBe(3_600_000);
    expect(parseRetryAfterMs("please retry in 3 hrs")).toBe(10_800_000);
    expect(parseRetryAfterMs("wait 1h")).toBe(3_600_000);
  });

  it("compound forms: 1m30s, 2m 15s, 1h5m, 90s, 1.5m", () => {
    expect(parseRetryAfterMs("retry after 1m30s")).toBe(90_000);
    expect(parseRetryAfterMs("retry in 2m 15s")).toBe(135_000);
    expect(parseRetryAfterMs("try again in 1h5m")).toBe(3_900_000);
    expect(parseRetryAfterMs("retry after 90s")).toBe(90_000);
    expect(parseRetryAfterMs("try again in 1.5m")).toBe(90_000);
    expect(parseRetryAfterMs("try again in 1h 20m 30s")).toBe(4_830_000);
  });

  it("decimal values: 1.5 minutes -> 90000", () => {
    expect(parseRetryAfterMs("try again in 1.5 minutes")).toBe(90_000);
    expect(parseRetryAfterMs("retry after 0.5h")).toBe(1_800_000);
    expect(parseRetryAfterMs("wait 0.25 hours")).toBe(900_000);
  });

  it("the bare-unit form needs a trigger word within a short window", () => {
    // every member of the frozen trigger set drives the bare unit home
    expect(parseRetryAfterMs("retry 40s")).toBe(40_000);
    expect(parseRetryAfterMs("wait 40s")).toBe(40_000);
    expect(parseRetryAfterMs("try again 40s")).toBe(40_000);
    expect(parseRetryAfterMs("please back off 40s")).toBe(40_000);
  });

  it("false-positive guards: no trigger, so no duration", () => {
    // "in" alone is NOT a trigger (the frozen guard pin)
    expect(parseRetryAfterMs("error 500 in 30s")).toBeUndefined();
    expect(parseRetryAfterMs("403 Forbidden")).toBeUndefined();
    expect(parseRetryAfterMs("quota exceeded, plan limit reached")).toBeUndefined();
    expect(parseRetryAfterMs("Please retry later")).toBeUndefined();
    expect(parseRetryAfterMs("Server overloaded, try again later")).toBeUndefined();
    expect(parseRetryAfterMs("60 requests per minute")).toBeUndefined();
    // a trigger must be a whole word, not a substring of one
    expect(parseRetryAfterMs("the entry takes 30s to warm up")).toBeUndefined();
    expect(parseRetryAfterMs("await 10s for the promise")).toBeUndefined();
    // and it must be near the duration, not anywhere in the text
    expect(parseRetryAfterMs("retry is possible; the warm-up costs 30s")).toBeUndefined();
  });

  it("no duration at all -> undefined", () => {
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("42")).toBeUndefined();
    expect(parseRetryAfterMs("too many requests (429)")).toBeUndefined();
    expect(parseRetryAfterMs("30mb of context")).toBeUndefined();
  });

  it("first match wins; an untriggered duration only skips itself", () => {
    expect(parseRetryAfterMs("retry after 10s, then try again in 5m")).toBe(10_000);
    // the untriggered "30s" is not a match, so the scan continues to "7m"
    expect(parseRetryAfterMs("error 500 in 30s; retry after 7m")).toBe(420_000);
  });

  it("the parser never clamps (the fan-out site owns FUSION_CONFIG_BOUNDS.modelCooldownMs)", () => {
    expect(parseRetryAfterMs("retry after 2 hours")).toBe(7_200_000); // > 3_600_000
    expect(parseRetryAfterMs("retry in 1s")).toBe(1_000); // < 30_000
    expect(parseRetryAfterMs("try again in 999999999 seconds")).toBe(999_999_999_000);
  });

  it("a retry-after header shape is a duration too", () => {
    expect(parseRetryAfterMs("HTTP 403, retry-after: 120s")).toBe(120_000);
  });
});

describe("cooldown: store (design D1)", () => {
  it("enterCooldown records until = at + durationMs and reports it back", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-a", "window", 90_000, 1_000);
    expect(store.isCooling("model-a", 1_000)).toBe(true);
    expect(store.activeCooldowns(["model-a", "model-b"], 1_000)).toStrictEqual([
      { model: "model-a", reason: "window", remainingMs: 90_000 },
    ]);
  });

  it("activeCooldowns reads only the given rotation subset, in that order", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-c", "timeout", 60_000, 0);
    store.enterCooldown("model-b", "window", 30_000, 0);
    expect(store.activeCooldowns(["model-b", "model-a"], 0)).toStrictEqual([
      { model: "model-b", reason: "window", remainingMs: 30_000 },
    ]);
    expect(store.isCooling("model-c", 0)).toBe(true); // recorded, just outside the subset
  });

  it("until === at is over: not active, and the entry is pruned", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-a", "window", 5_000, 0);
    expect(store.activeCooldowns(["model-a"], 5_000)).toStrictEqual([]);
    expect(store.isCooling("model-a", 5_000)).toBe(false);
    // the prune is observable: time-travelling back finds nothing left
    expect(store.isCooling("model-a", 1_000)).toBe(false);
    // a later offence replaces the swept entry instead of maxing with it
    store.enterCooldown("model-a", "timeout", 1_000, 5_000);
    expect(store.activeCooldowns(["model-a"], 5_000)).toStrictEqual([
      { model: "model-a", reason: "timeout", remainingMs: 1_000 },
    ]);
  });

  it("until > at is active; remainingMs = until - at", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-a", "timeout", 10_000, 100); // until 10_100
    expect(store.activeCooldowns(["model-a"], 100)).toStrictEqual([
      { model: "model-a", reason: "timeout", remainingMs: 10_000 },
    ]);
    expect(store.activeCooldowns(["model-a"], 1_100)).toStrictEqual([
      { model: "model-a", reason: "timeout", remainingMs: 9_000 },
    ]);
    expect(store.isCooling("model-a", 10_099)).toBe(true);
    expect(store.isCooling("model-a", 10_100)).toBe(false);
  });

  it("isCooling answers without mutating the store", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-b", "window", 5_000, 1_000); // until 6_000
    expect(store.isCooling("model-b", 10_000)).toBe(false); // expired, but no sweep
    expect(store.activeCooldowns(["model-b"], 5_000)).toStrictEqual([
      { model: "model-b", reason: "window", remainingMs: 1_000 },
    ]); // the entry is still there — isCooling never prunes
  });

  it("a re-offence never shortens the window (max rule) and keeps the reason fresh", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-a", "window", 300_000, 0); // 5m window -> until 300_000
    store.enterCooldown("model-a", "timeout", 30_000, 60_000); // 30s timeout 1m in
    expect(store.activeCooldowns(["model-a"], 60_000)).toStrictEqual([
      { model: "model-a", reason: "timeout", remainingMs: 240_000 },
    ]); // ~4 minutes left, NOT 30 seconds; reason follows the latest error
    store.enterCooldown("model-a", "window", 480_000, 60_000); // 8m extends
    expect(store.activeCooldowns(["model-a"], 60_000)).toStrictEqual([
      { model: "model-a", reason: "window", remainingMs: 480_000 },
    ]);
  });

  it("the reason updates on a same-length re-offence too", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-a", "timeout", 60_000, 0);
    store.enterCooldown("model-a", "window", 60_000, 0);
    expect(store.activeCooldowns(["model-a"], 0)).toStrictEqual([
      { model: "model-a", reason: "window", remainingMs: 60_000 },
    ]);
  });

  it("two stores made by the factory share nothing (test isolation)", () => {
    const poolStore = createCooldownStore();
    const statusStore = createCooldownStore();
    poolStore.enterCooldown("model-a", "window", 60_000, 0);
    expect(statusStore.isCooling("model-a", 0)).toBe(false);
    statusStore.enterCooldown("model-b", "timeout", 60_000, 0);
    expect(poolStore.activeCooldowns(["model-b"], 0)).toStrictEqual([]);
  });

  it("virtual Clocks drive the store; real time is never read", () => {
    let virtualTime = 1_000;
    const clock: Clock = { now: () => virtualTime };
    const store = createCooldownStore();
    store.enterCooldown("model-a", "window", 5_000, clock.now());
    virtualTime = 2_000;
    expect(store.activeCooldowns(["model-a"], clock.now())).toStrictEqual([
      { model: "model-a", reason: "window", remainingMs: 4_000 },
    ]);
    virtualTime = 6_000;
    expect(store.activeCooldowns(["model-a"], clock.now())).toStrictEqual([]);
  });
});

describe("cooldown: defaultClock and /fusion status formatting", () => {
  it("defaultClock is the Date.now singleton (production clock)", () => {
    const floor = Date.now();
    const value = defaultClock.now();
    expect(Number.isFinite(value)).toBe(true);
    expect(value >= floor).toBe(true);
    expect(defaultClock.now() >= value).toBe(true);
  });

  it("formatCooldownRemaining rounds up to whole seconds", () => {
    expect(formatCooldownRemaining(42_500)).toBe("43s");
    expect(formatCooldownRemaining(42_000)).toBe("42s");
    expect(formatCooldownRemaining(0)).toBe("0s");
    expect(formatCooldownRemaining(1)).toBe("1s");
  });

  it("a cooling model's remainder renders through the formatter (42 500ms -> 43s)", () => {
    const store = createCooldownStore();
    store.enterCooldown("model-a", "window", 42_500, 0);
    const rows: CooldownEntry[] = store.activeCooldowns(["model-a", "model-b"], 0);
    expect(
      rows.map((entry) => `${entry.model}:${formatCooldownRemaining(entry.remainingMs)}`),
    ).toStrictEqual(["model-a:43s"]);
  });
});
