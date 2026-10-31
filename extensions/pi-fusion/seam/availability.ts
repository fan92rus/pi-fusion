/**
 * Seam availability (design rev.5.2 §4 `seam/availability.ts`, FR-009
 * pre-flight): the delegation seam is usable only when the host exposes an
 * event bus — requests are emitted and answers arrive on `pi.events`. Without
 * the bus no request can be sent or answered, so the whole fan-out is refused
 * before any task starts.
 */

/** The `pi.events` surface the seam uses: `on` (subscribe) and `emit`. */
export function isSeamAvailable(pi: { readonly events?: unknown } | undefined): boolean {
  const events = pi?.events as { on?: unknown; emit?: unknown } | null | undefined;
  return typeof events?.on === "function" && typeof events.emit === "function";
}
