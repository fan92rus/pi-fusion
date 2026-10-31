# Идея 001: Fusion-режим для pi coding agent

> Status: captured
> Source: сессия анализа (2026-10-31)

## Проблема

В pi coding agent нет режима «одна модель планирует — пул дешёвых воркеров исполняет»
(Fusion из atomic-agent / Cognition). Фронтир-модель в главной сессии делает всю работу
дорого: чтения, черновики, шаблонный код, широкие поиски.

## Референсы

- **atomic-agent Fusion** (`D:\Documents\Repositories\atomic-agent`): лид = главная
  сессия; один тул `fusion.delegate` (контракт `{tasks:[{id, instructions, title?,
  deliverable?, files?, maxSteps?, timeoutMs?}], maxWorkers?, contract?}`); воркеры —
  эфемерные turn'ы (`s-w-`-сессии), не могут звать тул (рекурсия запрещена); один
  approval на fan-out со standing-yes на ход; статусы `done/failed/needs_orchestrator`;
  вне скоупа → именованный путь; гайданс `### fusion` в stable-prefix + machine facts.
- **Cognition «Local Fusion»**: lead (фронтир) + sidekick (дешёвый), обмен брифами и
  результатами, «price per task».
- **pi-subagents delegation-шов** (проверено в коде pi-autoresearch
  `council-delegation.ts`): расширение спавнит fresh-context детей через события
  `prompt-template:subagent:request|response|update|cancel`
  (`SubagentDelegationRequest`: agent, task, context, cwd, model, timeoutMs,
  toolBudget.block, result {kind:"text"|{kind:"structured", schema}}).
- **bskimball/pi Fusion** (Cognition-стиль lead+sidekick), **zerochc/pi-fusion** (MoA),
  **edxeth/pi-subagents** (orchestrator-режим) — частичные аналоги, точного нет.

## Согласованные решения (A–G)

- A: новый репозиторий `pi-fusion`.
- B: нога воркеров — ротация моделей, задаётся в конфиге (опционально локальный
  llama-server через models.json).
- C: `requireApproval: true` по умолчанию.
- D: отдельный агент `fusion-worker.md` с первого дня; allowlist-тулы
  (read, grep, find, ls, bash, edit, write) — без fusion/subagent/codemode; установка
  в `~/.pi/agent/agents/`; гвард рекурсии конструктивный (агенты не наследуют ambient
  extension-тулы) + `toolBudget.block` как страховка.
- E: гайданс — дополнение секции `### fusion` через `before_agent_start`
  (мутация `systemPromptOptions`), НИКОГДА `forceSystemPrompt`.
- F: имя тула — `fusion_delegate` (snake_case pi).
- G: команда `/fusion` с автодополнением подкоманд + интерактивное меню конфигурации
  в стиле pi-autoresearch (`ctx.ui.select/input/confirm/notify`, RU/EN-словарь),
  пункт меню «установить/обновить агента»; конфиг глобальный `~/.pi/agent/fusion.json`.
- H: ограничение лида механически (хендлер `tool_call`): при fusion блокируются
  `write`, `edit` и `bash` ЦЕЛИКОМ (через bash мутируют python/sed/redirect —
  классификация команд ненадёжна); следствие: лид не гоняет проверки сам —
  воркер прикладывает вывод в `evidence`, независимая верификация — делегирование
  свежему воркеру; оператор всегда может проверить в своём терминале.
  Уточнения после сверки с atomic-agent `fusion-orchestrator-mode.ts` (их гейт тоже
  отказывает лиду shell — мутации по readonly-флагу, все MCP fail-closed):
  текст отказа F19 зависит от состояния (до fan-out — «планируй и делегируй»,
  после — «отправь переделку, needs_orchestrator = новый fan-out»); мутации не
  разблокируются никогда в рамках turn'а (их урок: «открылось после первого
  fan-out» → лид сам написал 15 файлов); barren-счётчик — 2 fan-out'а с нулём
  шагов воркеров → «нога мертва, скажи оператору», а не «делегируй ещё»
  (BARREN_DELEGATION_LIMIT = 2); счётчик шагов — `turns` из `:update`-событий шва.
  F20 fusion_verify (Should): аналог их `verify.run` — расширение само запускает
  команду в одноразовой копии каталога (child_process, не bash лида), read-only-
  класс — гейт не блокирует; в MVP верификация = evidence воркера + верификационный
  воркер.

## Ключевые технические факты (проверены по докам/коду)

- `before_agent_start`: предпочтительно менять секции/тулы/гайдлайны (append-дельта);
  `forceSystemPrompt` заменяет весь промпт — не используем.
- Реестр/активный набор тулов разделены: exposure `codemode` не активируется при
  регистрации; включение — `pi.setActiveTools()`. Переключение mid-session может
  инвалидинировать кэш-префикс (приемлемо, как `/runmode` в atomic-agent).
- Кастомные тулы НЕ гейтятся автоматически — approval реализуем в `execute()` через
  `ctx.ui.confirm`; сброс standing-yes на `turn_end`.
- Тулах с nested model calls обязаны включать `usage` детей в результат (точность
  session totals) — агрегируем из `:update`-событий.
- Шов недоступен (`delegationAvailable(pi) === false` или `unavailable_context`) →
  честная деградация «делай работу сам» (ветка atomic-agent).
- Расширение = обычный Node-процесс: `setTimeout`/`Promise` доступны (в отличие от
  песочницы workflow-скриптов) — пул ширины тривиален.
- Ограничение: живые строки воркеров в ленте в MVP недостижимы (result тула
  одноразовый); кандидат — фаза 3 через `:update`.
