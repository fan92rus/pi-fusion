/**
 * config-ui.ts — interactive TUI configuration for fusion mode (`/fusion
 * config`), modeled on pi-autoresearch's `parallel/config-ui.ts` menu: a
 * select loop whose title always re-renders the current values, so the
 * operator sees what they are about to change and what changed after every
 * edit. Numbers are validated against the same FUSION_CONFIG_BOUNDS config.ts
 * enforces on load, and lists parse with the same rule as `/fusion model`.
 * The menu edits only the shared fusion settings: the session's on/off
 * activation is neither shown nor changed here (`/fusion on|off`).
 *
 * Two layers (openspec fusion-project-config, D5): a switcher chooses the
 * global `~/.pi/agent/fusion.json` or the project `.pi/fusion.json`. Global
 * mode persists full snapshots; local mode shows each field's effective value
 * with its origin, persists one key per edit, and creates an override only
 * after an explicit confirm. Switching layers writes nothing.
 *
 * Localized: auto-detects Russian locale (ru-RU) and shows Russian UI.
 */

import { type FusionCommandDeps, type FusionUIDialogs, parsePositiveInt } from "./commands.ts";
import {
  type FieldOrigins,
  FUSION_CONFIG_BOUNDS,
  FUSION_CONFIG_DEFAULTS,
  type FusionConfig,
} from "./config.ts";

// ─── i18n ────────────────────────────────────────────────────────────────────

function detectRu(): boolean {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "";
  return locale.toLowerCase().startsWith("ru");
}

const RU = detectRu();

const L = {
  title: RU ? "Конфигурация fusion" : "Fusion configuration",
  currentLabel: RU ? "Текущие:" : "Current:",
  done: RU ? "✅ Готово" : "✅ Done",
  back: RU ? "↩️ Назад" : "↩️ Back",
  layerSwitch: "↩️ Слой / Layer",
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
  switcherTitle: RU
    ? "Какую конфигурацию редактировать?\n\nГлобальная — ~/.pi/agent/fusion.json. Локальная — .pi/fusion.json проекта: переопределяет поля глобальной. Переключение ничего не записывает."
    : "Which configuration to edit?\n\nGlobal — ~/.pi/agent/fusion.json. Local — the project's .pi/fusion.json: overrides global fields one by one. Switching writes nothing.",
  layerGlobal: RU ? "Глобальная (~/.pi/agent/fusion.json)" : "Global (~/.pi/agent/fusion.json)",
  layerLocalExists: RU
    ? "Локальная (.pi/fusion.json) — файл есть"
    : "Local (.pi/fusion.json) — file exists",
  layerLocalMissing: RU
    ? "Локальная (.pi/fusion.json) — файла нет (создастся при первом переопределении)"
    : "Local (.pi/fusion.json) — no file yet (created by the first override)",
  layerName: (layer: Layer): string =>
    layer === "global" ? (RU ? "глобальная" : "Global") : RU ? "локальная" : "Local",
  overrideTitle: RU ? "Переопределить здесь?" : "Override here?",
  overrideMessage: (key: string, origin: string): string =>
    RU
      ? `«${key}» сейчас наследуется (${origin}). Создать локальное переопределение в .pi/fusion.json?`
      : `"${key}" is inherited (${origin}). Create a local override in .pi/fusion.json?`,
  resetRow: (key: string): string =>
    RU ? `♻️ Сбросить к наследованию: ${key}` : `♻️ Reset to inherited: ${key}`,
  resetDone: (key: string): string =>
    RU ? `Сброшено к наследованию: ${key}` : `Reset to inherited: ${key}`,
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
 * The localized action rows (done/back/layer/on/off/approval options). Exported
 * so tests script the menu with the exact labels the current locale renders.
 */
export const MENU_ACTIONS = {
  done: L.done,
  back: L.back,
  layer: L.layerSwitch,
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

/** The two layers the switcher chooses between (design D5). */
export type Layer = "global" | "local";

/**
 * The switcher's option labels. The local label notes whether the project file
 * exists; the file decides which option is suggested (first) on entry.
 */
export function layerOptionLabels(projectExists: boolean): Record<Layer, string> {
  return {
    global: L.layerGlobal,
    local: projectExists ? L.layerLocalExists : L.layerLocalMissing,
  };
}

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
      ? "Инструменты, изъятые у сессии лида, пока fusion включён. Применяется сразу — гейт читает список свежо при каждом вызове."
      : "Tools removed from the lead session while fusion is on. Applies immediately — the gate reads the list fresh on every check.",
    empty: RU ? "(нет)" : "(none)",
  },
};

