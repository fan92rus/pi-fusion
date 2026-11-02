/**
 * config-ui.ts — interactive TUI configuration for fusion mode (`/fusion
 * config`), modeled on pi-autoresearch's `parallel/config-ui.ts` menu: a
 * select loop whose title always re-renders the current fusion.json values,
 * so the operator sees what they are about to change and what changed after
 * every edit. Numbers are validated against the same FUSION_CONFIG_BOUNDS
 * config.ts enforces on load, and lists parse with the same rule as
 * `/fusion model`. The menu edits only the shared fusion.json settings: the
 * session's on/off activation is neither shown nor changed here (`/fusion on|off`).
 *
 * Localized: auto-detects Russian locale (ru-RU) and shows Russian UI.
 */

import { type FusionCommandDeps, type FusionUIDialogs, parsePositiveInt } from "./commands.ts";
import { FUSION_CONFIG_BOUNDS, FUSION_CONFIG_DEFAULTS, type FusionConfig } from "./config.ts";

// ─── i18n ────────────────────────────────────────────────────────────────────

function detectRu(): boolean {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "";
  return locale.toLowerCase().startsWith("ru");
}

const RU = detectRu();

const L = {
  title: RU ? "Конфигурация fusion (fusion.json)" : "Fusion configuration (fusion.json)",
  currentLabel: RU ? "Текущие:" : "Current:",
  done: RU ? "✅ Готово" : "✅ Done",
  back: RU ? "↩️ Назад" : "↩️ Back",
  noChange: RU ? "Без изменений" : "No change",
  saved: RU ? "Конфиг сохранён." : "Config saved.",
  errorPrefix: RU ? "Ошибка: " : "Error: ",
  range: RU ? "Диапазон" : "Range",
  defaultLabel: RU ? "Дефолт" : "Default",
  current: RU ? "текущий" : "current",
  enterValue: RU
    ? "Введите новое значение (пусто — отмена):"
    : "Enter a new value (blank = cancel):",
  invalid: RU ? "Неверное значение" : "Invalid value",
  researcherWebTitle: RU ? "Состав веб-инструментов researcher" : "Researcher web composition",
  researcherWebDescription: RU
    ? "Ровно один профиль researcher соответствует составу; запуск с составом шире окружения честно падает preflight'ом. Дефолт none; both подтверждён live-смоуком."
    : "Exactly one researcher profile matches the composition; a wider-than-environment launch fails the preflight honestly. Default none; both is live-smoke-verified.",
  researcherWebNone: RU
    ? "🌐 Researcher web: none (без веба)"
    : "🌐 Researcher web: none (offline)",
  researcherWebWeb: RU
    ? "🌐 Researcher web: web (web_search + web_fetch)"
    : "🌐 Researcher web: web (web_search + web_fetch)",
  researcherWebCodex: RU
    ? "🌐 Researcher web: codex (codex_search)"
    : "🌐 Researcher web: codex (codex_search)",
  researcherWebBoth: RU
    ? "🌐 Researcher web: both (все три)"
    : "🌐 Researcher web: both (all three)",
  approvalRequired: RU ? "✋ Подтверждение: требуется" : "✋ Approval: required",
  approvalOptional: RU ? "✋ Подтверждение: не требуется" : "✋ Approval: not required",
  approvalTitle: RU ? "Подтверждение делегаций" : "Delegate approval",
  approvalDescription: RU
    ? "Когда требуется, делегирование ждёт явного подтверждения лида, прежде чем воркеры начнут работу."
    : "When required, a delegation waits for the lead's explicit approval before workers run.",
  listHint: RU
    ? "Введите значения через пробел или запятую. «clear» — очистить список, пустой ввод — отмена."
    : 'Enter values separated by spaces or commas. "clear" empties the list; blank cancels.',
};

/** The word that empties a list (the operator types it instead of the values). */
const CLEAR_PATTERN = /^(clear|очистить)$/i;

/**
 * The localized action rows (done/back/on/off/approval options). Exported so
 * tests script the menu with the exact labels the current locale renders.
 */
export const MENU_ACTIONS = {
  done: L.done,
  back: L.back,
  approvalRequired: L.approvalRequired,
  approvalOptional: L.approvalOptional,
} as const;

/** The researcherWeb composition options, localized; tests select by these. */
export const RESEARCHER_WEB_OPTIONS: Record<FusionConfig["researcherWeb"], string> = {
  none: L.researcherWebNone,
  web: L.researcherWebWeb,
  codex: L.researcherWebCodex,
  both: L.researcherWebBoth,
};

