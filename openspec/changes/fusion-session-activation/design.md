# Design: session-only активация fusion

> Status: ЧЕРНОВИК rev.3 — правки по ревью 1.1 (раунды 1–3; runs c65c9407, 848d4dd7,
> aba5cd65). До независимого ревью до ГОДЕН и утверждения владельца. Ссылки на код
> pi — по установленному node_modules/@earendil-works/pi-coding-agent (dist),
> проверяются задачей 2.1.

## 1. Кратко

Активация fusion переезжает из глобального `fusion.json` (`enabled`) в память
сессии pi: runtime-отображение `sessionId → {enabled, source}` с восстановлением
из истории сессии (session-entries с фильтром владельца) на каждом `session_start`
и ленивым fail-closed восстановлением при промахе. Разделяемая конфигурация
сохраняет состав, кроме поля `enabled` (исключается, OQ-A).

## 2. Факты API pi (по dist установленного pi; сверяются задачей 2.1)

- `ExtensionContext` НЕ имеет поля sessionId (dist/core/extensions/types.d.ts:213–230).
  Идентификатор: `ctx.sessionManager.getSessionId()` (session-manager.d.ts:246;
  ReadonlySessionManager :178 — getSessionId/getEntries/getBranch).
- Чтение истории для восстановления — ТОЛЬКО `ctx.sessionManager.getBranch()`
  (активная ветвь, session-manager.js:1062–1072); `getEntries()` возвращает ВСЕ
  ветви файла (:1107–1109) и не применяется. Записи активации сбрасываются на
  диск вместе с первым сообщением (persist откладывается до него — :794–812,
  потери нет: записи остаются в памяти до флеша).
- Запись: `pi.appendEntry(customType, data)` (types.d.ts:1272; CustomEntry —
  session-manager.d.ts:81–85).
- Обработчики событий получают `(event, ctx)` (types.d.ts:1182); tool-функции
  получают ctx пятым аргументом: `execute(toolCallId, params, signal, onUpdate,
  ctx: ExtensionToolContext)` (types.d.ts:514; index.ts:190 — как в
  `runFusionDelegate`).
- `SessionStartEvent.reason ∈ {startup, reload, new, resume, fork}` (types.d.ts:578).
- Ветвление: `/fork` с targetLeafId → `sessionManager.createBranchedSession`
  (agent-session-runtime.js:220–240), который копирует записи пути, включая
  CustomEntry (session-manager.js:1205–1260, новый sessionId :1277/:1307) — без
  фильтра владельца форк унаследовал бы on/off родителя (блокер ревью 1.1).
- `pi -c`/continue и повторное открытие файла сохраняют идентификатор сессии из
  заголовка (session-manager.js:700–721, open/continueRecent :1326–1362) —
  owner-фильтр находит свои записи. Присутствие инструментов при возобновлении
  восстанавливается из транскрипта (agent-session.js:1385–1412) и НЕ
  гарантируется само по себе — требуется реконсайл FR-004а. Дефолтная причина
  session_start — 'startup' (agent-session.js:199).

## 3. Контракт состояния сессии

Новый модуль `extensions/pi-fusion/session-state.ts`:

```ts
type ActivationSource = 'memory' | 'history' | 'default-off';
type SessionActivation = { enabled: boolean; source: ActivationSource };
isSessionEnabled(sm: ReadonlySessionManager): boolean;          // с ленивым восстановлением
getSessionActivation(sm: ReadonlySessionManager): SessionActivation;
setSessionEnabled(pi: ExtensionAPI, sm: ReadonlySessionManager, v: boolean): void;
resetForTests(): void;
```

- Хранилище — `Map<string, SessionActivation>` в памяти процесса. Ключ —
  `sm.getSessionId()`.
- Формат history-записи: `customType: 'pi-fusion.activation'`, data
  `{ owner: <sessionId>, enabled: boolean, ts: number }`. Восстановление
  применяет только записи с `owner === sm.getSessionId()` (FR-002): унаследованные
  при ветвлении записи чужого владельца инертны — `/fork` и `/new` стартуют off
  без специального разбора reason.
