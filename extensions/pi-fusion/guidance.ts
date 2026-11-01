/**
 * The `### fusion` guidance section (design rev.5.2 F08; port of atomic-agent
 * `fusion-guidance.ts`). Fusion's economics depend on the lead actually
 * delegating: without this block a capable model reads everything itself and
 * never calls `fusion_delegate`. The section also states the machine facts
 * the lead sizes a fan-out by (rotation, width ceiling, timeout), computed the
 * same way the pool clamps them.
 *
 * The section is appended to `systemPromptOptions.appendSystemPrompt` on every
 * `before_agent_start`. It is idempotent: any earlier copy is removed first, so
 * a repeated hook leaves exactly one. It is removed when fusion is off. The
 * whole prompt is never replaced (no `forceSystemPrompt`, no `systemPrompt`).
 */
import type {
  ExtensionAPI,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { FusionConfig } from "./config-bridge.ts";
import { BUDGET_CEILING_FACTOR, PER_MODEL_CAP } from "./pool/fanout.ts";

/** The fixed heading that marks the section; idempotency is keyed on it. */
export const FUSION_SECTION_HEADING = "### fusion";

/** The settings the section states. `enabled` decides whether it is present at all. */
export type FusionGuidanceFacts = Pick<
  FusionConfig,
  "enabled" | "workers" | "maxParallel" | "taskTimeoutMs" | "workerModels"
>;

/** The behavioural lines: true on any machine, so they are always stated. */
const BEHAVIOUR_LINES = [
  "- You lead: read enough to decide, plan the independent parts, delegate the doing with `fusion_delegate`, then review what comes back.",
  "- One task per independent part, all in one `fusion_delegate` call. A big part gets its own task; small ones are grouped. Prefer sending more parts over doing any yourself.",
  "- The operator's request is quoted into every brief as context (ORIGINAL REQUEST, clipped at 16,000 chars when longer) — mechanically, without your involvement. Your `instructions` still must stand alone: the goal, the paths, what good looks like. A worker sees that brief, not this conversation, and cannot ask.",
  "- `files` names the paths the task starts from or produces. The operator approves them once, so the workers can write there.",
  "- You have no bash, write or edit: workers write the code and run the checks. Verify by reading each report against its brief and checking its `evidence` (the checks the worker ran and their output). For an independent check, send a fresh verification task that runs the checks and puts their output in `evidence`.",
  "- `failed`, `cancelled` or `needs_orchestrator` is not done. Rework goes out as another `fusion_delegate` call that says what was wrong and what good looks like.",
  "- `needs_orchestrator` carries a `question`: answer it, or send a new fan-out with the answer and the paths in `files`. Do not take the work over yourself.",
  "- Yours alone: the decisions the operator asked you for, a part that only makes sense with this conversation in front of it, anything needing approval.",
  "- Call `fusion_delegate` on its own, never in the same step as other tool calls.",
];

/**
 * The lines that state this configuration's facts. Each number is the one
 * the pool applies: the width ceiling is `min(maxParallel, PER_MODEL_CAP ×
 * models)` and the per-task timeout is capped at `BUDGET_CEILING_FACTOR ×
 * taskTimeoutMs`.
 */
function machineLines(facts: FusionGuidanceFacts): string[] {
  const models = facts.workerModels;
  if (models.length === 0) {
    return [
      "- No worker models are configured (`workerModels` in fusion.json is empty): every `fusion_delegate` call is refused up front, so do not plan a fan-out until the operator sets them.",
    ];
  }
  const modelList = models.map((model) => `\`${model}\``).join(", ");
  const ceiling = Math.min(facts.maxParallel, PER_MODEL_CAP * models.length);
  return [
    `- Workers run on the models ${modelList}, taken round-robin; each model serves at most ${PER_MODEL_CAP} workers at once.`,
    `- Width: \`maxWorkers\` defaults to ${facts.workers}. At most ${ceiling} workers run at once here, and never more than the tasks you send. A clamp below your request is reported in the result.`,
    `- Timeout: each task gets ${facts.taskTimeoutMs} ms by default. A task's \`timeoutMs\` above ${BUDGET_CEILING_FACTOR * facts.taskTimeoutMs} ms (${BUDGET_CEILING_FACTOR}×) is clamped to that. A task that runs past its timeout fails, so size tasks to fit it.`,
  ];
}

/** The rendered section for these facts. No blank lines inside: the block ends at the first one. */
export function buildFusionSection(facts: FusionGuidanceFacts): string {
  return [FUSION_SECTION_HEADING, ...BEHAVIOUR_LINES, ...machineLines(facts)].join("\n");
}

/**
 * Removes every copy of the section from `text`, together with one adjacent
 * blank separator, so that removing what `applyFusionSection` appended gives
 * back the original text. Text without the heading comes back unchanged.
 */
function removeFusionSection(text: string): string {
  let lines = text.split("\n");
  for (;;) {
    let start = lines.indexOf(FUSION_SECTION_HEADING);
    if (start === -1) break;
    let end = start + 1;
    while (end < lines.length && lines[end] !== "") end += 1;
    if (end < lines.length) {
      end += 1;
    } else if (start > 0 && lines[start - 1] === "") {
      start -= 1;
    }
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  return lines.join("\n");
}

/**
 * Sets the section in `options.appendSystemPrompt` for these facts: present
 * when enabled, absent when not. Idempotent: applying it twice equals applying
 * it once. Only `appendSystemPrompt` is written; the prompt is never replaced.
 */
export function applyFusionSection(
  options: Pick<NormalizedBuildSystemPromptOptions, "appendSystemPrompt">,
  facts: FusionGuidanceFacts,
): void {
  const base = removeFusionSection(options.appendSystemPrompt);
  if (!facts.enabled) {
    options.appendSystemPrompt = base;
    return;
  }
  const section = buildFusionSection(facts);
  options.appendSystemPrompt = base === "" ? section : `${base}\n\n${section}`;
}

/**
 * Applies the section on every `before_agent_start`. `facts` is read per run,
 * so a change of the settings takes effect on the next run.
 */
export function registerFusionGuidance(pi: ExtensionAPI, facts: () => FusionGuidanceFacts): void {
  pi.on("before_agent_start", (event) => {
    applyFusionSection(event.systemPromptOptions, facts());
  });
}
