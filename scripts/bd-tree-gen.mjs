// Generates scripts/bd-tree.json — full bd graph plan for the pi-fusion MVP campaign.
// Run: node scripts/bd-tree-gen.mjs
import { writeFileSync } from "node:fs";

const S1 = "pi-fusion-2rb.1";
const S2 = "pi-fusion-2rb.2";
const S3 = "pi-fusion-2rb.3";
const S4 = "pi-fusion-2rb.4";
const S5 = "pi-fusion-2rb.5";
const S6 = "pi-fusion-2rb.6";

const nodes = [];
const parentOf = {};
function t(key, parent, title, description, acceptance) {
  nodes.push({ key, title, description, acceptance, issue_type: "task" });
  parentOf[key] = parent;
}

t("T1", S1, "contract-schema: types.ts + contract/schema.ts",
  "Поле: extensions/pi-fusion/types.ts, extensions/pi-fusion/contract/schema.ts, test/contract-schema.test.ts. TypeBox-формы по design §4 Core Interfaces (.ai/sdd/specs/001-fanout-engine/design.md): FusionTask {id,instructions,title?,deliverable?,files?,maxSteps?,timeoutMs?,etaSeconds?}, DelegateContract (inputs?, owners?, provides?, requires?, checks?), FusionContract {tasks 1..16, maxWorkers?, contract? object}, WorkerReport, TaskResult, UsageTotals, ProgressSnapshot, ClampRow, FanoutResult. Схема задач строгая: additionalProperties:false (неизвестные поля отклоняются; etaSeconds — известное игнорируемое), id string 1..200 без CR/LF, instructions 1..32000, files массив 0..32 непустых строк, maxWorkers >=1. TDD: сначала тесты форм.",
  "Схемы экспортированы; тесты покрывают границы (16/17 задач, id 200/201, CR/LF, instructions 32000/32001, files 32/33, неизвестное поле отклонено); npm test/typecheck/lint/build зелёные");

t("T2", S1, "contract-validate: порт валидатора atomic-agent",
  "Поле: extensions/pi-fusion/contract/validate.ts, test/contract-validate.test.ts. Порт правил atomic-agent (D:/Documents/Repositories/atomic-agent/src/tools/fusion/delegate-args.ts:306-520 + contract.ts + contract-inputs.ts): дубли id; contract не объект; inputs <=32 после trim+дедупа (схлопывание, не отказ); owners — ссылки только на известные задачи, пустые пути отклоняются; provides <=64, kind из 7 (symbol|file|id|endpoint|env|flag|other), shape <=200 ОБРЕЗАЕТСЯ (не отказ); requires {task известная, name непустая}; checks <=16 непустой spec; рендер блока контракта >8000 знаков = ОТКАЗ вызова; warnings вычисляет парсер (несбываемость — в warnings, не отказ); title дефолт = humaniseTaskId(id) (replace [_-]+ пробелом, схлопнуть, trim, пусто = id); etaSeconds принимается и игнорируется. Ошибки isError-форма {reason, offender} до запуска воркеров.",
  "Все ветки FR-002 в тестах; рендер >8000 -> отказ; длинный shape -> обрезка+warning; humanise-тесты; гейты зелёные");

t("T3", S1, "report-schema: WorkerReport + validate + violatedFields",
  "Поле: extensions/pi-fusion/report/schema.ts, extensions/pi-fusion/report/validate.ts, test/report.test.ts. TypeBox if/then: status enum done|no_changes|failed|needs_orchestrator, summary string, filesChanged/evidence/residualRisks string[], replacedExistingFiles? string[], question? — ОБЯЗАТЕЛЕН при needs_orchestrator (if/then в самой схеме — хост вернёт structured_output_failed, design M10-R3). validate.ts: violatedFields(report) — нарушенные поля; no_changes требует filesChanged:[].",
  "Тесты: валидный отчёт ок; needs_orchestrator без question -> violation; no_changes с непустым filesChanged -> violation; violatedFields называет поля; гейты зелёные");

t("T4", S2, "fake-pi: тестовая шина delegation-событий",
  "Поле: test/fake-pi.ts. Фейковый шов поверх EventEmitter: события prompt-template:subagent:request|started|update|response|cancel с валидными payload по типам C:/Users/user/.pi/agent/npm/node_modules/pi-subagents/src/api/delegation.d.ts; response-гейты по requestId (тест управляет порядком/статусом/usage/result.value/error); helper кумулятивных :update-снимков; совместимо с fake timers vitest. Эталон поведения хоста: .../src/slash/delegation-adapters.js.",
  "fake-pi переиспользуется T5+: подписка/ответ маршрутизируется по requestId; cancel доходит; гейты зелёные");

