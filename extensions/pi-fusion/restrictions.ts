/**
 * Lead restrictions (PLAN F19, atomic-agent `fusion-orchestrator-mode`): while
 * fusion is on, the main session's mutating tools are refused on the
 * `tool_call` hook — `write`, `edit` and `bash` as a whole. Bash mutates
 * through python, sed or redirects, so command classification is unreliable
 * and the block is total. The code is written by the workers; the lead plans,
 * delegates and reviews.
 *
 * The block never depends on state: nothing unlocks a mutating tool within a
 * run. State only shapes the refusal text, read from the FanoutResult that
 * each completed `fusion_delegate` call carries as `structuredContent`:
 *   - before any fan-out: plan and delegate;
 *   - after a fan-out: send the rework out again (needs_orchestrator = a new
 *     fan-out with paths in `files`);
 *   - after BARREN_DELEGATION_LIMIT fan-outs in a row in which every task ran
 *     zero steps: the worker leg is not running, tell the operator.
 *
 * The state resets on `agent_start` (the spec's "turn": one user-initiated
 * run = one agent_start..agent_end scope — pi fires turn_start per model
 * request, which would wipe the post-fan-out phase before the model sees it).
 *
 * Child processes (pi-subagents runner, `PI_SUBAGENT_CHILD=1`) are workers,
 * not the lead: the gate is inert there, or the workers would be blocked too.
 */
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { type FanoutResult, FanoutResultSchema, type TaskResult } from "./types.ts";

/** The fan-out tool name (index.ts FUSION_TOOL_NAME; not imported, to keep this module free of index.ts). */
const DELEGATE_TOOL = "fusion_delegate";

/** Default `leadBlockedTools` (PLAN F01). */
export const LEAD_BLOCKED_TOOLS: readonly string[] = ["write", "edit", "bash"];

/**
 * Barren fan-outs in a row before the refusal stops asking for another one.
 * Two, not one: a single all-cancelled fan-out (an operator's Esc) is not a
 * broken leg.
 */
export const BARREN_DELEGATION_LIMIT = 2;

export interface LeadRestrictionState {
  /** Completed fan-outs with results in the current run. */
  delegations: number;
  /** Consecutive fan-outs in which no worker executed a step. */
  barrenDelegations: number;
}

export function emptyLeadRestrictionState(): LeadRestrictionState {
  return { delegations: 0, barrenDelegations: 0 };
}

/**
 * Steps a task ran: the terminal `turns`, else the last `turnsObserved`
 * snapshot (design TD-008); `undefined` = unknown, never zero (B4-R1).
 */
function taskSteps(task: TaskResult): number | undefined {
  return task.turns ?? task.turnsObserved;
}

/**
 * Did the fan-out run anything? Only an explicit zero on every task is
 * barren. Unknown steps count as work: the refusal keeps asking for a rework
 * rather than telling the lead to stop on a signal it cannot read.
 */
export function fanoutProducedWork(result: FanoutResult): boolean {
  if (result.results.length === 0) return true;
  return result.results.some((task) => taskSteps(task) !== 0);
}

/** Counts one completed fan-out with results. */
export function recordFanout(
  state: LeadRestrictionState,
  result: FanoutResult,
): LeadRestrictionState {
  return {
    delegations: state.delegations + 1,
    barrenDelegations: fanoutProducedWork(result) ? 0 : state.barrenDelegations + 1,
  };
}

/** What the lead is told; the wording depends on the fan-out state. */
export function refusalText(toolName: string, state: LeadRestrictionState): string {
  if (state.barrenDelegations >= BARREN_DELEGATION_LIMIT) {
    return (
      `${toolName} не выполнен: последние ${state.barrenDelegations} fan-out'а — все воркеры выполнили 0 шагов. ` +
      `Ещё один fusion_delegate это не починит: воркер-нога не работает — скажи оператору, что ты строишь ` +
      `и что нужно от него (например, поднят ли сервер воркеров). Код сам не пиши.`
    );
  }
  if (state.delegations === 0) {
    return (
      `${toolName} не выполнен: fusion включён, код пишут воркеры — планируй и делегируй — отправь fusion_delegate: ` +
      `по одной задаче на независимую часть, в files — точные пути, которые она создаёт, критерий готовности ` +
      `и формат ответа.`
    );
  }
  return (
    `${toolName} не выполнен: в этом запуске ты делегировал ${state.delegations} раз(а), и собирать результат ` +
    `самому этот режим запрещает, как бы ни прошёл последний fan-out; отправь переделку: needs_orchestrator = ` +
    `новый fan-out, пути в files, не захватывай работу сам. Скажи, что было не так, что поменять и как ` +
    `выглядит «готово».`
  );
}

function isFanoutResult(value: unknown): value is FanoutResult {
  return Value.Check(FanoutResultSchema, value);
}

export interface LeadRestrictionOptions {
  /** Feature flag: the gate applies only while fusion is on. */
  isEnabled: () => boolean;
  /** Tools the lead may not call; defaults to LEAD_BLOCKED_TOOLS. */
  blockedTools?: readonly string[];
  /** False in a child worker process; defaults to "not PI_SUBAGENT_CHILD=1". */
  isLeadSession?: () => boolean;
}

function isMainProcess(): boolean {
  return process.env.PI_SUBAGENT_CHILD !== "1";
}

/** Registers the lead gate: the tool_call refusal plus the run-scoped fan-out state. */
export function registerLeadRestrictions(pi: ExtensionAPI, options: LeadRestrictionOptions): void {
  const blocked = new Set<string>(options.blockedTools ?? LEAD_BLOCKED_TOOLS);
  const isLeadSession = options.isLeadSession ?? isMainProcess;
  let state = emptyLeadRestrictionState();

  // One user-initiated run = one agent_start..agent_end scope (the
  // atomic-agent "turn"): the fan-out phase and barren streak reset per run,
  // NOT per model request — pi fires turn_start for every model request, so a
  // turn_start reset would wipe the post-fan-out phase before the model ever
  // sees it (orchestrator decision, bd pi-fusion-du1).
  pi.on("agent_start", () => {
    state = emptyLeadRestrictionState();
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== DELEGATE_TOOL) return;
    if (isFanoutResult(event.structuredContent)) {
      state = recordFanout(state, event.structuredContent);
    }
  });

  pi.on("tool_call", (event): ToolCallEventResult | undefined => {
    if (!blocked.has(event.toolName)) return undefined;
    if (!options.isEnabled() || !isLeadSession()) return undefined;
    return { block: true, reason: refusalText(event.toolName, state) };
  });
}