// ─── Field specs ─────────────────────────────────────────────────────────────

const NUMBER_KEYS = ["workers", "maxParallel", "taskTimeoutMs", "maxSteps"] as const;
type NumberKey = (typeof NUMBER_KEYS)[number];

const LIST_KEYS = ["workerModels", "blockedTools", "leadBlockedTools"] as const;
type ListKey = (typeof LIST_KEYS)[number];

type MenuItemId = "approval" | "researcherWeb" | NumberKey | ListKey;

export type { MenuItemId };

interface NumberSpec {
  key: NumberKey;
  label: string;
  description: string;
}

const NUMBER_SPECS: Record<NumberKey, NumberSpec> = {
  workers: {
    key: "workers",
    label: RU ? "👷 Воркеры (ширина пула)" : "👷 Workers (pool width)",
    description: RU
      ? "Сколько свежих воркер-агентов может породить один вызов fusion_delegate."
      : "How many fresh worker agents one fusion_delegate call may spawn.",
  },
  maxParallel: {
    key: "maxParallel",
    label: RU ? "🔀 Максимум параллельно" : "🔀 Max parallel",
    description: RU
      ? "Сколько воркеров из пула выполняются одновременно."
      : "How many of the pool's workers execute at the same time.",
  },
  taskTimeoutMs: {
    key: "taskTimeoutMs",
    label: RU ? "⏱ Таймаут задачи (мс)" : "⏱ Task timeout (ms)",
    description: RU
      ? "Бюджет времени на одну задачу воркера; воркер, превысивший его, отменяется."
      : "Wall-time budget per worker task; a worker exceeding it is cancelled.",
  },
  maxSteps: {
    key: "maxSteps",
    label: RU ? "🔁 Максимум шагов" : "🔁 Max steps",
    description: RU
      ? "Предельное число ходов модели на одну задачу воркера."
      : "Maximum model turns per worker task.",
  },
};

interface ListSpec {
  key: ListKey;
  label: string;
  description: string;
  /** Rendered in place of the values when the list is empty. */
  empty: string;
}

const LIST_SPECS: Record<ListKey, ListSpec> = {
  workerModels: {
    key: "workerModels",
    label: RU ? "🔧 Модели воркеров" : "🔧 Worker models",
    description: RU
      ? "Ротация моделей воркеров в формате provider/model. Пустой список — fan-out отказывает, пока модели не заданы."
      : "Worker model rotation as provider/model ids. An empty list refuses every fan-out until models are set.",
    empty: RU
      ? "(нет — fan-out отказывает, пока модели не заданы)"
      : "(none — every fan-out is refused until models are set)",
  },
  blockedTools: {
    key: "blockedTools",
    label: RU ? "🚫 Запрещённые воркерам инструменты" : "🚫 Worker blocked tools",
    description: RU
      ? "Инструменты, изъятые из активного набора каждого воркера fusion-пула."
      : "Tools removed from every fusion worker's active set.",
    empty: RU ? "(нет)" : "(none)",
  },
  leadBlockedTools: {
    key: "leadBlockedTools",
    label: RU ? "🧱 Запрещённые лиду инструменты" : "🧱 Lead blocked tools",
    description: RU
      ? "Инструменты, изъятые у сессии лида, пока fusion включён. Вступает в силу после перезапуска pi."
      : "Tools removed from the lead session while fusion is on. Takes effect after pi restarts.",
    empty: RU ? "(нет)" : "(none)",
  },
};

function isNumberKey(id: MenuItemId): id is NumberKey {
  return (NUMBER_KEYS as readonly string[]).includes(id);
}

function isListKey(id: MenuItemId): id is ListKey {
  return (LIST_KEYS as readonly string[]).includes(id);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** `600000` → `10мин`/`10m`; `45000` → `45с`/`45s`; other values stay in ms. */
function humanMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}${RU ? "мин" : "m"}`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}${RU ? "с" : "s"}`;
  return `${ms}${RU ? "мс" : "ms"}`;
}

function joinOr(items: string[], fallback: string): string {
  return items.length > 0 ? items.join(", ") : fallback;
}

