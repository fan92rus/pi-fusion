/**
 * Session-only activation state for fusion (design §3, §6; requirements
 * FR-002/FR-003/FR-006/FR-008 of openspec/changes/fusion-session-activation).
 *
 * Runtime map `sessionId -> SessionActivation` in process memory, restored
 * lazily from the active branch of the session history (owner-filtered).
 */

export type ActivationSource = "memory" | "history" | "env" | "default-off";

export type SessionActivation = { enabled: boolean; source: ActivationSource };

export const ACTIVATION_ENTRY_TYPE = "pi-fusion.activation";

export interface SessionActivationSessionManager {
  getSessionId(): string;
  getBranch(): ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>;
}

export interface SessionActivationPi {
  appendEntry(type: string, data: unknown): void;
}

export interface SessionActivationOptions {
  /** Env value or a provider for it. Defaults to process.env.PI_FUSION_ON. */
  env?: string | null | (() => string | null | undefined);
  envSource?: () => string | null | undefined;
  envValue?: string | null;
  /** Now provider/value. Defaults to Date.now. */
  now?: number | (() => number);
  nowFn?: () => number;
  /** Warn sink. Defaults to console.warn. */
  warn?: (message: string) => void;
  warnFn?: (message: string) => void;
}

const store = new Map<string, SessionActivation>();

let envSourceFn: () => string | undefined = () => process.env.PI_FUSION_ON;
let nowSourceFn: () => number = () => Date.now();
let warnSinkFn: (message: string) => void = (message: string) => console.warn(message);

export function setActivationEnvSource(fn: () => string | undefined): void {
  envSourceFn = fn;
}
export function setActivationNowSource(fn: () => number): void {
  nowSourceFn = fn;
}
export function setActivationWarnSink(fn: (message: string) => void): void {
  warnSinkFn = fn;
}

// Convenience aliases for tests.
export const setEnvSource = setActivationEnvSource;
export const setNowSource = setActivationNowSource;
export const setWarnSource = setActivationWarnSink;

export function resetForTests(): void {
  store.clear();
  envSourceFn = () => process.env.PI_FUSION_ON;
  nowSourceFn = () => Date.now();
  warnSinkFn = (message: string) => console.warn(message);
}

function resolveEnv(options?: SessionActivationOptions): string | undefined {
  if (options) {
    if (typeof options.env === "function") {
      const v = (options.env as () => string | null | undefined)();
      return v == null ? undefined : v;
    }
    if (options.env !== undefined) {
      return options.env == null ? undefined : options.env;
    }
    if (options.envValue !== undefined) {
      return options.envValue == null ? undefined : options.envValue;
    }
    if (options.envSource) {
      const v = options.envSource();
      return v == null ? undefined : v;
    }
  }
  return envSourceFn();
}

function resolveNow(options?: SessionActivationOptions): number {
  if (options) {
    if (typeof options.now === "function") {
      return (options.now as () => number)();
    }
    if (typeof options.now === "number") {
      return options.now;
    }
    if (options.nowFn) {
      return options.nowFn();
    }
  }
  return nowSourceFn();
}

function resolveWarn(options?: SessionActivationOptions): (message: string) => void {
  if (options?.warn) return options.warn;
  if (options?.warnFn) return options.warnFn;
  return warnSinkFn;
}

interface ApplicableRecord {
  enabled: boolean;
}

function applicableRecords(sm: SessionActivationSessionManager, sid: string): ApplicableRecord[] {
  const branch = sm.getBranch();
  const out: ApplicableRecord[] = [];
  for (const entry of branch) {
    if (entry?.type !== "custom") continue;
    if (entry?.customType !== ACTIVATION_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") continue;
    const rec = data as { owner?: unknown; enabled?: unknown };
    if (rec.owner !== sid) continue;
    if (typeof rec.enabled !== "boolean") continue;
    out.push({ enabled: rec.enabled });
  }
  return out;
}

export function getSessionActivation(sm: SessionActivationSessionManager): SessionActivation {
  const sid = sm.getSessionId();
  const cached = store.get(sid);
  if (cached) return cached;
  const apps = applicableRecords(sm, sid);
  if (apps.length === 0) {
    const res: SessionActivation = { enabled: false, source: "default-off" };
    store.set(sid, res);
    return res;
  }
  const last = apps[apps.length - 1]!;
  const res: SessionActivation = { enabled: last.enabled, source: "history" };
  store.set(sid, res);
  return res;
}

export function isSessionEnabled(sm: SessionActivationSessionManager): boolean {
  return getSessionActivation(sm).enabled;
}

export function applySessionStart(
  pi: SessionActivationPi,
  sm: SessionActivationSessionManager,
  options?: SessionActivationOptions,
): SessionActivation {
  const sid = sm.getSessionId();
  const apps = applicableRecords(sm, sid);
  if (apps.length > 0) {
    const last = apps[apps.length - 1]!;
    const res: SessionActivation = { enabled: last.enabled, source: "history" };
    store.set(sid, res);
    return res;
  }
  const envRaw = resolveEnv(options);
  const now = resolveNow(options);
  const warn = resolveWarn(options);
  const normalized = (envRaw ?? "").trim();
  if (normalized !== "") {
    const lower = normalized.toLowerCase();
    if (lower === "1" || lower === "true" || lower === "yes") {
      const res: SessionActivation = { enabled: true, source: "env" };
      store.set(sid, res);
      pi.appendEntry(ACTIVATION_ENTRY_TYPE, { owner: sid, enabled: true, ts: now });
      return res;
    }
    warn(`PI_FUSION_ON: unexpected value "${envRaw}"; expected 1, true, or yes`);
  }
  const res: SessionActivation = { enabled: false, source: "default-off" };
  store.set(sid, res);
  return res;
}

export function setSessionEnabled(
  pi: SessionActivationPi,
  sm: SessionActivationSessionManager,
  v: boolean,
  options?: SessionActivationOptions,
): void {
  const sid = sm.getSessionId();
  const current = getSessionActivation(sm);
  if (current.enabled === v) return;
  const now = resolveNow(options);
  store.set(sid, { enabled: v, source: "memory" });
  pi.appendEntry(ACTIVATION_ENTRY_TYPE, { owner: sid, enabled: v, ts: now });
}
