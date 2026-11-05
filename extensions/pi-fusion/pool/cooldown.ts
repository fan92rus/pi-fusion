/**
 * The cooldown core (openspec/changes/fusion-model-cooldown, design D1 "New
 * core pool/cooldown.ts" and D2 "Parser retry-after"; spec requirements
 * "Immediate cooldown on a window error or timeout", "Duration cooldown is
 * taken from the error", "Cooldown is process state", "Repeat error does not
 * shorten the cooldown", "Visibility of cooldowns to the operator").
 *
 * The store is `Map<model, {until, reason}>` behind a factory: `createCooldownStore()`
 * hands out an independent instance, so tests and the pool/command wiring each
 * own one (D8 "store isolation"). The production singleton is NOT created here —
 * index.ts calls the factory once (task 2.2) and passes that same store to
 * `runFanout`'s deps and to the status command, which is what makes a cooldown
 * survive across `fusion_delegate` calls and `/fusion on|off` toggles while a
 * pi restart drops the module and with it every cooldown.
 *
 * Time never comes from Date.now inside this module: every entry point takes an
 * explicit `at` (milliseconds) produced by a `Clock`, so tests drive virtual
 * clocks and production reads `defaultClock` (D1 clock injection).
 *
 * What stays OUT of this module on purpose: the clamp of a parsed duration to
 * `FUSION_CONFIG_BOUNDS.modelCooldownMs` (applied at the fan-out integration
 * site, task 2.2), the pickModel skip, the cooldown width factor and the
 * fail-fast refusal (pool/fanout.ts), and the `/fusion status` rendering beyond
 * one number → one string (`formatCooldownRemaining`).
 */

/** A time source: production reads wall time, tests inject virtual clocks (D1). */
export interface Clock {
  now(): number;
}

/** The production clock; the wiring in index.ts reads this one (task 2.2). */
export const defaultClock: Clock = { now: () => Date.now() };

/** Why a model is cooling: a quota/rate-limit host error, or a timeout (D1). */
export type CooldownReason = "window" | "timeout";

/** One cooling model as the scheduler, the width factor and the status read it. */
export interface CooldownEntry {
  model: string;
  reason: CooldownReason;
  remainingMs: number;
}

/**
 * The cooldown store: one entry per model, `until` is the instant the cooldown
 * ends and `reason` is the reason of the error that last refreshed it. Design
 * D1's standalone `sweep(store, now)` is folded into `activeCooldowns`: reading
 * a rotation subset prunes the entries that have already expired in it.
 */
export interface CooldownStore {
  /**
   * Records `until = at + durationMs`. Re-offense rule (spec "Repeat error does
   * not shorten the cooldown"): while a cooldown is still active (`until > at`)
   * a new one never moves `until` back, it can only push it further out —
   * `until = max(current until, at + durationMs)` — and the reason always takes
   * the latest error.
   */
  enterCooldown(model: string, reason: CooldownReason, durationMs: number, at: number): void;
  /**
   * The cooling models inside `models` (the effective rotation), in that order,
   * each with its remainder `until - at`. Expired entries of the listed models
   * are removed on the fly (sweep semantics); models outside the list stay
   * untouched, so a cooldown can never be reported for a model the caller did
   * not ask about. `models` is expected to be unique, as every rotation is.
   */
  activeCooldowns(models: readonly string[], at: number): CooldownEntry[];
  /** Pure read: `until > at`, never prunes and never records. */
  isCooling(model: string, at: number): boolean;
}

export function createCooldownStore(): CooldownStore {
  const entries = new Map<string, { until: number; reason: CooldownReason }>();

  return {
    enterCooldown(model, reason, durationMs, at) {
      const until = at + durationMs;
      const current = entries.get(model);
      // An expired entry is not a cooldown any more, so it is replaced outright;
      // an active one is only ever extended, never shortened (the max rule).
      const kept =
        current !== undefined && current.until > at ? Math.max(current.until, until) : until;
      entries.set(model, { until: kept, reason });
    },
    activeCooldowns(models, at) {
      const rows: CooldownEntry[] = [];
      for (const model of models) {
        const entry = entries.get(model);
        if (entry === undefined) continue;
        if (entry.until <= at) {
          // Sweep: the cooldown is over, so the model goes back to the rotation.
          entries.delete(model);
          continue;
        }
        rows.push({ model, reason: entry.reason, remainingMs: entry.until - at });
      }
      return rows;
    },
    isCooling(model, at) {
      const entry = entries.get(model);
      return entry !== undefined && entry.until > at;
    },
  };
}

