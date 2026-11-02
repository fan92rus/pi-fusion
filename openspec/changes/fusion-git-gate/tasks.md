# Tasks: fusion-git-gate

> Порядок: §1 → §2 → §3. Код — только после ревью 1.1 (rev.2) и явного утверждения.

## 1. Спецификация и утверждение

- [x] 1.1 Независимое документное ревью (fusion-reviewer, fresh, кросс-модель). Раунды 1–5
  НЕ ГОДЕН (run 10e6715d, 5ffb4b16, c97a1dd5), раунд 6 ГОДЕН на rev.7 (run 4abc19d3,
  beam-free), openspec validate --all exit 0. Решения владельца по OQ-2..OQ-6 — в requirements.md.
- [x] 1.2 Утверждение владельца: «давай все кроме force и удаления» (2026-11-02). Аменд —
  по умолчанию запрещён, ждёт отдельного подтверждения (OQ-2).

## 2. Реализация (TDD)

- [x] 2.1 Red: тесты design §3 (разрешённые/отказные строки, gateDecision при on/off). Выполнено: test/lead-access.test.ts (циклы по GIT_RULES §3.1–§3.2, requireAny §3.3, кластеры/=-формы §3.4, ложные отказы §3.5, оболочка §3.6, классификатор ветки git); test/restrictions.test.ts (gateDecision on allow/deny, shellPath, off и child — inert). Красный прогон до реализации: test/lead-access.test.ts упал на сборке (GIT_RULES не экспортирован), 0 тестов выполнено.
- [x] 2.2 Green: GIT_DENY_* таблицы, isSingleGitInvocation, classifyBashCommand и
  gateDecision (design §1–§2). Гейты design §4 зелёные. Выполнено: GIT_RULES (таблица design §2, имя
  вместо GIT_DENY_*), isSingleGitInvocation, ветка git в BashClassification/classifyBashCommand,
  ветка git в gateDecision через общий путь bd (shellRefusal с 'git'). Текст «other» НЕ менялся
  (решение владельца/супервизора: FR-006 важнее design §1). Гейты: vitest 22 файла, 1340 тестов
  exit 0; typecheck exit 0; biome check (4 файла) exit 0; build exit 0.
- [ ] 2.3 Строка guidance и README — только после утверждения формулировки.

## 3. Приёмка

- [x] 3.1 Опровергающее ревью (другая модель): мутации на каждое правило FR-003/FR-004,
  обходы (-C, -c, цепочки, $() в аргументах, `push origin +main`, `branch -D`).
- [ ] 3.2 Коммит и push.
- [ ] 3.3 Живая приёмка после перезапуска pi.
