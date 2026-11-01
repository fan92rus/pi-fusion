# Tasks: Роли fusion-агентов и доступ лида к openspec/

> Источник истины: [design.md](design.md) rev.3 (Approved, готово к реализации).
> Порядок = волны реализации в fusion-режиме. Внутри fusion ОДНА модель на все
> роли (TD-03): ревью — та же модель в роли reviewer, но fresh-контекст +
> опровергающий бриф + самостоятельный прогон тестов/сборки воркером-ревьюером;
> заявленные воркером числа без прогона ревьюера не считаются доказанными.
> Первый гейт — 1.1 (OQ-3 live smoke): без него researcher-задачи (3.x, 4.1)
> не стартуют. Любое отклонение от утверждённого дизайна — amendment
> план-цикла, а не тихая правка.

## 1. Гейты и подготовка

- [ ] 1.1 **T0 (OQ-3, гейт веб-роли):** live smoke доставки веб-тулов в fusion-ребёнка (pi-web-access / codex_search) по протоколу §13; результат (какой провайдер реально доступен ребёнку) фиксируется в отчёте и определяет дефолтную подсказку `researcherWeb`
- [ ] 1.2 Ручной junction-тест на Windows: `fs.realpathSync.native` vs `realpathSync` для junction/symlink — выбор вызова для `lead-access.ts` (§11, §13)

## 2. Схемы и валидация контракта

- [ ] 2.1 `types.ts`: `FusionTaskSchema` + опциональное `role` (enum worker|scout|researcher|reviewer); `TaskResultSchema` + опциональные ролевые поля; ролевые схемы отчёта (§4.1, §4.2)
- [ ] 2.2 `contract/validate.ts`: нормализация роли в `parseTask` (TASK_KEYS), `ValidatedTask.role`; неизвестная роль — отказ с понятной ошибкой; отсутствие роли = `worker` побайтово как сегодня (§4.2)
- [ ] 2.3 `report/schema.ts` + `report/validate.ts`: общий конверт + ролевые расширения; `violatedFields(report, role)` — схема по роли (§4.4)
- [ ] 2.4 `report/retry.ts`: роль в `SchemaRetryRequest`; корректив = бриф + size-limited `JSON.stringify` отвергнутого ответа (при наличии) + report-only формулировка «пришли отчёт, не переделывай работу» (§4.5; закрывает B3/B4/BL3/BL4)

## 3. Шов и пул

- [ ] 3.1 `seam/client.ts`: ролевая таблица `{agent, result.schema, toolBudget.block}` — worker-строка = сегодняшние константы (client.ts:26,28,314,320,328); `schemaFailed`-исход `SeamOutcome` + size-limited payload (§4.4, §4.5)
- [ ] 3.2 `pool/fanout.ts`: передача роли в `launch` и в ретрай; расписание/окно 429×5/клампы/дренаж — без изменений (§4.3)

## 4. Профили агентов (после 1.1 для researcher-составов)

- [ ] 4.1 `agents/`: `fusion-scout.md`, `fusion-reviewer.md`, `fusion-researcher.md` + варианты `-web`/`-codex`/`-both` — 7 записей; allowlist по §4.4/§4.9.3 (scout/reviewer — без edit/write; researcher — веб-имена ровно по составу `researcherWeb`; отсутствие веба — отчёт с `unknowns`, не догадки); версии независимые (§4.6)
- [ ] 4.2 `worker-install.ts`: `FUSION_ROLE_PROFILES` (7 записей `{name, filename, version}`) + `installFusionRoleAgents(options)`; сигнатура/исходы `installFusionWorkerAgent` сохранены (§4.6; B6)

## 5. Lead-гейт и конфиг

- [ ] 5.1 `lead-access.ts` (новый, чистые функции): резолвер границы — `join(realpath(root),"openspec")` → `realpath` цели (следовать ссылке, OQ-4); `lstat` каждого существующего компонента кандидата/предков/границы, dangling → отказ; первозапусковая база сравнения §5.2.4; perl-классификатор одиночного вызова (§5, §6; B1/B2/F2)
- [ ] 5.2 `restrictions.ts`: условные исключения в `tool_call`-гейте — штатные `write`/`edit` внутри границы и одиночный `perl` для документации; добавочная строка причины отказа «вне `openspec/` код пишут воркеры…»; прочее — без изменений (§5.1, §6)
- [ ] 5.3 `config.ts`: дефолт `leadBlockedTools` = `["write","edit","bash","powershell"]` (OQ-1); новое поле `researcherWeb` ∈ `none|web|codex|both`, дефолт `none` (§4.9.3, §12 TD-08)

## 6. UX лида

- [ ] 6.1 `guidance.ts`: строки секции `### fusion` — роли, исключения («это проверяемая граница, не песочница»), состав отчётов по ролям (§7)
- [ ] 6.2 `commands.ts` / `config-ui.ts`: нотификация установки/обновления по каждой из 7 записей манифеста; проверка «все профили на месте» (§7, §4.10)

## 7. Тесты и приёмка

- [ ] 7.1 Новые тесты по §8: ролевая нормализация/отказ, ролевые схемы отчётов, retry (report-only + payload), граница (внутри/за границей/ссылка наружу из проекта в пределах границы/висячие компоненты/первозапуск), perl-классификатор (кавычки/backslash-обход), preflight-составы, установка 7 записей
- [ ] 7.2 Обновить существующие пины (§8 «Существующие тесты»): текст guidance (:36), `correctiveRequest` (retry.ts:41-46), дефолт `leadBlockedTools` (config.ts:47 + powershell), комментарий test/report-retry.test.ts:213 («value is dropped» — после B3 значение доставляется)
- [ ] 7.3 Приёмка: `npm test` / `npm run typecheck` / `npm run lint` / `npm run build` — зелёные; живой прогон: лид в fusion делегирует задачи разных ролей, отчёты ролевые; независимое ревью каждой волны; сводка в bd