t("T5", S2, "seam-client: availability + client (11 статусов, usage, cancel, dispose)",
  "Поле: extensions/pi-fusion/seam/availability.ts, extensions/pi-fusion/seam/client.ts, test/seam-client.test.ts. availability(pi). Клиент: один FanoutSeamClient на fan-out; run({nodeId,task,model,timeoutMs,hardToolBudget,onProgress})->SeamOutcome; requestId fusion-<task.id>-a<attempt>-<seq>-<ts>, nodeId <task.id>#a<attempt>, ownerRunId fusion-<seq>-<ts>; локальный дедлайн timeoutMs+15s -> cancel {requestId,ownerRunId,nodeId} + исход timeout; МАППИНГ 11 статусов по design §5 (правила delegation-adapters.js: interrupted ДО failed; completed без structuredOutput -> failed no-structured-output БЕЗ ретрая; tool_budget_exhausted -> max_steps; acceptance_failed без исключения модели); триклассная классификация hostError: окно (quota/rate limit exceeded/limit reached/plan|billing limit, case-insensitive), перегрузка (overloaded/server busy/too many concurrent/try again later/529), прочее; windowClass=true только окно; usage к ЛЮБОМУ терминальному исходу (кроме unavailableContext), toolCalls/durationMs=0 = нет данных; :update-снимки НЕ суммируются; turnsObserved = последний снимок с usage последней попытки; dispose(): отписки + resolve pending {kind:cancelled}; после dispose ответы игнорируются; late response после таймаута игнорируется.",
  "Тест-таблица 11 статусов (строка на литерал); grace -> :cancel с телом; dispose-resolve; ignore-after-dispose; маркеры окна/перегрузки; usage terminal-only; гейты зелёные");

t("T6", S3, "briefs: рендер брифа задачи",
  "Поле: extensions/pi-fusion/briefs.ts + тесты. Формат design §4 Brief: контракт целиком JSON-блоком + разделитель; ## {title} (нормализованный валидацией, сырой id не попадает); instructions; Deliverable: если есть; Scope files: через запятую если есть. Чистые функции; в шов уходит только бриф.",
  "Тесты: все секции и их отсутствие; контракт целиком; humanised title; гейты зелёные");

t("T7", S3, "pool-fanout: клампы, FIFO, ротация, окно rate-limit, дренаж",
  "Поле: extensions/pi-fusion/pool/fanout.ts, test/pool.test.ts, test/window.test.ts. runFanout(deps) design §4: клампы maxParallel -> perModel(capacity=2*|workerModels|) -> tasks, ClampRow {field,requested,applied,reason}, первая строка requested=W_req, отдельной maxWorkers-строки НЕТ; пустая ротация -> pre-flight: все задачи немедленно failed(no-available-model), ClampRow noModels, 0 эмитов :request, attempts=0, без зависания (fake-таймеры); FIFO по индексам; dispatch при running<width И есть модель с runningByModel<2; round-robin с пропуском; ОКНО: счётчик per-model, window-класс инкрементирует, любой другой исход модели сбрасывает, >=5 подряд -> модель из activeModels (новые запуски и очередь на другие; бегущие дети НЕ отменяются — ни одного :cancel от пула; завершившиеся принимаются, упавшие терминальны); activeModels пусто -> незапущенная очередь дренится failed(no-available-model); НИКАКИХ перезапусков задач; timeout -> failed(timeout), модель не трогается; результат в порядке индексов.",
  "Тесты §11: факторы клампов и порядок строк; FIFO; per-model <=2 при 1/2/3 моделях; окно 5 подряд -> исключение + 0 :cancel + дети дорабатывают; дренаж; пустая ротация не оживает; timeout на единственной модели не дренит; гейты зелёные");

t("T8", S4, "report-retry: 1 коррективный ретрай отчёта",
  "Поле: extensions/pi-fusion/report/retry.ts, test/report-retry.test.ts. Триггер только schemaFailed; коррективный request ТОЙ ЖЕ модели: «Твой предыдущий отчёт нарушал схему: {fields}. Верни ТОЛЬКО JSON-отчёт о завершённой работе по схеме. Реализацию не повторять.» (fields = violatedFields); слот удержан; таймаут ретрая min(120s, task timeoutMs); повторный провал -> failed+schemaMissing:true; attempts=2; ретрай — НОВЫЙ запуск (nodeId #a2, не ловит duplicate_node); usage/turns суммируются по обоим запускам; окно НЕ инкрементируется.",
  "Тесты: schemaFailed -> ретрай той же модели; успех -> report; второй провал -> failed+schemaMissing attempts=2; usage суммирован; duplicate_node НЕ возникает; гейты зелёные");