function isNumberKey(id: MenuItemId): id is NumberKey {
  return (NUMBER_KEYS as readonly string[]).includes(id);
}

function isListKey(id: MenuItemId): id is ListKey {
  return (LIST_KEYS as readonly string[]).includes(id);
}

/** The config key a menu row edits (the approval row is the `requireApproval` flag). */
function configKeyOf(id: MenuItemId): keyof FusionConfig {
  return id === "approval" ? "requireApproval" : id;
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
 * The selectable menu rows with the current value baked into each label. With
 * `origins` (local mode) each label ends in its source tag, `[local]`,
 * `[global]` or `[default]`. Exported so tests can pick a row by id without
 * depending on the locale.
 */
export function fusionMenuItems(config: FusionConfig, origins?: FieldOrigins): MenuItem[] {
  const numberLabel = (spec: NumberSpec): string => {
    const value = config[spec.key];
    const suffix = spec.key === "taskTimeoutMs" ? ` ms (${humanMs(value)})` : "";
    return `${spec.label} — ${value}${suffix}`;
  };
  const listLabel = (spec: ListSpec): string =>
    `${spec.label} — ${joinOr(config[spec.key], spec.empty)}`;
  const items: MenuItem[] = [
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
  return items.map((item) => ({
    ...item,
    label: origins ? `${item.label} [${origins[configKeyOf(item.id)]}]` : item.label,
  }));
}

/** The reset row of a local-origin field: `Reset to inherited`, keyed by the config key. */
export function resetRowLabel(id: MenuItemId): string {
  return L.resetRow(configKeyOf(id));
}

function menuTitle(layer: Layer, config: FusionConfig): string {
  return `${L.title} — ${L.layerName(layer)}\n\n${L.currentLabel}\n${formatCurrent(config)}`;
}

// ─── Editors ─────────────────────────────────────────────────────────────────

/** What an editor sees and how it persists: the shown value and the layer's write path. */
interface EditScope {
  deps: FusionCommandDeps;
  dialogs: FusionUIDialogs;
  /** The effective (local mode) or global (global mode) configuration on screen. */
  config: FusionConfig;
  /** Persists only the given keys (local: the project delta; global: a full snapshot). */
  write: (delta: Partial<FusionConfig>) => void;
}

async function editResearcherWeb(scope: EditScope): Promise<void> {
  const { deps, dialogs, config, write } = scope;
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
  write({ researcherWeb: mode });
  deps.notify(`${L.researcherWebTitle} → ${options[mode]}`, "info");
}

async function editNumber(scope: EditScope, spec: NumberSpec): Promise<void> {
  const { deps, dialogs, config, write } = scope;
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
  const delta: Partial<FusionConfig> = { [spec.key]: parsed };
  write(delta);
  const suffix = spec.key === "taskTimeoutMs" ? ` ms (${humanMs(parsed)})` : "";
  deps.notify(`${spec.label} → ${parsed}${suffix}`, "info");
}

async function editList(scope: EditScope, spec: ListSpec): Promise<void> {
  const { deps, dialogs, config, write } = scope;
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
    write({ [spec.key]: next });
    deps.notify(`${spec.label} → ${joinOr(next, spec.empty)}`, "info");
    return;
  }
  write({ [spec.key]: [] });
  deps.notify(`${spec.label} → ${spec.empty}`, "info");
}

async function editApproval(scope: EditScope): Promise<void> {
  const { deps, dialogs, config, write } = scope;
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
  write({ requireApproval: required });
  deps.notify(`${L.approvalTitle} → ${required ? L.approvalRequired : L.approvalOptional}`, "info");
}

/**
 * Opens one field's editor. In local mode a field that is not overridden yet
 * (origin global/default) first needs an explicit confirm: only then does the
 * editor's write create the project override.
 */
async function editItem(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
  layer: Layer,
  view: LayerView,
  item: MenuItem,
): Promise<void> {
  const key = configKeyOf(item.id);
  const origin = view.origins?.[key];
  if (layer === "local" && origin !== undefined && origin !== "local") {
    const approved = await dialogs.confirm(L.overrideTitle, L.overrideMessage(key, origin));
    if (!approved) {
      deps.notify(L.noChange, "info");
      return;
    }
  }
  const scope: EditScope = {
    deps,
    dialogs,
    config: view.config,
    write:
      layer === "local"
        ? (delta) => deps.persistProjectDelta(delta)
        : (delta) => deps.persistGlobal({ ...deps.loadGlobal(), ...delta }),
  };
  if (item.id === "researcherWeb") await editResearcherWeb(scope);
  else if (item.id === "approval") await editApproval(scope);
  else if (isNumberKey(item.id)) await editNumber(scope, NUMBER_SPECS[item.id]);
  else if (isListKey(item.id)) await editList(scope, LIST_SPECS[item.id]);
}

// ─── Layers: switcher and layer menu ─────────────────────────────────────────

/** What one layer shows: its values, and in local mode each value's origin. */
interface LayerView {
  config: FusionConfig;
  origins?: FieldOrigins;
}

/** Fresh read of the layer on screen (every loop re-reads, so writes show at once). */
function readView(deps: FusionCommandDeps, layer: Layer): LayerView {
  if (layer === "global") return { config: deps.loadGlobal() };
  return { config: deps.loadEffective(), origins: deps.getOrigins() };
}

/**
 * The switcher. The first option is the suggestion: on entry the local layer
 * when the project file exists, else global; after returning from a layer it
 * is the other layer (the flip the operator most likely wants). Nothing is
 * written here.
 */
async function pickLayer(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
  suggested: Layer,
): Promise<Layer | undefined> {
  const labels = layerOptionLabels(deps.projectConfigExists());
  const options =
    suggested === "local" ? [labels.local, labels.global] : [labels.global, labels.local];
  const choice = await dialogs.select(L.switcherTitle, options);
  if (choice === labels.local) return "local";
  if (choice === labels.global) return "global";
  return undefined;
}

/**
 * One layer's menu loop. Returns `true` when the operator asks for the layer
 * switcher (↩️ Слой / Layer) and `false` when the menu is done or cancelled.
 */
async function runLayerMenu(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
  layer: Layer,
): Promise<boolean> {
  while (true) {
    const view = readView(deps, layer);
    const items = fusionMenuItems(view.config, view.origins);
    // Local-origin fields get a reset row; the reset is the selection itself (no confirm).
    const resets =
      layer === "local"
        ? items.filter((item) => view.origins?.[configKeyOf(item.id)] === "local")
        : [];
    const choice = await dialogs.select(menuTitle(layer, view.config), [
      L.layerSwitch,
      ...items.map((item) => item.label),
      ...resets.map((item) => resetRowLabel(item.id)),
      L.done,
    ]);
    if (!choice || choice === L.done) return false;
    if (choice === L.layerSwitch) return true;
    try {
      const reset = resets.find((item) => resetRowLabel(item.id) === choice);
      if (reset) {
        const key = configKeyOf(reset.id);
        deps.clearProjectOverride(key);
        deps.notify(L.resetDone(key), "info");
        continue;
      }
      const item = items.find((entry) => entry.label === choice);
      if (!item) continue;
      await editItem(deps, dialogs, layer, view, item);
    } catch (error) {
      deps.notify(
        L.errorPrefix + (error instanceof Error ? error.message : String(error)),
        "error",
      );
    }
  }
}

// ─── Main menu loop ──────────────────────────────────────────────────────────

/**
 * Runs the `/fusion config` menu until the operator exits. The switcher picks
 * the layer; each layer loop re-reads its files, so edits made outside the menu
 * (another `/fusion` call, a manual file edit) are reflected on the next screen.
 */
export async function interactiveFusionConfig(
  deps: FusionCommandDeps,
  dialogs: FusionUIDialogs,
): Promise<void> {
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
  let layer = await pickLayer(deps, dialogs, deps.projectConfigExists() ? "local" : "global");
  let lastLayer: Layer | undefined;
  while (layer !== undefined) {
    lastLayer = layer;
    const switching = await runLayerMenu(deps, dialogs, layer);
    if (!switching) break;
    layer = await pickLayer(deps, dialogs, layer === "local" ? "global" : "local");
  }
  if (lastLayer !== undefined) {
    deps.notify(`${L.saved}\n${formatCurrent(readView(deps, lastLayer).config)}`, "info");
  }
}
