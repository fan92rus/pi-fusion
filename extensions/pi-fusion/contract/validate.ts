/**
 * Semantic validation of the `fusion_delegate` call (FR-002, design §4
 * contract/validate.ts). A port of atomic-agent's `delegate-args.ts`
 * (306–520), `contract.ts` and `contract-inputs.ts` under TD-007: the
 * same rules, the same caps, the same philosophy — what the contract
 * *means* is never refused; what cannot run is.
 *
 * Deviations from the port, all documented in TD-007: the call is a
 * TypeBox object, never JSON text; unknown fields are refused, not
 * ignored; `etaSeconds` must be a number and is then dropped. Two
 * deltas from the atomic rules, per spec 001: `contract.inputs` caps
 * at 32 AFTER trim + dedup (atomic caps the raw array, contract-inputs.ts);
 * a `provides.shape` cut to 200 chars is reported in `warnings`
 * (atomic truncates silently).
 *
 * The first violation wins: the refusal carries `reason` (the sentence
 * the orchestrator acts on) and `offender` (the field path that broke
 * it). Nothing here starts a worker; the caller runs this before the
 * fan-out.
 */

import {
  CONTRACT_PROVIDE_KINDS,
  type ContractCheck,
  type ContractProvide,
  type ContractRequire,
  type DelegateContract,
  FUSION_ROLES,
  type FusionRole,
  type FusionTask,
  MAX_CONTRACT_CHECKS,
  MAX_CONTRACT_INPUTS,
  MAX_CONTRACT_PROVIDES,
  MAX_DELEGATE_TASKS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_TASK_FILES,
  MAX_TASK_ID_CHARS,
} from "../types.ts";

/** A provide's `shape` is cut to this (truncated, never refused). */
export const MAX_PROVIDE_SHAPE_CHARS = 200;
/** Bound on the shared contract block every worker pays for in its context. */
export const MAX_CONTRACT_RENDERED_CHARS = 8000;
/** A `checks` spec is clipped to this much JSON in the rendered block. */
const CHECK_RENDER_CHARS = 300;
/** Globs are patterns, not paths: never somewhere a provide can be looked for. */
const GLOB_CHARS = /[*?[\]{}]/;

/** The contract after validation: `warnings` is computed here, never input. */
export type ValidatedContract = DelegateContract & { warnings?: string[] };

/** A task after validation: `title` and `role` are always set, `etaSeconds` is gone. */
export type ValidatedTask = Omit<FusionTask, "title" | "etaSeconds" | "role"> & {
  title: string;
  role: FusionRole;
};

export interface ValidatedFusionCall {
  tasks: ValidatedTask[];
  maxWorkers?: number;
  contract?: ValidatedContract;
}

export interface ContractValidationError {
  /** What is wrong, in one sentence the orchestrator can act on. */
  reason: string;
  /** The field path that broke it, e.g. `tasks[1].id`, `contract.owners["a.ts"]`. */
  offender: string;
}

export type FusionCallValidation =
  | { ok: true; value: ValidatedFusionCall }
  | { ok: false; error: ContractValidationError };

/** Thrown internally at the first violation; caught once, at the top. */
class Refusal extends Error {
  readonly offender: string;

  constructor(reason: string, offender: string) {
    super(reason);
    this.offender = offender;
  }
}

function refuse(reason: string, offender: string): never {
  throw new Refusal(reason, offender);
}

/** `8436` → `"8,436"`: the number the orchestrator has to act on, readable. */
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * `fix_main_sync` → `fix main sync`: the id as a label, for a task that
 * named no title. Underscores and hyphens become spaces; anything else
 * is kept as written. An id that humanises to nothing is returned as is.
 */
export function humaniseTaskId(id: string): string {
  const spaced = id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.length > 0 ? spaced : id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A trimmed non-empty string, or null. */
function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function joinPath(label: string, key: string): string {
  return label === "" ? key : `${label}.${key}`;
}

/** Refuse the first key the form does not know; the offender is its path. */
function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      refuse(`unknown field "${key}"; allowed: ${allowed.join(", ")}`, joinPath(label, key));
    }
  }
}

/** Ids are not trimmed for the length and line-break rules: the wire form is exact. */
function parseTaskId(value: unknown, offender: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    refuse(`${offender} must be a non-empty string`, offender);
  }
  if (value.length > MAX_TASK_ID_CHARS) {
    refuse(`${offender} must be at most ${MAX_TASK_ID_CHARS} chars`, offender);
  }
  if (/[\r\n]/.test(value)) refuse(`${offender} must not contain CR or LF`, offender);
  return value.trim();
}