t("T9", S4, "result + degradation: агрегат и честный отказ",
  "Поле: extensions/pi-fusion/result.ts, extensions/pi-fusion/degradation.ts, test/degradation.test.ts. result.ts: строки по исходным индексам; статусы TaskResult; error-коды (timeout|max_steps|schema-missing|seam-unavailable|no-available-model|host:<code>); timeout-подсказка «возможно, taskTimeoutMs мал»; usage totals только терминальные по всем попыткам, absent=unknown; usagePartial при хоть одной задаче без терминального usage (toolCalls/durationMs=0 не участвуют); turns сумма + turnsObserved fallback; текст-таблица id | status | summary | files + clamp-строки + usage-строка; отчёт учитывается только при completed. degradation.ts: preflight available()===false -> «fusion недоступен — делай работу сам», 0 воркеров; midrun unavailableContext -> задача failed(seam-unavailable), вызов продолжается, частичный результат; исключение модели при unavailableContext НЕ запускается.",
  "Тесты: порядок индексов при перемешанном завершении; usagePartial; no_changes сквозной; done с пустым filesChanged не превращается в no_changes; preflight 0 воркеров; midrun частичный; гейты зелёные");

t("T10", S4, "tool-wiring: index.ts fusion_delegate + config-bridge + E2E",
  "Поле: extensions/pi-fusion/index.ts (ЗАМЕНИТЬ заглушку), extensions/pi-fusion/config-bridge.ts, test/fanout-e2e.test.ts. registerTool fusion_delegate exposure direct + НЕМЕДЛЕННАЯ дизактивация setActiveTools(getActiveTools() без fusion_delegate) при enabled=false (активация — T12); outputSchema FanoutResult; structuredContent + текст-таблица + details; ВЕРХНЕУРОВНЕВЫЙ result.usage = FanoutResult.usage; execute: validate -> availability -> runFanout; Esc ctx.signal -> cancel in-flight + dispose (pending -> cancelled, частичный результат); finally dispose. config-bridge: read-only кэш {workers,maxParallel,taskTimeoutMs,workerModels,maxSteps}, до T11 — дефолты (workers 3, maxParallel 3, taskTimeoutMs 600000, maxSteps 60, workerModels []). E2E fake-pi два сценария design §10.9: (а) 5 задач / width requested 3 -> факт 2 (cfg.maxParallel>=3; ЯВНЫЙ assert ClampRow {field:perModel, requested:3, applied:2}) / 1 модель / timeout -> failed(timeout)+подсказка, вызов продолжается; (б) 5 задач / width 3 / 2 модели: 5 подряд window-429 от A -> A исключена из НОВЫХ запусков, очередь на B, дети A дорабатывают (завершившиеся приняты), ЯВНЫЙ assert 0 :cancel от пула; + микс исходов done/no_changes/failed/needs_orchestrator/schema-failed->ретрай ok/Esc.",
  "E2E (а) и (б) зелёные со всеми asserts §10.9; тул зарегистрирован, при enabled=false не в getActiveTools; Esc -> частичный результат с cancelled; гейты зелёные");

t("T11", S5, "config: fusion.json load/persist + валидация",
  "Поле: extensions/pi-fusion/config.ts, test/config.test.ts. ~/.pi/agent/fusion.json: enabled false, workers 3, maxParallel 3, taskTimeoutMs 600000, maxSteps 60, workerModels [], requireApproval true, blockedTools [fusion_delegate,subagent,codemode], leadBlockedTools [write,edit,bash]. Load: нет файла -> дефолты; битый JSON -> дефолты + warn; валидация типов/границ. Persist АТОМАРНО (tmp+rename). Путь от pi agent dir (PI_CODING_AGENT_DIR / ~/.pi/agent).",
  "Тесты: дефолты; битый JSON -> дефолты+warn; цикл load->persist->load; атомарность (нет частичного файла); границы; гейты зелёные");

t("T12", S5, "command: /fusion on|off|status|workers|model|timeout|help",
  "Поле: extensions/pi-fusion/commands.ts, test/command.test.ts. registerCommand fusion + getArgumentCompletions (on/off/status/workers/model/timeout/help/config); on/off: persist enabled + setActiveTools (включить/убрать fusion_delegate) + секция гайданса появляется/исчезает; workers/model/timeout меняют конфиг с валидацией; status печатает состояние (enabled, модели, ширина, таймаут, наличие агента); help — текст. Референс UX: pi-autoresearch extensions/pi-autoresearch/commands.ts. Состояние переживает рестарт (конфиг — истина).",
  "Тесты: каждая подкоманда меняет конфиг/активные тула; autocomplete выдаёт список; off снимает гайданс; гейты зелёные");