- `isSessionEnabled`: нет записи в Map → синхронное восстановление из
  `sm.getBranch()` (последняя применимая запись) с записью в Map и
  `source: 'history'`; применимых записей нет → `{enabled:false, source:'default-off'}`
  (тоже кэшируется). Restore ПЕРЕЗАПИСЫВАЕТ источник (memory→history при reload).
  Ошибка чтения/разбора — не глотается: прокидывается вызывающему гейту,
  поведение по-гейтно — FR-004(в).
- `setSessionEnabled`: Map + `pi.appendEntry`; идемпотентные повторы (on во
  включённой / off в выключенной — сравнение с ЛЕНИВО ВОССТАНОВЛЕННЫМ значением)
  НЕ пишут новую history-запись (FR-006); идемпотентный on сохраняет реконсайл
  присутствия fusion_delegate (FR-004а).
- Межпроцессного разделения нет: каждый процесс pi держит свой Map. Два процесса
  над одной файловой историей сессии — остаточный риск (§9), не блокер.

## 4. Полная карта точек чтения/записи `enabled` (пересчитана по grep `enabled` по extensions/*.ts и README на rev.3)

| Файл:строки | Сейчас | Станет |
|---|---|---|
| commands.ts:3,6 (импорт/комментарий), :48,52,57 (описания «persist enabled»), :204 (комментарий), :215 (сообщение) | глобальная семантика | описания/сообщения/комментарии — сессионная семантика; идемпотентные сообщения FR-006 |
| commands.ts:209 turnFusion persist | пишет `enabled` в fusion.json | session-state + appendEntry; файлов активации не пишет; установка профилей (`installRoleAgents`) сохраняется — не активация (FR-001) |
| commands.ts:~226–254 `showStatus` | глобальный `enabled` | флаг+источник текущей сессии (FR-006) |
| index.ts:100 `runFusionDelegate` + :190 execute (ctx — 5-й аргумент) | без проверки | самостоятельная проверка флага; off → отказ «fusion выключен в этой сессии — включите /fusion on»; ошибка восстановления → отказ «не удалось восстановить состояние сессии» (FR-004б/в) |
| index.ts:147 `registerFusionDelegate(config: FanoutConfig & { enabled: boolean })` + :9, :265 комментарии | тип несёт enabled | тип без enabled (флаг — сессия); комментарии — сессионные |
| index.ts:193–203 (обработчик session_start, читает readConfig().enabled и снимает инструмент) | глобальный флаг, только снятие | restore ДО фильтра; реконсайл В ОБЕ СТОРОНЫ: off — снимает, on — гарантирует присутствие fusion_delegate (FR-004а) |
| index.ts:270 (привязка isEnabled) + restrictions.ts:127,502 | шов `isEnabled: () => boolean`; замыкание без ctx; false → гейт инертен | шов `isEnabled: (ctx) => boolean` (index.ts:270 передаёт ctx; дублёры `() => boolean` в тестах остаются присвоимыми — меньшая арность); реализация: sessionManager отсутствует → инертен; промах Map → ленивый restore; ошибка восстановления → отказ мутаций «не удалось восстановить состояние сессии» (FR-004в) |
| index.ts:262 registerFusionGuidance + guidance.ts:18 (import FusionConfig), :24,27 (`Pick<FusionConfig,'enabled'|…>`), :95,103,112–116 (facts) | глобальный флаг в фактах; Pick по типу с enabled | собственный тип `FusionGuidanceFacts` (enabled поставляется замыканием facts из index.ts:262 по сессии); дочерние сессии fusion-секцию НЕ получают (намеренное изменение, FR-007) |
| config.ts:23,48,115,174,232 (FusionConfig, defaults/snapshot/readFields/persist) | поле `enabled` | поле исключено; чтение с `enabled` в файле → warn один раз на процесс (флаг модуля), файл не перезаписывается (FR-005) |
| config-bridge.ts:8,19,29,75 (тип FusionConfig, readFusionConfig) | включает enabled | поле исключено из общего типа; `readFusionConfig` сохраняется как thin-обёртка чтения для тестов (production читает через config.ts `loadFusionConfig`); тип из bridge используется guidance.ts:18 — без enabled |
| config-ui.ts:113,215 (строка режима), :246 (пункт меню enabled), :268 (`editEnabled`), :280 (editEnabled→turnFusion), :284 (комментарий), :441 (dispatch) | редактирование enabled в разделяемом конфиге | пункт меню/editEnabled/строка enabled удалены; config-меню НЕ показывает и НЕ меняет состояние сессии (активация — только /fusion on|off, состояние — /fusion status) |
| README.md:28,42,55,89 (enabled/«persists enabled») + :92 («/fusion off frees the lead») | документирует глобальную модель | сессионная модель, миграция warn+ignore (задача 2.6); строка :82 (автоустановка профилей) не про enabled — не меняется в этой части |
| scripts/bd-tree-gen.mjs:57,60,64,68 (текст генератора) | исторический текст про persisted enabled | НЕ обновляется (генератор исторических bd-деревьев); помечено здесь явно |

