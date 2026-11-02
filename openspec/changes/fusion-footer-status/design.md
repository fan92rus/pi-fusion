# Design: fusion-footer-status

> Status: rev.2 (контрольный раунд 2 — ГОДЕН, run aab38392). Ссылки на API pi сверяются по установленному
> node_modules/@earendil-works/pi-coding-agent (dist) при реализации.

## 1. Механика

`ctx.ui.setStatus(statusKey, statusText)` — слот штатного футера (docs/tui.md
«Non-blocking feedback»; docs/rpc-extension-ui.md §setStatus: `statusKey`,
`statusText`; `undefined`/omission очищает запись). Штатный футер pi уже умеет
показывать extension-статусы (examples/extensions/custom-footer.ts читает их
через footerData.getExtensionStatuses()) — замена футера НЕ требуется.

Точный динамический_signature (арность, опции) воркер сверяет по
dist/core/extensions/types.d.ts перед кодом; расхождение с этим документом —
стоп и фиксация в отчёте.

## 2. Точки обновления (ровно две)

1. `session_start` (index.ts, существующий обработчик): ПОСЛЕ applySessionStart
   и реконсайла инструментов — `ctx.ui.setStatus('fusion', text)` c текстом по
   фактическому состоянию.
2. `turnFusion` (commands.ts): в конце обеих веток (on и off, включая
   идемпотентные повторы) — тот же вызов с текстом по состоянию ПОСЛЕ команды.

Единственная функция-помощник: `fusionFooterText(sm)` → `'fusion: on' |
'fusion: off'` (или эквивалент по месту) — значение из session-state текущей
сессии; вызов setStatus — в точках обновления с guard.

## 3. Guard записи

Критерий — только фактическое наличие UI-канала (`ctx.ui && typeof
ctx.ui.setStatus === 'function'`): покрывает `tui` и `rpc` с UI (fire-and-forget,
docs/rpc-extension-ui.md §setStatus); режимы без UI-канала (`print` — headless
`pi -p`, `json`) метода не предоставляют — тихий пропуск. Значение `ctx.mode`
(перечень `tui` | `rpc` | `json` | `print`, types.d.ts) критерием НЕ является и
не проверяется. Любой пропуск — тихий: без throw, без notify, без влияния на
остальную логику.

## 3a. Seam зависимостей

`FusionCommandDeps` (commands.ts) получает поле `setStatus(key: string, text:
string): void` — обёртку `ctx.ui.setStatus` с guard'ом §3 (no-op без UI-канала);
index.ts передаёт её при регистрации команд. turnFusion вызывает её в конце обеих
веток. Тестовые фейки: `makeDeps` (test/command.test.ts) и `makePi`
(test/tool-wiring.test.ts) получают fake setStatus, записывающий вызовы
(массив пар `[key, text]`); session_start-путь в index.ts использует тот же guard
напрямую через ctx.

## 4. Тесты

- Unit: текст по состоянию (on/off) из session-state (fake sm).
- Component commands: turnFusion on/off (включая идемпотентные) вызывает
  setStatus('fusion', ожидаемый текст) ровно с нужным текстом после команды
  (через deps.setStatus); фейк без UI-канала (guard no-op) — вызов не бросает
  и статус не пишется.
- Component index: session_start (resume с on-записью → 'fusion: on'; без
  записей → 'fusion: off') вызывает setStatus после реконсайла; ctx без
  setStatus — тихий пропуск.
- Пины существующих тестов: только добавления; существующие assert'ы не ослаблять
  (makeDeps/makePi при необходимости получают fake ui.setStatus, записывающий
  вызовы).

## 5. Изоляция

Файлы: extensions/pi-fusion/index.ts, extensions/pi-fusion/commands.ts,
затронутые тесты (test/command.test.ts, test/tool-wiring.test.ts),
extensions/pi-fusion/README.md (одна строка в описании команд/статуса).
Больше ничего. Сессионная модель, гейты, config, пул, seam — без изменений.

## 6. Остаточные риски

- Текст статуса обновляется только в двух точках; если состояние сессии изменится
  способом вне turnFusion/session_start (сегодня таких путей нет — env применяется
  на session_start), индикатор может отстать до следующего события. Принято.
- Внешний вид (разделители, порядок слотов в футере) — на усмотрение pi;
  расширение не управляет вёрсткой.