t("T13", S5, "guidance: секция ### fusion через before_agent_start",
  "Поле: extensions/pi-fusion/guidance.ts, test/guidance.test.ts. Порт стратегии atomic-agent (D:/Documents/Repositories/atomic-agent/src/prompt/fusion-guidance.ts + fusion-machine-facts.ts): при enabled — append секции ### fusion в systemPromptOptions (ИДЕМПОТЕНТНО, фикс. заголовок, нет дублей), НИКОГДА не forceSystemPrompt; при off секция не добавляется/снимается. Содержание: лид планирует/делегирует/проверяет; короткие самодостаточные брифы; проверка через evidence и/или верификационного воркера (своего bash у лида нет); needs_orchestrator = новый fan-out с путями в files. Machine facts: модели ротации, ширина, таймаут.",
  "Тесты: секция при on, исчезает при off, повторный before_agent_start без дублей; forceSystemPrompt не вызывается; гейты зелёные");

t("T14", S5, "worker-agent: fusion-worker.md + установщик",
  "Поле: extensions/pi-fusion/agents/fusion-worker.md, extensions/pi-fusion/worker-install.ts, test/worker-install.test.ts. Агент: name fusion-worker, defaultContext fresh, inheritSkills false; allowlist РОВНО read, grep, find, ls, bash, edit, write (НЕТ fusion/subagent/codemode); политика: одна задача, самодостаточный бриф, НЕ коммитить, bd НЕ трогать, проверки гнать и прикладывать вывод в evidence, отчёт СТРОГО по схеме (status/summary/filesChanged/evidence/residualRisks/replacedExistingFiles?/question при needs_orchestrator); вне скоупа файлов не писать. Установщик: idempotent copy в <agentDir>/agents/fusion-worker.md (версия в заголовке), вызывается из /fusion on/config при отсутствии. Формат агентов pi: референс C:/Users/user/.pi/agent/agents/*.md.",
  "Тест: установщик создаёт файл; повтор идемпотентен; в md нет запрещённых тулов в allowlist; формат валиден для pi; гейты зелёные");

t("T15", S5, "restrictions: лиду write/edit/bash заблокированы + barren-счётчик",
  "Поле: extensions/pi-fusion/restrictions.ts, test/restrictions.test.ts. Хендлер tool_call в ГЛАВНОЙ сессии: при enabled блокировать write, edit, bash ЦЕЛИКОМ (leadBlockedTools); текст отказа по состоянию (порт atomic-agent fusion-orchestrator-mode.ts): до первого fan-out — «планируй и делегируй — отправь fusion_delegate»; после fan-out — «отправь переделку: needs_orchestrator = новый fan-out, пути в files, не захватывай работу сам»; BARREN: 2 ПОДРЯД fan-out где все воркеры 0 шагов (turns/turnsObserved) — «воркер-нога не работает — скажи оператору»; мутации не разблокируются в рамках turn (сброс на turn_start); при off — пропуск; read-only тула не трогаются.",
  "Тесты: блок в режиме; пропуск при off; оба текста; переключение на barren после 2 пустых fan-out; неблокирующие тула проходят; гейты зелёные");

t("T16", S6, "live-smoke: тест-репо + pi -p короткие задания + README",
  "Поле: scripts/smoke/, smoke-repo/ (генерируется), README.md. (1) unit-live smoke за env PI_FUSION_LIVE_SMOKE=1 (вне npm test): реальный шовный вызов fusion_delegate с 2 микрозадачами (structured result — живой прецедент TD-002) + экспозиция (enabled=false -> тула нет в getActiveTools); (2) headless: генерируется тестовый git-репо (2-3 файла), pi -p с расширением и fusion on, короткое задание через fusion_delegate на >=2 задач; критерии: лид ответил, >=2 задач со статусами, лид НЕ пользовался write/edit/bash, usage суммирован; (3) деградация: fusion off/без шва -> «делай работу сам». README: установка, конфиг, контракт тула, ограничения, ссылки на спеку.",
  "pi -p прогон на тестовом репо зелёный: >=2 воркера завершились, отчёты полны, лид сам не писал; деградация честная; README полный; гейты зелёные");

const edges = [];
for (const [k, p] of Object.entries(parentOf)) edges.push({ from_key: k, to_id: p, type: "parent-child" });
const deps = {
  T2: ["T1"], T3: ["T1"], T4: ["T1"], T5: ["T3", "T4"], T6: ["T2"], T7: ["T5", "T6"],
  T8: ["T3", "T5"], T9: ["T5"], T10: ["T7", "T8", "T9"], T11: ["T1"], T12: ["T10", "T11"],
  T13: ["T11"], T15: ["T10", "T11"], T16: ["T12", "T13", "T14", "T15"],
};
for (const [k, ds] of Object.entries(deps)) for (const d of ds) edges.push({ from_key: k, to_key: d, type: "blocks" });

writeFileSync("scripts/bd-tree.json", JSON.stringify({ nodes, edges }, null, 1));
console.log(`nodes=${nodes.length} edges=${edges.length}`);
