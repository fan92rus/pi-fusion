# Tasks: fusion-footer-status

> Порядок: §1 (спецификация) → §2 (реализация) → §3 (приёмка). Реализация —
> только после ревью 1.1 и явного утверждения владельца. Задачи — в bd;
> воркеры не трогают git/bd.

## 1. Спецификация и утверждение

- [ ] 1.1 Независимое документное ревью черновика (fusion-reviewer, fresh,
  кросс-модель) → ГОДЕН; находки закрыты, контрольный раунд при необходимости.
- [x] 1.2 Утверждение владельца пакета (владелец 2026-11-02: «реализуй спеку»; заморожено) (механизм: статус-слот футера;
  обновление на session_start И на каждый /fusion on|off — решение владельца
  2026-11-02). После утверждения — заморозка.

## 2. Реализация (TDD)

- [x] 2.1 Сверка сигнатуры setStatus (тесты: 1433 passed; гейты: vitest exit 0, typecheck exit 0, biome exit 0, build exit 0) по dist/types.d.ts (арность, опции,
  очистка; факт: `setStatus(key: string, text: string | undefined): void`;
  ExtensionMode = tui|rpc|json|print) + guard-условия (критерий — только наличие
  метода, НЕ значение ctx.mode; design §3). Реализация: helper текста + поле
  `setStatus` в FusionCommandDeps (design §3a) + вызовы в session_start
  (index.ts, после реконсайла) и turnFusion (commands.ts, обе ветки, включая
  идемпотентные); guard — тихий пропуск. Тесты design §4 (вкл. фейки makeDeps/
  makePi с fake setStatus). Гейты: npm test / typecheck / lint / build зелёные;
  README — строка про индикатор.

## 3. Приёмка

- [x] 3.1 Независимое adversarial-ревью волны (fresh, кросс-модель) → ГОДЕН после biome-фикса;
  ревьюер прогнал vitest 1433/1433, typecheck, biome, build (exit 0) и мутацию session_start
  setStatus (тест упал); замечаний нет. Коммит после этого ревью.
- [ ] 3.2 Живая приёмка после перезапуска pi (requirements FR-003, 5 пунктов);
  сводка в bd; отметить пункт.
- [ ] 3.3 Архивация изменения БЕЗ sync (skip_specs) + закрытие bd-эпика.
