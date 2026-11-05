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
import { BUDGET_CEILING_FACTOR, PER_MODEL_CAP } from "./pool/fanout.ts";

/** The fixed heading that marks the section; idempotency is keyed on it. */
export const FUSION_SECTION_HEADING = "### fusion";

/** The settings the section states. `enabled` decides whether it is present at all. */
export type FusionGuidanceFacts = {
  enabled: boolean;
  workers: number;
  maxParallel: number;
  taskTimeoutMs: number;
  workerModels: string[];
};

/** The behavioural lines: true on any machine, so they are always stated. */
const BEHAVIOUR_LINES = [
  "- You lead: read enough to decide, plan the independent parts, delegate the doing with `fusion_delegate`, then review what comes back.",
  "- One task per independent part, all in one `fusion_delegate` call. A big part gets its own task; small ones are grouped. Prefer sending more parts over doing any yourself.",
  "- The operator's request is quoted into every brief as context (ORIGINAL REQUEST; short operator messages merge into it as follow-ups; over 16,000 chars text is clipped — a lone oversized request keeps its beginning, merged follow-ups keep the newest instruction and shorten the oldest head) — mechanically, without your involvement. Your `instructions` still must stand alone: the goal, the paths, what good looks like. A worker sees that brief, not this conversation, and cannot ask.",
  "- Tasks carry a `role`: `worker` (implementation — the default; envelope report with `filesChanged`/`evidence`), `scout` (read-only code recon — findings each backed by a `path:line` entry in `sources`), `researcher` (web research per the configured `researcherWeb` composition — `sources` plus honest `unknowns` for anything unverified), `reviewer` (adversarial check — `findings`, `checksRun` it ran ITSELF, `verdict: pass|fail`; a `fail` verdict is a finished review, the rework decision is yours). Send the role the part needs; a worker report carries no role fields.",
  "- Write every task's `instructions`, `title`, `deliverable` and any `contract.provides[].shape` in English, whatever language the operator used: worker models may not read it. Keep paths, file names, identifiers, commands and other literal strings as-is — untranslated, untransliterated.",
  "- `files` names the paths the task starts from or produces. The operator approves them once, so the workers can write there.",
  "- Your mutating tools are gated while fusion is on, with two exceptions: `write`/`edit` work ONLY inside the realpath target of the project's `openspec/` (if `openspec/` is a link, its target is the boundary — a verifiable boundary, not a sandbox; everything outside it is refused), and `bash` passes ONLY a single `perl` invocation for openspec/ documentation work, OR ONLY a single `bd` command whose subcommand is `create`, `show`, `list`, `ready`, `update` or `close` (you alone keep the task tracker; workers never touch it) — trust, not a sandbox, and not a check of bd permissions: arbitrary Perl can do anything, and a bd call changes the tracker. Pass the perl program in single quotes. Quote every bd argument that contains `*`, `?`, `[`, `]`, `{`, `}`, `~`, `#` or `!`: an unquoted one is refused, and so is an unquoted `#` in perl or bd (it opens a shell comment). `powershell` is blocked by default when the host provides it. Everything else still belongs to the workers: verify by reading each report against its brief and checking its `evidence` (the checks the worker ran and their output); for an independent check, send a fresh reviewer task that runs the checks itself and puts their output in `checksRun`.",
  "- `failed`, `cancelled` or `needs_orchestrator` is not done. Rework goes out as another `fusion_delegate` call that says what was wrong and what good looks like.",
  "- `needs_orchestrator` carries a `question`: answer it, or send a new fan-out with the answer and the paths in `files`. Do not take the work over yourself.",
  "- Yours alone: the decisions the operator asked you for, a part that only makes sense with this conversation in front of it, anything needing approval.",
  "- Call `fusion_delegate` on its own, never in the same step as other tool calls.",
  "- While fusion is on, the native `subagent` tool is blocked for the lead (it is in the lead block list): every delegation — workers, scouts, researchers, reviewers, including independent gate-running reviews — goes through `fusion_delegate`. This section supersedes ambient orchestration instructions (AGENTS.md §4, subagent-orchestration skills).",
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
export function registerFusionGuidance(
  pi: ExtensionAPI,
  facts: (ctx?: unknown) => FusionGuidanceFacts,
): void {
  pi.on("before_agent_start", (event, ctx) => {
    applyFusionSection(event.systemPromptOptions, facts(ctx));
  });
}