`registerTool` выполняется один раз при загрузке без сессии (и `fusion_delegate`
объявлен активным по умолчанию — agent-session.js:2961) — регистрация остаётся
безусловной; видимость обеспечивают реконсайл session_start (index.ts:193–203)
и guard в `runFusionDelegate` (FR-004а/б).

## 5. Зависимости команд (FusionCommandDeps)

Интерфейс (commands.ts ~:60–110) получает поля для сессии: `sessionId()` (или
передача ReadonlySessionManager), `getActivation()` / `setActivation(v)` (обёртки
session-state), `appendEntry(type, data)`. Это же добавляется в fakes тестов:
command.test.ts `makeDeps` (:25–60), config-ui.test.ts `makeDeps`,
tool-wiring.test.ts `makePi` (:21–51 — fake sessionManager с getSessionId/
getBranch/appendEntry; fire(event, ctx) с ctx). Шов restrictions —
`isEnabled: (ctx) => boolean` (FR-004в): дублёры `() => boolean` в
restrictions.test.ts:101–126 остаются присвоимыми (меньшая арность), сигнатура
гейта меняется. Тестовый ctx без sessionManager (например, fanout-e2e) —
инертен по FR-004в, но e2e-харнесс получает session-fake (см. §7).

## 6. Жизненный цикл сессии

1. `session_start(S, reason)` → restore: последние применимые (owner===S) записи;
   `resume`/`reload`/`startup` с историей → последнее решение; `new`/`fork` →
  своих записей нет → off. Restore выполняется ДО фильтра index.ts:193–203.
2. `/fusion on|off` в S → setSessionEnabled (+appendEntry), идемпотентность FR-006.
3. tool_call / `fusion_delegate` / формирование guidance в S → флаг сессии
  (ленивое восстановление при промахе — §3).
4. Headless: та же модель; включение — только собственная on-запись сессии
   (OQ-C; доступность команд в headless проверяет 2.1).

## 7. Тесты (TDD; hermetic)

- **Unit session-state:** set/get {enabled, source}; restore по owner-фильтру
  (своя запись применяется, чужая игнорируется — репродукция блокера форка:
  «on в родителе → форк → off»); restore ТОЛЬКО из активной ветви getBranch
  (запись на другой ветви файла игнорируется); пустая история → default-off
  (кэшируется); последняя применимая запись выигрывает; restore перезаписывает
  источник (memory→history); идемпотентные set не пишут запись и сравнивают с
  лениво восстановленным значением; изоляция двух sessionId; resetForTests;
  ошибка чтения истории прокидывается (поведение гейтов — ниже).
- **Component commands (fake deps §5):** on/off меняет только свою сессию; НЕТ
  записи fusion.json (fake fs: ни одного write в fusion.json; установка профилей —
  отдельно мокается как прежде); отказ runFusionDelegate при off с точным текстом;
  showStatus — флаг+source; /fusion config не меняет активацию; идемпотентные
  сообщения (включая команду при Map-промахе с on-записью в истории).