function parseInstructions(value: unknown, offender: string): string {
  const instructions = readString(value);
  if (instructions === null) refuse(`${offender} must be a non-empty string`, offender);
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    // The limit AND the overage: a model told only "at most N" cannot
    // count its own output, so it resends something just as long.
    const over = instructions.length - MAX_INSTRUCTIONS_CHARS;
    refuse(
      `${offender} is ${formatCount(instructions.length)} chars; the limit is ${formatCount(MAX_INSTRUCTIONS_CHARS)} — shorten it by at least ${formatCount(over)} chars. The workers already receive the operator's original request, so do not restate it in the brief.`,
      offender,
    );
  }
  return instructions;
}

function parseFiles(value: unknown, label: string): string[] {
  const offender = `${label}.files`;
  if (!Array.isArray(value)) refuse(`${offender} must be an array of strings`, offender);
  if (value.length > MAX_TASK_FILES) {
    refuse(`${offender} has ${value.length} entries; at most ${MAX_TASK_FILES}`, offender);
  }
  return value.map((entry, j) => {
    const path = readString(entry);
    if (path === null) {
      refuse(`${offender}[${j}] must be a non-empty string`, `${offender}[${j}]`);
    }
    return path;
  });
}

/** A `maxSteps` / `timeoutMs` budget: any positive number; clamped at the runner, not refused. */
function parseBudget(value: unknown, offender: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    refuse(`${offender} must be a positive number`, offender);
  }
  return value;
}

const TASK_KEYS = [
  "id",
  "instructions",
  "title",
  "deliverable",
  "files",
  "maxSteps",
  "timeoutMs",
  "etaSeconds",
  "role",
];

function parseTask(raw: unknown, label: string, seen: Set<string>): ValidatedTask {
  if (!isRecord(raw)) refuse(`${label} must be an object`, label);
  checkKeys(raw, TASK_KEYS, label);

  const id = parseTaskId(raw.id, `${label}.id`);
  if (seen.has(id)) refuse(`${label}.id "${id}" is not unique`, `${label}.id`);
  seen.add(id);

  const instructions = parseInstructions(raw.instructions, `${label}.instructions`);

  if (raw.title !== undefined && typeof raw.title !== "string") {
    refuse(`${label}.title must be a string`, `${label}.title`);
  }
  // A blank or absent title is no explicit title: the humanised id stands.
  const title = readString(raw.title) ?? humaniseTaskId(id);

  let deliverable: string | undefined;
  if (raw.deliverable !== undefined) {
    deliverable =
      readString(raw.deliverable) ??
      refuse(`${label}.deliverable must be a non-empty string`, `${label}.deliverable`);
  }

  if (
    raw.etaSeconds !== undefined &&
    (typeof raw.etaSeconds !== "number" || !Number.isFinite(raw.etaSeconds))
  ) {
    // Accepted and ignored in 001: an advisory estimate, nothing schedules against it.
    refuse(`${label}.etaSeconds must be a number`, `${label}.etaSeconds`);
  }

  const files = raw.files === undefined ? undefined : parseFiles(raw.files, label);
  const maxSteps = parseBudget(raw.maxSteps, `${label}.maxSteps`);
  const timeoutMs = parseBudget(raw.timeoutMs, `${label}.timeoutMs`);

  // The role is normalised here (the `title` precedent): downstream — briefs,
  // pool, seam, retry — never sees the optional. Absent = `worker`, byte-for-byte
  // today's behavior; an unknown literal is refused before any worker starts.
  let role: FusionRole = "worker";
  if (raw.role !== undefined) {
    if (typeof raw.role !== "string" || !(FUSION_ROLES as readonly string[]).includes(raw.role)) {
      refuse(`role must be one of ${FUSION_ROLES.join(", ")}`, `${label}.role`);
    }
    role = raw.role as FusionRole;
  }

  return {
    id,
    title,
    instructions,
    role,
    ...(deliverable === undefined ? {} : { deliverable }),
    ...(files !== undefined && files.length > 0 ? { files } : {}),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** A task reference: a non-empty string naming a task of this call. */
function knownTask(ids: ReadonlySet<string>, value: unknown, offender: string): string {
  const id = readString(value);
  if (id === null) refuse(`${offender} must be a task id`, offender);
  if (!ids.has(id)) refuse(`${offender} names unknown task "${id}"`, offender);
  return id;
}

function truncateShape(shape: string): string {
  // Untrusted model text pasted into every consumer's brief: a line is
  // what it is for. Over-long is cut, not refused.
  return shape.length > MAX_PROVIDE_SHAPE_CHARS
    ? `${shape.slice(0, MAX_PROVIDE_SHAPE_CHARS - 1)}…`
    : shape;
}

function parseInputs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    refuse("contract.inputs must be an array of paths", "contract.inputs");
  }
  const paths = value.map((entry, i) => {
    const path = readString(entry);
    if (path === null) {
      refuse(`contract.inputs[${i}] must be a non-empty path`, `contract.inputs[${i}]`);
    }
    return path;
  });
  const unique = [...new Set(paths)];
  if (unique.length > MAX_CONTRACT_INPUTS) {
    refuse(
      `contract.inputs has ${unique.length} entries; at most ${MAX_CONTRACT_INPUTS}`,
      "contract.inputs",
    );
  }
  return unique.length > 0 ? unique : undefined;
}

