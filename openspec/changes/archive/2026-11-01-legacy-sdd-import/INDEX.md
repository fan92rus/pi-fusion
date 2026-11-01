# SDD Index — pi-fusion

| Артефакт | Статус | Путь |
|----------|--------|------|
| Idea 001: Fusion-режим для pi | captured | [.ai/sdd/ideas/001-fusion-mode-for-pi.md](ideas/001-fusion-mode-for-pi.md) |
| PLAN (проектный) | **plan:approved** | [.ai/sdd/PLAN.md](PLAN.md) |

## Планируемые спеки

| # | Спека | Покрывает | Статус |
|---|-------|-----------|--------|
| 001 | fanout-engine | F04, F05, F06, F07, F09 (+FR-011 model-window — часть F06) | design:draft |
| 002 | fusion-roles-and-lead-access | уточнения F03, F04, F08, F19 | design:draft |
| 003 | lead-session-enforcement | F10, F11, F12, F13, F19, F20 | — |
| 004 | config-menu | F14 | — |
| 005 | config-command-agent (планировалась как 002) | F01, F02 | — |

Ранее запланированная `config-command-agent` не создавалась; номер 002 выделен фактически созданной спеке. Покрытие F01 (fusion-config) и F02 (fusion-command) остаётся незакрытым и закреплено за планируемой спекой 005 — план оставшейся работы остаётся прослеживаемым. Номера определяются по файловой системе (см. sdd-practical).
