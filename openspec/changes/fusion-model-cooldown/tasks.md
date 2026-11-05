# Tasks: fusion-model-cooldown

> Порядок: §1 (спецификация и утверждение) → §2 (реализация) → §3 (приёмка).
> Реализация — только после ревью 1.1 и явного утверждения владельца
> (план-цикл plan-loop). Задачи — в bd; воркеры не трогают git и bd.

## 1. Спецификация и утверждение

- [x] 1.1 Независимое документное ревью черновика (fresh fusion-reviewer,
  кросс-модель, опровергающее) → ГОДЕН; находки закрыты; контрольный раунд
  при необходимости. Критерий: вердикт pass, blockers закрыты.
  (Отработано 2026-11-05, 3 раунда: r1 fail — 3 блокера (двойное
  исключение excludeModel+store против возврата в середину вызова;
  вакуумный гейт test/fanout.test.ts; ширина без входа для cooldown-
  строки) закрыты; r2 fail — контрольный: r1-блокеры подтверждены
  закрытыми, но найдены 3 дефекта (несводимость сценария ширины,
  LIST_SPECS→NUMBER_SPECS, повтор-не-сокращает); r3 pass — все фиксы
  подтверждены, 2 нита закрыты точечно.)
- [ ] 1.2 Утверждение владельца пакета спеки → заморозка. Критерий: явное
  согласие владельца в сессии.

## 2. Реализация (TDD)

- [ ] 2.1 `pool/cooldown.ts`: ядро — фабрика хранилища, Clock-интерфейс,
  enterCooldown/activeCooldowns/sweep, парсер parseRetryAfterMs (формы
  D2, чистый). Тесты `test/cooldown.test.ts`: парсер (все формы, отсутствие
  времени, большие/малые значения), store (запись, истечение, sweep,
  изоляция фабрики), остатки для подмножества ротации.
  Критерий: `npx vitest run test/cooldown.test.ts` зелёный.
- [ ] 2.2 `pool/fanout.ts` + `seam/client.ts` + `types.ts`: интеграция
  кулдауна (deps cooldowns с прод-синглтоном из index.ts), упразднение
  streak-счётчика, pickModel-пропуск остывающих, возврат по истечении,
  фактор cooldown в planFanoutWidth (literal в ClampRowSchema), fail-fast
  при пустой activeModels на старте, честный noModelResult; маркер
  `\b403\b` в WINDOW_MARKERS.
  Тесты: scenarios из design D8 в СУЩЕСТВУЮЩИХ файлах (новые describe в
  `test/window.test.ts` — кулдаунные исходы вместо streak-исходов;
  `test/pool.test.ts` — ширина/клампы; `test/fanout-e2e.test.ts` —
  кросс-вызовность) + «403 Forbidden» → windowClass в
  `test/seam-client.test.ts`. Обновить СУЩЕСТВУЮЩИЕ пины window-тестов
  под новое поведение (streak-пины умирают — упразднены намеренно).
  Критерий: `npx vitest run test/window.test.ts test/pool.test.ts
  test/fanout-e2e.test.ts test/seam-client.test.ts` зелёный.
- [ ] 2.3 `config.ts` + `config-bridge.ts` + `commands.ts` +
  `config-ui.ts` + `index.ts` + `README.md`: поле modelCooldownMs во все
  слои (defaults/bounds/readFields/snapshot/persist/bridge), строка
  статуса с остывающими моделями (deps cooldowns), строка меню в двух
  локалях, проводка синглтона в index.ts, раздел README.
  Критерий: `npx vitest run test/config.test.ts test/command.test.ts
  test/config-ui.test.ts test/config-bridge.test.ts test/tool-wiring.test.ts`
  зелёный.

## 3. Приёмка

- [ ] 3.1 Независимое adversarial-ревью волны (fresh fusion-reviewer,
  кросс-модель): свои прогоны всех гейтов; мутационные проверки ключевых
  пинов (парсер, кулдаун-исключение, fail-fast, кросс-вызовность,
  403-классификация); сверка со спекой и дизайном. Вердикт ГОДЕН →
  точечный коммит.
- [ ] 3.2 Живая приёмка после обновления установленной копии: реальный
  кулдаун на живой модели (403 или таймаут), статус показывает модель и
  остаток, следующий вызов не идёт на остывающую модель, возврат в
  ротацию по истечении. Сводка в bd.
- [ ] 3.3 Архивация изменения + закрытие bd-эпика. Критерий:
  `openspec validate --all` зелёный, изменение в archive.

## Workflow follow-up

- После 3.2 — обновить установленную копию (push + pull в
  `~/.pi/agent/git/github.com/fan92rus/pi-fusion`) и перезапустить pi.