/**
 * Words that make a bare duration a retry-after rather than a random number
 * (D2 "single Ns/Nm/Nh after trigger words — so as not to catch random
 * numbers"). A trigger must be a whole word in the window right before the
 * duration; "in" on its own is NOT a trigger, so "error 500 in 30s" stays
 * unmatched.
 */
const TRIGGER_WORDS = new Set(["retry", "wait", "again", "try", "back"]);
/** How far back a trigger may sit: 48 characters and at most 4 words. */
const TRIGGER_WINDOW_CHARS = 48;
const TRIGGER_WINDOW_WORDS = 4;

/**
 * One duration token: a whole or decimal number, an optional space/tab, then a
 * time unit. Units are ordered longest-first and must not be followed by
 * another letter, which keeps `30mb` out while still allowing the compounds
 * `1m30s` and `2m 15s`; the token repeats with spaces/tabs in between, so a
 * chain like `1h 20m 30s` is ONE duration, not three.
 */
const UNIT_SOURCE = "hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s";
const DURATION_PATTERN = new RegExp(
  String.raw`(?:\d+(?:\.\d+)?[ \t]*(?:${UNIT_SOURCE})(?![a-z])[ \t]*)+`,
  "gi",
);
/** Splits a matched chain back into `<number><unit>` pieces for the sum. */
const UNIT_VALUE_PATTERN = new RegExp(
  String.raw`(\d+(?:\.\d+)?)[ \t]*(${UNIT_SOURCE})(?![a-z])`,
  "gi",
);

/** Milliseconds of one `<number><unit>` piece; the unit's first letter is enough. */
function pieceToMs(amountText: string, unitText: string): number {
  const scale = unitText.toLowerCase().startsWith("h")
    ? 3_600_000
    : unitText.toLowerCase().startsWith("m")
      ? 60_000
      : 1_000;
  return Number(amountText) * scale;
}

/** Sums a matched duration chain: `1h5m` -> 3 900 000, `1.5m` -> 90 000. */
function chainToMs(chain: string): number {
  let total = 0;
  for (const piece of chain.matchAll(UNIT_VALUE_PATTERN)) {
    const amount = piece[1];
    const unit = piece[2];
    if (amount === undefined || unit === undefined) continue;
    total += pieceToMs(amount, unit);
  }
  return total;
}

/** Is there a trigger word just before this candidate? (the false-positive guard) */
function triggerBefore(text: string, before: number): boolean {
  const window = text.slice(Math.max(0, before - TRIGGER_WINDOW_CHARS), before);
  const words = window.match(/[a-z]+/gi);
  if (words === null) return false;
  return words.slice(-TRIGGER_WINDOW_WORDS).some((word) => TRIGGER_WORDS.has(word.toLowerCase()));
}

/**
 * The retry-after parser (D2): the cooldown length in milliseconds read from a
 * host-error text, or undefined when the text carries no retry-after-like time.
 * Case-insensitive; whole words only; decimals allowed (`1.5 minutes` -> 90 000);
 * compound chains summed (`retry after 1m30s` -> 90 000).
 *
 * Deterministic when several durations appear: the LEFTMOST duration that passes
 * the trigger guard wins (first match wins) — an untriggered candidate only
 * skips itself, so "error 500 in 30s; retry after 7m" still yields 420 000. A
 * zero-length duration ("retry in 0s") is no cooldown and is skipped too.
 *
 * The value is returned RAW: no clamping to FUSION_CONFIG_BOUNDS.modelCooldownMs
 * here, the parser stays pure and the fan-out site clamps at the moment of use.
 */
export function parseRetryAfterMs(text: string): number | undefined {
  for (const match of text.matchAll(DURATION_PATTERN)) {
    const chain = match[0];
    if (chain === undefined) continue;
    if (!triggerBefore(text, match.index)) continue;
    const ms = chainToMs(chain);
    if (ms > 0) return ms;
  }
  return undefined;
}

/**
 * A cooldown remainder as written into `/fusion status` (spec "Status with a
 * cooling model": 42 500ms -> "43s"): whole seconds rounded up, never negative.
 */
export function formatCooldownRemaining(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}
