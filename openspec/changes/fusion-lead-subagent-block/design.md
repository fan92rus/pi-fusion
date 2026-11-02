# Design: fusion-lead-subagent-block

> Status: rev.2 (блок через конфиг `leadBlockedTools`, без отдельного гейта).

## 1. Конфиг

config.ts: `FUSION_CONFIG_DEFAULTS.leadBlockedTools` = `['write', 'edit', 'bash',
'powershell', 'subagent']`. Остальная механика (readFields, snapshot, persist,
config-ui) не меняется: список уже редактируемое поле конфига.

Семантика замещения (существующая, не меняется): явный список в fusion.json
полностью замещает дефолт. Поэтому:
- у пользователя с уже записанным списком дефолт не действует (см. proposal
  «Важный нюанс»; решение владельца — вариант (а) вручную либо (б) миграция с
  отдельным согласием);
- пины config.test.ts, фиксирующие дефолтный список, обновляются (добавляется
  `subagent`); пины, фиксирующие явный пользовательский список, не меняются.

## 2. Гейт

restrictions.ts не меняется: tool_call-гейт лида уже отказывает инструментам из
`leadBlockedTools` штатным текстом блок-листа. Проверка: при включённом fusion и
`subagent` в списке вызов `subagent` получает отказ; при выключенном fusion гейт
инертен (существующее поведение).

## 3. Guidance

BEHAVIOUR_LINES (guidance.ts) — новая строка, en, сразу после строки про
`fusion_delegate` (порядок строк зафиксирован в тесте):

`- While fusion is on, the native \`subagent\` tool is blocked for the lead (it is in
the lead block list): every delegation — workers, scouts, researchers, reviewers,
including independent gate-running reviews — goes through \`fusion_delegate\`. This
section supersedes ambient orchestration instructions (AGENTS.md §4,
subagent-orchestration skills).`

Строка не зависит от фактического содержимого `leadBlockedTools` (текст фиксирует
требование дисциплины); если владелец убрал `subagent` из списка — строка остаётся,
это осознанно: приоритет fusion-дисциплины задаётся промптом, блок — конфигом.
Альтернатива (условная строка по наличию `subagent` в списке) отвергнута: усложняет
guidance-facts ради редкого случая.

## 4. Тесты

- config.test.ts: дефолт содержит `subagent`; явный список без `subagent`
  сохраняется как есть (замещение не меняется); пины дефолта обновлены.
- restrictions.test.ts: при fusion on и `subagent` в leadBlockedTools → отказ
  штатным текстом блок-листа; при off → инертен. (Существующие пины блок-листа
  не меняются — добавляется только `subagent`-кейс.)
- guidance.test.ts: строка присутствует при enabled и отсутствует при off; порядок.
- config-ui.test.ts: пины меню не меняются (список не перечисляется отдельным
  пунктом; если UI показывает leadBlockedTools — проверить и обновить пин).

## 5. Файлы

extensions/pi-fusion/config.ts, extensions/pi-fusion/guidance.ts,
test/config.test.ts, test/restrictions.test.ts, test/guidance.test.ts,
extensions/pi-fusion/README.md (строка). Файлы гейта (restrictions.ts) — без правок
кода, только тестовый кейс.

## 6. Остаточные риски

- Внешние механизмы (шаблоны run-prompt с workflow-скриптами, запущенные до
  включения fusion) могут вызывать subagent в обход tool_call-гейта — тот же
  принятый остаток, что у остальных блокировок.
- Пользователь с явным списком без `subagent` (текущий fusion.json владельца) не
  получит блок до ручного добавления или миграции (см. proposal).
