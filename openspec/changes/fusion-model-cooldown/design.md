# Design: fusion-model-cooldown

## Контекст

FR-011 (design rev.5.2) сегодня: window-ошибка наращивает счётчик модели,
любой другой исход сбрасывает; при 5 подряд модель исключается до конца
вызова. Таймаут не считается против модели (§8 «не её вина»). Владелец
хочет немедленный кросс-вызовный кулдаун для window-ошибок **и таймаутов**,
длительность — из ошибки (fallback-поле), fail-fast при полной остывшей
ротации, полную видимость. Решения зафиксированы 2026-11-05.

## Решения

### D1 — Новое ядро `pool/cooldown.ts` (синглтон процесса)

Хранилище `Map<model, {until: number, reason: "window"|"timeout"}>` на
уровне модуля + чистые функции работы с ним, часовой интерфейс `Clock =
{ now(): number }` инъекцией (тесты — виртуальные часы; прод —
`Date.now`). API:

- `getCooldownStore()` — синглтон для проводки в index.ts (паттерн как
  `warnedOnce` в config.ts: module-level, живёт процесс);
- `enterCooldown(store, model, reason, durationMs, now)` — запись;
  модель уже в кулдауне — не сокращать остаток: до = max(текущий до,
  now + durationMs), причина обновляется по последней ошибке (спека
  «Повторная ошибка не сокращает»);
- `activeCooldowns(store, models, now)` — остывающие модели эффективной
  ротации с остатками (для pickModel, ширины и статуса);
- `sweep(store, now)` — удалить истёкшие (лязва на вызов).

Продукшн-синглтон создаётся в index.ts и передаётся в `runFanout` deps и в
`FusionCommandDeps.cooldowns()` — оба читают одно хранилище. Пул и команды
создают своё — только в тестах.

### D2 — Парсер retry-after `parseRetryAfterMs(text)`

Чистая функция в cooldown.ts: ищет в тексте ошибки первое подходящее время
по шаблонам (регистронезависимо):

- `try again in N s/sec/seconds`, `retry after N m/min/minutes`,
  `retry in N h/hours`, `wait N seconds`;
- составное `1m30s`, `2m 15s`, `1h5m`;
- одиночные `Ns`, `Nm`, `Nh` после слов-триггеров (retry/wait/again/try) —
  чтобы не ловить случайные числа; голые «30s» без триггера не считаются.

Возвращает `number | undefined` (мс). Результат клампится в границы
`FUSION_CONFIG_BOUNDS.modelCooldownMs` в fanout.ts на момент применения
(парсер остаётся чистым без знания о конфиге).

### D3 — Интеграция в `pool/fanout.ts`

- `FanoutDeps` получает `cooldowns: CooldownDeps` (store + clock; в тестах
  виртуальные). Прод-проводка — index.ts.
- `FanoutConfig` получает `modelCooldownMs: number` (фолбэк-длительность);
  `FusionConfig` расширяет — поле проходит через слои/origins/menu/persist
  автоматически (паттерн taskTimeoutMs).
- **Счётчик серий упраздняется**: `WINDOW_STREAK_LIMIT`, `windowStreak`,
  `accountWindow` удаляются. Новая логика в `settle`:
  - `hostError && windowClass` → `enterCooldown(model, "window",
    parseRetryAfterMs(message) ?? config.modelCooldownMs)`; модель
    снимается с диспетчеризации и остаётся в store до истечения
    (кросс-вызовность). **Переопределение против старого FR-011**:
    «исключён до конца вызова» больше нет — модель вне ротации ровно
    до истечения её кулдауна; диспетчеризация спрашивает store
    (`activeCooldowns`), и истёкшая запись немедленно возвращает
    модель в `activeModels` (возврат в середину вызова). Одна причина
    исключения (кулдаун), одно место возврата (истечение).
  - `timeout` → то же с reason "timeout" и длительностью
    `config.modelCooldownMs` (таймаут времени не несёт; решение владельца).
  - Прочие исходы модель не трогают (сброс серий больше не нужен — серий
    нет). `interrupted`/`cancelled`/`429-overload` и иные — не считаются.
- `excludeModel` сохраняется как «снятие с диспетчеризации» (запущенные
  дети доживают, очередь уходит другим), но ходит парой с записью в store
  и с автоматическим возвратом в `activeModels` при истечении кулдауна
  (см. выше; «до конца вызова» больше нет).
- `pickModel` дополнительно проверяет `activeCooldowns`: остывающая модель
  невидима для диспетчеризации; истёкшая — sweep убирает запись и модель
  снова доступна **в середине вызова** (возврат в ротацию).