function parseOwners(value: unknown, ids: ReadonlySet<string>): Record<string, string> {
  if (!isRecord(value)) {
    refuse("contract.owners must be an object of { path: taskId }", "contract.owners");
  }
  const owners: Record<string, string> = {};
  for (const [path, task] of Object.entries(value)) {
    const key = path.trim();
    if (key.length === 0) refuse("contract.owners has an empty path", "contract.owners");
    owners[key] = knownTask(ids, task, `contract.owners["${key}"]`);
  }
  return owners;
}

/** A parsed provide, and whether its shape was cut to the limit. */
interface ParsedProvide {
  provide: ContractProvide;
  shapeCut: boolean;
}

function parseProvide(raw: unknown, label: string, ids: ReadonlySet<string>): ParsedProvide {
  if (!isRecord(raw)) refuse(`${label} must be an object`, label);
  checkKeys(raw, ["task", "kind", "name", "in", "shape"], label);

  const task = knownTask(ids, raw.task, `${label}.task`);
  const kind = raw.kind;
  if (typeof kind !== "string" || !(CONTRACT_PROVIDE_KINDS as readonly string[]).includes(kind)) {
    refuse(`${label}.kind must be one of ${CONTRACT_PROVIDE_KINDS.join(", ")}`, `${label}.kind`);
  }
  const name = readString(raw.name);
  if (name === null) refuse(`${label}.name must be a non-empty string`, `${label}.name`);
  const inPath =
    raw.in === undefined
      ? undefined
      : (readString(raw.in) ?? refuse(`${label}.in must be a non-empty path`, `${label}.in`));
  const rawShape =
    raw.shape === undefined
      ? undefined
      : (readString(raw.shape) ??
        refuse(`${label}.shape must be a non-empty string`, `${label}.shape`));
  const shape = rawShape === undefined ? undefined : truncateShape(rawShape);
  return {
    provide: {
      task,
      kind: kind as ContractProvide["kind"],
      name,
      ...(inPath === undefined ? {} : { in: inPath }),
      ...(shape === undefined ? {} : { shape }),
    },
    shapeCut: rawShape !== undefined && rawShape.length > MAX_PROVIDE_SHAPE_CHARS,
  };
}

function parseRequire(raw: unknown, label: string, ids: ReadonlySet<string>): ContractRequire {
  if (!isRecord(raw)) refuse(`${label} must be an object`, label);
  checkKeys(raw, ["task", "name"], label);
  const task = knownTask(ids, raw.task, `${label}.task`);
  const name = readString(raw.name);
  if (name === null) refuse(`${label}.name must be a non-empty string`, `${label}.name`);
  return { task, name };
}

function parseCheck(raw: unknown, label: string, ids: ReadonlySet<string>): ContractCheck {
  if (!isRecord(raw)) refuse(`${label} must be an object`, label);
  const { task, ...spec } = raw;
  if (Object.keys(spec).length === 0) {
    refuse(`${label} carries no verify.run arguments`, label);
  }
  if (task === undefined) return spec;
  return { task: knownTask(ids, task, `${label}.task`), ...spec };
}

/**
 * What the contract declares that cannot be honoured, one line each.
 * Provides first, then requires, in declaration order. A shape cut to
 * its limit is reported; a non-file provide with nowhere to be looked
 * for is uncheckable; a require no provide names is unprovided. None
 * of them refuses the call.
 */