- **Component index/гейты (fake host с session fake):** session_start(resume с
  on-записью) → инструмент ПРИСУТСТВУЕТ (реконсайл в обе стороны), гейт активен;
  session_start(new/fork с унаследованными чужими записями) → off, инструмент
  снят; промах Map (tool_call без предшествующего session_start) → ленивый
  restore, гейт не «молчит»; ctx без sessionManager → гейт инертен; ошибка
  восстановления → отказ мутаций с текстом FR-004в; две сессии изолированы.
- **Config-миграция:** чтение с `enabled: true` → warn (ровно один на процесс),
  значение игнорировано, файл не переписан; persist не пишет enabled; config-ui
  без строки enabled; тип FusionConfig без поля (fanout-e2e литерал).
- **E2E-харнесс:** test/fanout-e2e.test.ts:93–97 — ctx без sessionManager
  получает session-fake с on-записью (или регистрация теста через фейк сессии),
  иначе ~20 execute-тестов (:160–617) упадут на guard FR-004б — изменение
  харнесса входит в задачу 2.6.
- **Перепись пинов (исчерпывающий перечень):** test/command.test.ts:146–175
  (persist enabled), :172–188 (keeps-the-tool при enabled:true + сообщение
  «fusion: on.» :184 — идемпотентный сценарий FR-006), :191–206 (off), :329–334
  (status enabled: true), :356–357, :381–383 (guidance после on/off), :423–426,
  :494–506 (persisted.enabled); test/config-ui.test.ts:181–197 (строка enabled);
  test/config.test.ts:36, :113, :161–169 (warn), :183, :240–252, :271–274;
  test/config-bridge.test.ts:27, :41, :51, :63; test/tool-wiring.test.ts:53–54,
  :59, :76 (registerFusionDelegate с enabledConfig — сигнатура index.ts:147
  меняется), :82–98 (session_start без ctx); test/fanout-e2e.test.ts:93–97
  (харнесс) + :149 (литерал enabled). Сохраняются совместимыми: test/guidance.test.ts
  (факты — параметры собственного типа), все тесты ролей/исключений/пула/seam;
  test/restrictions.test.ts — дублёры `() => boolean` присвоимы новому шву
  `(ctx) => boolean`, пины поведения лида не меняются.

## 8. Развёртывание и живая приёмка

- Требуется перезапуск pi. После него НОВЫЕ сессии стартуют off; сессия,
  возобновляемая со своей историей (resume/continue), восстанавливает своё
  последнее решение (FR-003). Рабочая сессия владельца включает `/fusion on`.
- Живая приёмка (6 пунктов): (1) `/fusion on` в сессии A не включает fusion в
  параллельной сессии B (статус off, ограничения не действуют); (2) resume/reload
  сессии A восстанавливает on; (3) `/fork` от включённой A стартует off
  (репродукция блокера); (4) `fusion_delegate` при off отказывает с текстом
  FR-004; (5) глобальный `fusion.json` не изменяется после on/off (mtime/контент);
  (6) headless-поведение по решению OQ-C.

## 9. Остаточные риски (принимаются явно)

- Два процесса pi над одной файловой историей сессии: у каждого свой Map,
  обновление только на session_start — возможна устаревшая копия до следующего
  session_start; не блокер (активация расходится не дальше собственного решения
  сессии).
- Коллизия идентификаторов: Map и owner-фильтр ключуются sessionId из заголовка
  файла; копия файла сессии (или один файл в двух процессах) делит одну запись
  Map в процессе. Считается допустимым: идентификаторы уникальны в норме.
- In-memory-сессии без персистентной истории (session-manager persist=false):
  пути «resume с on-записью» нет — активация живёт только в памяти процесса;
  относится и к headless-режимам без файла сессии (OQ-C).
- Поведение pi проверено по dist (§2), не живым прогоном; живая сверка — задача 2.1
  и приёмка §8.
- Доступность интерактивных команд в headless — внешний факт (2.1).

## 10. skip_specs

Изменение объявляет `skip_specs: true`: базовых спек в openspec/specs нет, дельты
не пишутся; задача 3.3 формулируется как «архивация БЕЗ sync» (синхронизировать
нечего — поведение документируется артефактами изменения).
