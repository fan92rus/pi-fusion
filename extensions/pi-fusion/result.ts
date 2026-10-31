/**
 * The fan-out result's lead-facing surfaces (design rev.5.2 §4 Result,
 * §7 UX; FR-005/FR-010). The pool (pool/fanout.ts) assembles the structured
 * FanoutResult — rows pinned to the task indexes, terminal-only usage sums,
 * usagePartial; this module renders the TEXT the lead reads: one
 * `id · status · summary · files` row per task in index order, one line per
 * binding clamp, and one usage line that flags unknown totals with
 * «часть usage неизвестна» (absent terminal usage is unknown, never 0),
 * plus the brief `details` line the tool result carries alongside
 * structuredContent and the text.
 */
import type { FanoutResult, UsageTotals } from "./types.ts";

/** Usage fields in their fixed render order (FR-010); only present ones. */
const USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
  "turns",
  "toolCalls",
  "durationMs",
] as const;

/** Status tallies in their fixed details order; zero counts are omitted. */
const STATUSES = ["done", "no_changes", "needs_orchestrator", "failed", "cancelled"] as const;

/** «часть usage неизвестна» — the design §4 wording for partial totals. */
const USAGE_PARTIAL_NOTE = "часть usage неизвестна";

function renderUsageLine(usage: UsageTotals, usagePartial: boolean): string {
  const parts: string[] = [];
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (value !== undefined) {
      parts.push(`${field}=${String(value)}`);
    }
  }
  const body = parts.length === 0 ? "usage: unknown" : `usage: ${parts.join(", ")}`;
  return usagePartial ? `${body} · ${USAGE_PARTIAL_NOTE}` : body;
}

/**
 * The text view: task rows in index order (the pool guarantees the order;
 * FR-005), then the clamp reasons, then the usage line. A task retried by
 * FR-007 carries an attempt suffix on its id — the seam's per-attempt model
 * is not part of TaskResult, so only the number renders (design §7).
 */
export function renderFanoutText(result: FanoutResult): string {
  const lines: string[] = [];
  for (const row of result.results) {
    const id = row.attempts > 1 ? `${row.id} (попытка ${row.attempts})` : row.id;
    const files = row.filesChanged.length > 0 ? row.filesChanged.join(", ") : "-";
    lines.push(`${id} · ${row.status} · ${row.summary} · ${files}`);
  }
  for (const clamp of result.clamps) {
    lines.push(`clamp ${clamp.field}: ${clamp.requested} → ${clamp.applied} (${clamp.reason})`);
  }
  lines.push(renderUsageLine(result.usage, result.usagePartial));
  return lines.join("\n");
}

/** The `details` field: a one-line tally of the statuses and usage honesty. */
export function summarizeFanout(result: FanoutResult): string {
  const counts: string[] = [];
  for (const status of STATUSES) {
    const count = result.results.filter((row) => row.status === status).length;
    if (count > 0) {
      counts.push(`${count} ${status}`);
    }
  }
  const partial = result.usagePartial ? "; usage partial" : "";
  return `${result.results.length} task(s): ${counts.join(", ")}${partial}`;
}