function contractWarnings(
  contract: DelegateContract,
  tasks: readonly ValidatedTask[],
  shapeCuts: readonly ContractProvide[],
): string[] {
  const provides = contract.provides ?? [];
  const cut = shapeCuts.map(
    (p) => `provides "${p.name}" (task ${p.task}) shape cut to ${MAX_PROVIDE_SHAPE_CHARS} chars`,
  );
  const uncheckable = provides
    .filter(
      (p) =>
        p.kind !== "file" &&
        provideSearchPaths(
          p,
          contract,
          tasks.find((t) => t.id === p.task),
        ).length === 0,
    )
    .map(
      (p) =>
        `provides "${p.name}" (task ${p.task}) cannot be checked: no \`in\`, no owned path, no declared files`,
    );
  const unprovided = (contract.requires ?? [])
    .filter((r) => !provides.some((p) => p.name === r.name))
    .map((r) => `requires "${r.name}" (task ${r.task}) has no provider — nothing produces it`);
  return [...cut, ...uncheckable, ...unprovided];
}

/**
 * Where a non-file provide is looked for: its `in`, else the paths its
 * task owns, else the files its task declared — globs excluded at every
 * step. Empty means it cannot be checked at all.
 */
function provideSearchPaths(
  provide: ContractProvide,
  contract: DelegateContract,
  task: ValidatedTask | undefined,
): string[] {
  if (provide.in !== undefined) return [provide.in];
  const owned = Object.entries(contract.owners ?? {})
    .filter(([, owner]) => owner === provide.task)
    .map(([path]) => path)
    .filter((path) => !GLOB_CHARS.test(path));
  if (owned.length > 0) return owned;
  return (task?.files ?? []).filter((file) => !GLOB_CHARS.test(file));
}

function renderProvide(provide: ContractProvide): string {
  const where = provide.in === undefined ? "" : ` in ${provide.in}`;
  const shape = provide.shape === undefined ? "" : ` — ${provide.shape}`;
  return `${provide.kind} ${provide.name}${where}${shape}`;
}

function renderCheck(check: ContractCheck): string {
  const { task, ...spec } = check;
  const json = JSON.stringify(spec);
  const clipped = json.length > CHECK_RENDER_CHARS ? `${json.slice(0, CHECK_RENDER_CHARS)}…` : json;
  return task === undefined ? `- ${clipped}` : `- [${task}] ${clipped}`;
}

/**
 * The block shared by every worker: inputs, owners, provides, the
 * requires somebody provides, checks, then the warnings. Measured at
 * parse time against `MAX_CONTRACT_RENDERED_CHARS`, so the measured text
 * is the text the workers pay for.
 */
export function renderContractBlock(contract: ValidatedContract): string {
  const lines = [
    "CONTRACT — the interface between the parts of this fan-out. Every worker sees this same block. Produce exactly what it says you provide, under exactly these names, and reach the other parts only through what they provide.",
  ];
  if (contract.inputs !== undefined && contract.inputs.length > 0) {
    lines.push(
      "INPUTS (the operator's own files — read and edit in place, never replace; os.fs.write on one is refused):",
      ...contract.inputs.map((path) => `- ${path}`),
    );
  }
  const owners = Object.entries(contract.owners ?? {});
  if (owners.length > 0) {
    lines.push(
      "OWNERS (path → task; write only in paths you own):",
      ...owners.map(([path, task]) => `- ${path} → ${task}`),
    );
  }
  const provides = contract.provides ?? [];
  if (provides.length > 0) {
    lines.push("PROVIDES:", ...provides.map((p) => `- [${p.task}] ${renderProvide(p)}`));
  }
  // Only the requires somebody provides are listed as requirements; an
  // unmatched one is the warning at the end, not a dependency to wait on.
  const requires = (contract.requires ?? []).filter((r) => provides.some((p) => p.name === r.name));
  if (requires.length > 0) {
    const byTask = new Map<string, string[]>();
    for (const r of requires) {
      byTask.set(r.task, [...(byTask.get(r.task) ?? []), r.name]);
    }
    lines.push(
      "REQUIRES:",
      ...[...byTask].map(([task, names]) => `- [${task}] ${names.join(", ")}`),
    );
  }
  const checks = contract.checks ?? [];
  if (checks.length > 0) {
    lines.push(
      "CHECKS (run after the fan-out; a failing check fails its task):",
      ...checks.map(renderCheck),
    );
  }
  lines.push(...(contract.warnings ?? []).map((w) => `contract: ${w}`));
  return lines.join("\n");
}