- **Ширина**: в цепочку факторов добавляется `cooldown` ПОСЛЕ perModel:
  perModel сохраняет сегодняшнюю семантику (capacity = PER_MODEL_CAP ×
  workerModels.length — полная ротация), а новый фактор считает capacity =
  PER_MODEL_CAP × availableModels (доступные на момент планирования,
  аргумент `planFanoutWidth(call, config, availableModels)`). Строка
  появляется только когда фактор СВЯЗЫВАЕТ (capacity < текущей ширины) —
  как у всех факторов; несвязывающий кулдаун строки не даёт (3 модели /
  1 остывает / workers 3: capacity 4 ≥ 3 — строки нет, задачи просто идут
  на 2 доступных моделях). Крайний случай: availableModels = 0 → ширина 0
  и cooldown-строка (requested — текущая ширина до неё, applied 0,
  reason «all N model(s) cooling down until …») — форма как у сегодняшней
  noModels-строки (B-FINAL), fail-fast весь вызов; если до неё связал
  другой фактор (например maxParallel), cooldown-строка идёт за ним — не
  обязательно единственная. Без кулдаунов availableModels =
  workerModels.length, фактор никогда не связывает, цепочка байт-в-байт
  как сегодня (обратная совместимость). Clamp-строка — снимок на момент
  plan (как сегодня); по ходу вызова диспетчеризация использует фактически
  доступные модели, возвраты по истечении кулдаунов clamps не
  перезаписывают.
- **Fail-fast**: если после применения кулдаунов `activeModels` пуст на
  старте — весь вызов отказывает как B-FINAL: все задачи
  `no-available-model` с честной причиной «модели в кулдауне до HH:MM:SS»,
  clamps — строка cooldown. Если активные есть, но меньше задач — обычная
  очередь (как сегодня).
- Середина вызова, остыли все: `drainQueue(noModelResult)` — уже
  существует (B3/R2 drainage); summary уточняется про кулдаун.

### D4 — `seam/client.ts`: маркер 403

`WINDOW_MARKERS` пополняется `\b403\b`: тексты вроде «403 Forbidden»
квалифицируются window-классом. Код остаётся `failed` (существующая
семантика кода не меняется).

### D5 — Конфиг: поле `modelCooldownMs`

- `FUSION_CONFIG_DEFAULTS.modelCooldownMs = 300_000`;
- `FUSION_CONFIG_BOUNDS.modelCooldownMs = { min: 30_000, max: 3_600_000 }`;
- `readFields`/`snapshot`/`persistFusionConfig` — новое число по паттерну
  `taskTimeoutMs`;
- `config-bridge.ts` снапшот — добавить поле (шесть → семь полей);
- `commands.ts`: `FUSION_SUBCOMMANDS` не меняется (поле правится через
  `/fusion config`), status — строка `modelCooldownMs: ... [origin]`;
- `config-ui.ts`: NUMBER_KEYS/NUMBER_SPECS — новая строка числового поля
  modelCooldownMs в обеих локалях (RU/EN, паттерн taskTimeoutMs с
  суффиксом человеческого времени), правка как у taskTimeoutMs.

### D6 — Статус: остывающие модели

`FusionCommandDeps` получает `cooldowns(): Array<{ model: string; reason:
"window" | "timeout"; remainingMs: number }>`. `showStatus` выводит после
строки моделей строку на каждую остывающую модель эффективной ротации:
`  cooldown: <model> — <окно квоты|таймаут>, ещё <Ns>` (округление до
секунды, `Math.ceil`). index.ts биндит через тот же синглтон.

### D7 — ClampRow literal

`ClampRowSchema.field` пополняется `Type.Literal("cooldown")` — аддитивно,
существующие значения не меняются. `result.ts` (рендер текста для лида)
получает строку для нового поля.

### D8 — Тесты (TDD, красные пины первыми)

- `test/cooldown.test.ts` (новый): парсер retry-after (все формы,
  отсутствие, клампинг), store (вход/истечение/sweep/синглтон-изоляция
  тестов через фабрику), активные кулдауны на подмножестве ротации.
- `test/window.test.ts` (доп/переработка): первый 403 → кулдаун и
  исключение; первый таймаут → кулдаун; летящие дети не отменяются;
  перегрузка не считается; повторная ошибка не сокращает остаток
  (max-правило) и обновляет причину; streak-пины заменяются кулдаунными.
- `test/pool.test.ts` (доп): частичный кулдаун → clamp-строка cooldown;
  полностью остывшая ротация на старте → fail-fast no-available-model;
  истечение в середине вызова → модель возвращается; окно с retry-after
  «90 seconds» → длительность 90 000; окно без времени → modelCooldownMs.
- `test/fanout-e2e.test.ts` (доп): кросс-вызовность — второй вызов видит
  кулдаун из первого (прод-синглтон или общее store в тестовом deps).
- `test/seam-client.test.ts` (доп): «403 Forbidden» → windowClass true.
- `test/config.test.ts` (доп): modelCooldownMs слои/origins/bounds.
- `test/command.test.ts` (доп): статус показывает остывающие модели и
  остатки; поле modelCooldownMs с суффиксом источника.
- `test/config-ui.test.ts` (доп): строка меню modelCooldownMs в global и
  local-режимах.

### D9 — README

Раздел fan-out-моделей дополняется абзацем о кулдаунах: причины, время из
ошибки, поле modelCooldownMs, видимость в статусе и clamp-строках,
сброс перезапуском.

## Non-Goals

- Персистентность кулдаунов между запусками pi (сброс перезапуском —
  решение владельца).
- Раздельные кулдауны по проектам/сессиям (rate-limit аккаунтовый).
- Retry/re-run задач после возврата модели (каждый провал терминален —
  прежнее решение владельца 2026-10-31 не меняется).
- Кулдаун на `interrupted`/`cancelled`/overload — не считается.