/** One line per setting — the snapshot the menu title and the notices render. */
export function formatCurrent(config: FusionConfig): string {
  return [
    `  workers: ${config.workers} (maxParallel ${config.maxParallel})`,
    `  ${RU ? "модели" : "models"}: ${joinOr(config.workerModels, LIST_SPECS.workerModels.empty)}`,
    `  timeout: ${config.taskTimeoutMs} ms (${humanMs(config.taskTimeoutMs)})`,
    `  maxSteps: ${config.maxSteps}`,
    `  ${RU ? "подтверждение" : "approval"}: ${
      config.requireApproval ? (RU ? "требуется" : "required") : RU ? "нет" : "off"
    }`,
    `  ${RU ? "воркерам запрещены" : "worker blocked"}: ${joinOr(config.blockedTools, "—")}`,
    `  ${RU ? "лиду запрещены" : "lead blocked"}: ${joinOr(config.leadBlockedTools, "—")}`,
  ].join("\n");
}

export interface MenuItem {
  id: MenuItemId;
  label: string;
}

/**
 * The selectable menu rows with the current value baked into each label.
 * Exported so tests can pick a row by id without depending on the locale.
 */
export function fusionMenuItems(config: FusionConfig): MenuItem[] {
  const numberLabel = (spec: NumberSpec): string => {
    const value = config[spec.key];
    const suffix = spec.key === "taskTimeoutMs" ? ` ms (${humanMs(value)})` : "";
    return `${spec.label} — ${value}${suffix}`;
  };
  const listLabel = (spec: ListSpec): string =>
    `${spec.label} — ${joinOr(config[spec.key], spec.empty)}`;
  return [
    { id: "workerModels", label: listLabel(LIST_SPECS.workerModels) },
    { id: "workers", label: numberLabel(NUMBER_SPECS.workers) },
    { id: "maxParallel", label: numberLabel(NUMBER_SPECS.maxParallel) },
    { id: "taskTimeoutMs", label: numberLabel(NUMBER_SPECS.taskTimeoutMs) },
    { id: "maxSteps", label: numberLabel(NUMBER_SPECS.maxSteps) },
    {
      id: "researcherWeb",
      label: RESEARCHER_WEB_OPTIONS[config.researcherWeb],
    },
    { id: "approval", label: config.requireApproval ? L.approvalRequired : L.approvalOptional },
    { id: "blockedTools", label: listLabel(LIST_SPECS.blockedTools) },
    { id: "leadBlockedTools", label: listLabel(LIST_SPECS.leadBlockedTools) },
  ];
}

function menuTitle(config: FusionConfig): string {
  return `${L.title}\n\n${L.currentLabel}\n${formatCurrent(config)}`;
}

// ─── Editors ─────────────────────────────────────────────────────────────────

async function editResearcherWeb(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
  config: FusionConfig,
): Promise<void> {
  const options = RESEARCHER_WEB_OPTIONS;
  const choice = await dialogs.select(`${L.researcherWebTitle}\n\n${L.researcherWebDescription}`, [
    options.none,
    options.web,
    options.codex,
    options.both,
    L.back,
  ]);
  if (!choice || choice === L.back) return;
  const mode = (Object.entries(options) as Array<[FusionConfig["researcherWeb"], string]>).find(
    ([, label]) => label === choice,
  )?.[0];
  if (mode === undefined || mode === config.researcherWeb) {
    deps.notify(L.noChange, "info");
    return;
  }
  deps.persistConfig({ ...deps.loadConfig(), researcherWeb: mode });
  deps.notify(`${L.researcherWebTitle} → ${options[mode]}`, "info");
}

async function editNumber(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
  spec: NumberSpec,
  config: FusionConfig,
): Promise<void> {
  const { min, max } = FUSION_CONFIG_BOUNDS[spec.key];
  const value = config[spec.key];
  const maxText = max === Number.MAX_SAFE_INTEGER ? "∞" : String(max);
  const rangeText = `${L.range}: ${min} – ${maxText}`;
  const title = [
    `${spec.label} (${L.current}: ${value})`,
    "",
    spec.description,
    "",
    `${rangeText}  |  ${L.defaultLabel}: ${FUSION_CONFIG_DEFAULTS[spec.key]}`,
    "",
    L.enterValue,
  ].join("\n");
  const input = await dialogs.input(title, String(value));
  if (!input || input.trim().length === 0) {
    deps.notify(L.noChange, "info");
    return;
  }
  const parsed = parsePositiveInt(input);
  if (parsed === null || parsed < min || parsed > max) {
    deps.notify(`${L.invalid} (${rangeText})`, "error");
    return;
  }
  deps.persistConfig({ ...deps.loadConfig(), [spec.key]: parsed });
  const suffix = spec.key === "taskTimeoutMs" ? ` ms (${humanMs(parsed)})` : "";
  deps.notify(`${spec.label} → ${parsed}${suffix}`, "info");
}