function parseContract(
  raw: unknown,
  tasks: readonly ValidatedTask[],
): ValidatedContract | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) refuse("contract must be an object", "contract");
  checkKeys(raw, ["inputs", "owners", "provides", "requires", "checks"], "contract");
  const ids = new Set(tasks.map((t) => t.id));

  const contract: DelegateContract = {};
  let shapeCuts: ContractProvide[] = [];
  const inputs = parseInputs(raw.inputs);
  if (inputs !== undefined) contract.inputs = inputs;

  if (raw.owners !== undefined) {
    const owners = parseOwners(raw.owners, ids);
    if (Object.keys(owners).length > 0) contract.owners = owners;
  }

  if (raw.provides !== undefined) {
    if (!Array.isArray(raw.provides)) {
      refuse(
        "contract.provides must be an array of { task, kind, name, in?, shape? }",
        "contract.provides",
      );
    }
    if (raw.provides.length > MAX_CONTRACT_PROVIDES) {
      refuse(
        `contract.provides has ${raw.provides.length} entries; at most ${MAX_CONTRACT_PROVIDES}`,
        "contract.provides",
      );
    }
    const parsed = raw.provides.map((entry, i) =>
      parseProvide(entry, `contract.provides[${i}]`, ids),
    );
    if (parsed.length > 0) contract.provides = parsed.map((p) => p.provide);
    shapeCuts = parsed.filter((p) => p.shapeCut).map((p) => p.provide);
  }

  if (raw.requires !== undefined) {
    if (!Array.isArray(raw.requires)) {
      refuse("contract.requires must be an array of { task, name }", "contract.requires");
    }
    const requires = raw.requires.map((entry, i) =>
      parseRequire(entry, `contract.requires[${i}]`, ids),
    );
    if (requires.length > 0) contract.requires = requires;
  }

  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks)) {
      refuse("contract.checks must be an array of verify.run specs", "contract.checks");
    }
    if (raw.checks.length > MAX_CONTRACT_CHECKS) {
      refuse(
        `contract.checks has ${raw.checks.length} entries; at most ${MAX_CONTRACT_CHECKS}`,
        "contract.checks",
      );
    }
    const checks = raw.checks.map((entry, i) => parseCheck(entry, `contract.checks[${i}]`, ids));
    if (checks.length > 0) contract.checks = checks;
  }

  if (Object.keys(contract).length === 0) return undefined;

  // Warnings are computed here, never accepted from the wire; they are
  // part of the block, so they are measured with it.
  const warnings = contractWarnings(contract, tasks, shapeCuts);
  const validated: ValidatedContract = warnings.length > 0 ? { ...contract, warnings } : contract;
  const rendered = renderContractBlock(validated).length;
  if (rendered > MAX_CONTRACT_RENDERED_CHARS) {
    const over = rendered - MAX_CONTRACT_RENDERED_CHARS;
    refuse(
      `contract renders to ${formatCount(rendered)} chars; the limit is ${formatCount(MAX_CONTRACT_RENDERED_CHARS)} — shorten it by at least ${formatCount(over)} chars`,
      "contract",
    );
  }
  return validated;
}

function parseCall(raw: unknown): ValidatedFusionCall {
  if (!isRecord(raw)) refuse("arguments must be an object", "arguments");
  checkKeys(raw, ["tasks", "maxWorkers", "contract"], "");

  const rawTasks = raw.tasks;
  if (!Array.isArray(rawTasks)) {
    refuse("tasks must be an array of { id, instructions, title? }", "tasks");
  }
  if (rawTasks.length === 0) refuse("tasks must contain at least one task", "tasks");
  if (rawTasks.length > MAX_DELEGATE_TASKS) {
    refuse(`tasks has ${rawTasks.length} entries; at most ${MAX_DELEGATE_TASKS} per call`, "tasks");
  }
  const seen = new Set<string>();
  const tasks = rawTasks.map((entry, i) => parseTask(entry, `tasks[${i}]`, seen));

  let maxWorkers: number | undefined;
  if (raw.maxWorkers !== undefined) {
    if (
      typeof raw.maxWorkers !== "number" ||
      !Number.isInteger(raw.maxWorkers) ||
      raw.maxWorkers < 1
    ) {
      refuse("maxWorkers must be an integer of at least 1", "maxWorkers");
    }
    maxWorkers = raw.maxWorkers;
  }

  const contract = parseContract(raw.contract, tasks);
  return {
    tasks,
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    ...(contract === undefined ? {} : { contract }),
  };
}

/**
 * Validate the `fusion_delegate` arguments before any worker starts.
 * Never throws: a refused call comes back as `{ ok: false, error }` with
 * the reason and the offending field, for the tool to render as an
 * error result.
 */
export function validateFusionCall(raw: unknown): FusionCallValidation {
  try {
    return { ok: true, value: parseCall(raw) };
  } catch (error) {
    if (error instanceof Refusal) {
      return { ok: false, error: { reason: error.message, offender: error.offender } };
    }
    throw error;
  }
}
