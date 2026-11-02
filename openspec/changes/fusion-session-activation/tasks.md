# Tasks: session-only активация fusion

> Порядок: §1 (спецификация) → §2 (реализация) → §3 (приёмка). Реализация — только
> после ГОДЕН ревью §1 и явного утверждения владельца (включая OQ-A/OQ-B/OQ-C).
> Задачи — в bd (эпик pi-fusion-pu9); воркеры не трогают git/bd.

## 1. Спецификация и утверждение

- [x] 1.1 Независимое документное ревью черновика (fusion-reviewer, fresh, кросс-
  модель) до вердикта ГОДЕН. Раунд 1 (run c65c9407): НЕ ГОДЕН — 2 blockers, 7 majors,
  7 minors, 3 nits — закрыты в rev.2. Раунд 2 (run 848d4dd7): НЕ ГОДЕН — 1 blocker
  (шов isEnabled не получает ctx), 6 majors (getEntries vs getBranch; runFusionDelegate
  в index.ts; e2e-харнесс без sessionManager; пробел command.test 172–188 и
  tool-wiring 59/76; неполная карта §4), 8 minors, 2 nits — закрыты в rev.3
  (шов `(ctx) => boolean`; getBranch-семантика; перенос guard в 2.4; e2e-харнесс
  в §7; полные перечни; FusionGuidanceFacts; ошибки восстановления по-гейтно;
  реконсайл в обе стороны; идемпотентность vs ленивый restore; source-перезапись;
  config-bridge рационал; коллизии идентификаторов/in-memory в §9). Раунды 3–4
  (runs aba5cd65, 9f12eee2): rev.3 подтверждена, раунд 4 pass. Раунд 5
  (d244e5e5, после OQ-C-правки): fail — 5 находок env-семантики (источник 'env'
  в типе/FR-006; приоритет env vs явный off; пустое значение; переход env→history) —
  закрыты. **Раунд 6 (e32c9032): pass без находок — ревью сошлось.**
- [x] 1.2 Утверждение владельца: **получено 2026-11-02** — OQ-A «A» (исключить
  enabled, warn once + ignore), OQ-B «B» (fork/new — старт off, owner-фильтр),
  OQ-C «C — для pi -p нужен способ включения» (переменная запуска PI_FUSION_ON,
  FR-008; вариант «без канала» отвергнут). Пакет утверждён с этим изменением
  (rev.4); контрольное ревью OQ-C-правки — раунд 6 pass. **Спека ЗАМОРОЖЕНА**
  (правки — только новым проходом цикла).

## 2. Реализация (TDD; каждая задача — красный→зелёный; гейты волны зелёные)

- [x] 2.1 Живая сверка фактов API pi (design §2): getSessionId/getBranch/
  appendEntry/пятый аргумент execute/SessionStartEvent.reason/копирование
  CustomEntry при createBranchedSession — по dist и мини-пробой (печатать
  ExtensionContext обработчика session_start); доступность /fusion и
  PI_FUSION_ON в headless `pi -p`. Расхождения с design §2 — фиксация и правка
  спеки до кода. — Выполнено 2026-11-02 (fusion-worker scout, вход 115k): факты
  №1–7 подтверждены по dist с path:line; №8 частично: /fusion-команды
  зарегистрированы и доступны в headless (dialogs null), чтение PI_FUSION_ON —
  работа волны 2; живой запуск pi -p не гонялся (принято: живая проверка — 3.2).
  Расхождений с design §2 не найдено — правка спеки не потребовалась.
- [x] 2.2 `session-state.ts` + unit-тесты (design §7): owner-фильтр (репродукция
  «on в родителе → форк → off»), {enabled, source}, идемпотентность, изоляция,
  ленивый restore, env-активация PI_FUSION_ON. — Выполнено 2026-11-02 (w22):
  ActivationSource/SessionActivation, Map<sessionId>, applySessionStart
  (restore→env-приоритет с немедленной on-записью), setSessionEnabled
  (идемпотентность против лениво восстановленного), resetForTests; 20 тестов
  зелёные; файл перенесён в test/ в 2.3.
- [x] 2.3 `commands.ts`: turnFusion → session-state + appendEntry (без записи
  fusion.json; установка профилей сохраняется; идемпотентный on — реконсайл
  присутствия fusion_delegate); showStatus — флаг+source; идемпотентные сообщения;
  описания команд. FusionCommandDeps + fakes (design §5). Component-тесты §7.
  — Выполнено 2026-11-02 (w23): сессионные обёртки в deps, идемпотентные
  сообщения, showStatus флаг+source; тест перенесён в test/; пины переписаны
  под session-fakes.
- [x] 2.4 `index.ts` + `restrictions.ts` + `guidance.ts`: реконсайл session_start
  В ОБЕ СТОРОНЫ (restore до фильтра; on — гарантирует присутствие fusion_delegate);
  guard `runFusionDelegate` (index.ts:100) с текстом FR-004; шов isEnabled
  `(ctx) => boolean` с ленивым restore и по-гейтными отказами; собственный тип
  FusionGuidanceFacts; дочерние сессии без fusion-секции. Component-тесты §7
  (fake sessionManager в makePi). — Выполнено 2026-11-02 (w24): 190 тестов по
  5 файлам; typecheck падал только на fanout-e2e (закрыто в 2.6).
- [x] 2.5 `config.ts`/`config-bridge.ts`/`config-ui.ts`: исключение enabled из
  типа/defaults/snapshot/readFields/persist/bridge/ui; warn once per process;
  файл не перезаписывается. Тесты миграции §7. — Выполнено 2026-11-02 (w25):
  TDD красный 12/63 → зелёный 63/63; warn-миграция один раз на процесс.
- [x] 2.6 Перепись пинов по перечню design §7 (command — включая :172–188;
  config/config-ui/config-bridge/tool-wiring — включая :59/:76; fanout-e2e —
  включая харнесс :93–97 и :149) + README.md (сессионная модель, миграция);
  полный прогон: `npm test` / `npm run typecheck` / `npm run lint` /
  `npm run build` зелёные. — Выполнено 2026-11-02 (w26): харнесс fanout-e2e с
  session-fake (on-запись владельца), литерал enabled убран, README переписан;
  полные гейты зелёные.

## 3. Приёмка

- [x] 3.1 Независимое adversarial-ревью волны 2 (fresh, кросс-модель; ревьюер сам
  прогоняет гейты; пробует опровергнуть изоляцию сессий, owner-фильтр форка,
  ленивый restore) → ГОДЕН; коммит волны; сводка в bd. — Выполнено 2026-11-02
  (run d9c4c973, opencode-go/beam-free, кросс-модель к пулу авторов): ГОДЕН,
  ноль находок; собственные прогоны: npm test 667/667 (22 файла), typecheck/
  lint/build exit 0; seam/pool/report/contract/briefs не тронуты; skip-тестов
  нет. Остатки: живая приёмка 3.2 и риск §9 (два процесса — принято).
- [ ] 3.2 Живая приёмка после перезапуска pi (design §8, все 7 пунктов, включая
  форк-кейс и headless PI_FUSION_ON); сводка в bd; отметить пункт.
- [ ] 3.3 Архивация изменения БЕЗ sync (skip_specs, design §10) + закрытие эпика
  bd pi-fusion-pu9.