async function editList(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
  spec: ListSpec,
  config: FusionConfig,
): Promise<void> {
  const current = config[spec.key];
  const title = [
    `${spec.label} — ${joinOr(current, spec.empty)}`,
    "",
    spec.description,
    "",
    L.listHint,
  ].join("\n");
  const input = await dialogs.input(title, current.join(", "));
  if (!input || input.trim().length === 0) {
    deps.notify(L.noChange, "info");
    return;
  }
  // The same separator rule as `/fusion model`; `clear` is the explicit way
  // to empty a list, because blank input is reserved for cancelling. A
  // separator-only input also parses to zero entries — refused like the
  // command does, not persisted as a silent wipe (review fix).
  const trimmed = input.trim();
  if (!CLEAR_PATTERN.test(trimmed)) {
    const next = input.split(/[\s,]+/).filter((id) => id.length > 0);
    if (next.length === 0) {
      deps.notify(`${L.invalid} (${L.listHint})`, "error");
      return;
    }
    deps.persistConfig({ ...deps.loadConfig(), [spec.key]: next });
    deps.notify(`${spec.label} → ${joinOr(next, spec.empty)}`, "info");
    return;
  }
  deps.persistConfig({ ...deps.loadConfig(), [spec.key]: [] });
  deps.notify(`${spec.label} → ${spec.empty}`, "info");
}

async function editApproval(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
  config: FusionConfig,
): Promise<void> {
  const choice = await dialogs.select(`${L.approvalTitle}\n\n${L.approvalDescription}`, [
    L.approvalRequired,
    L.approvalOptional,
    L.back,
  ]);
  if (!choice || choice === L.back) return;
  const required = choice === L.approvalRequired;
  if (config.requireApproval === required) {
    deps.notify(L.noChange, "info");
    return;
  }
  deps.persistConfig({ ...deps.loadConfig(), requireApproval: required });
  deps.notify(`${L.approvalTitle} → ${required ? L.approvalRequired : L.approvalOptional}`, "info");
}

// ─── Main menu loop ──────────────────────────────────────────────────────────

/**
 * Runs the `/fusion config` menu until the operator picks "done". Every loop
 * re-reads fusion.json, so edits made outside the menu (another `/fusion`
 * call, a manual file edit) are reflected on the next screen.
 */
export async function interactiveFusionConfig(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
): Promise<void> {
  deps.notify(`${L.title}\n\n${L.currentLabel}\n${formatCurrent(deps.loadConfig())}`, "info");
  // B6 (design §4.6): the /fusion config path installs the manifest profiles
  // whenever any is absent or stale, then reports EVERY profile's outcome
  // (§4.6/§7 — `current` rows stay visible in the same notice).
  const stale = deps.roleProfileStatuses().filter((row) => row.status !== "current");
  const installed =
    stale.length > 0
      ? deps.installRoleAgents()
      : deps
          .roleProfileStatuses()
          .map((row) => ({ name: row.name, outcome: row.status, path: row.path }));
  const lines = installed.map((result) => `  ${result.name}: ${result.outcome} @ ${result.path}`);
  deps.notify(`profiles:\n${lines.join("\n")}`, "info");
  while (true) {
    const config = deps.loadConfig();
    const items = fusionMenuItems(config);
    const choice = await dialogs.select(menuTitle(config), [
      ...items.map((item) => item.label),
      L.done,
    ]);
    if (!choice || choice === L.done) break;
    try {
      const item = items.find((entry) => entry.label === choice);
      if (!item) continue;
      if (item.id === "researcherWeb") await editResearcherWeb(deps, dialogs, config);
      else if (item.id === "approval") await editApproval(deps, dialogs, config);
      else if (isNumberKey(item.id)) await editNumber(deps, dialogs, NUMBER_SPECS[item.id], config);
      else if (isListKey(item.id)) await editList(deps, dialogs, LIST_SPECS[item.id], config);
    } catch (error) {
      deps.notify(
        L.errorPrefix + (error instanceof Error ? error.message : String(error)),
        "error",
      );
    }
  }
  deps.notify(`${L.saved}\n${formatCurrent(deps.loadConfig())}`, "info");
}
