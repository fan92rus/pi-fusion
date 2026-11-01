# Project brief (L0) — pi-fusion

Updated: 2026-11-01 (проверил: оркестратор goal-кампании)

## Что это

Расширение pi coding agent «Fusion-режим»: лид (фронтир-модель главной сессии) получает
один тул `fusion_delegate` и делит работу на независимые задачи; пул дешёвых fresh-воркеров
(агент `fusion-worker`, delegation-шов pi-subagents) исполняет их параллельно и возвращает
структурные отчёты. Источник истины по требованиям/дизайну: `openspec/changes/archive/2026-11-01-legacy-sdd-import/specs/001-fanout-engine/`
(requirements.md + design.md rev.5.2, спека реализована в коде) и там же `PLAN.md`;
активный черновик — `openspec/changes/fusion-roles-and-lead-access/`.

## Commands (все из корня репо, Windows/MSYS bash)

- tests: `npm test` (vitest run) — timeout 300s
- typecheck: `npm run typecheck` (tsc --noEmit) — timeout 120s
- lint: `npm run lint` (biome check extensions test) — timeout 60s
- build gate: `npm run build` (tsc -p tsconfig.build.json --noEmit) — timeout 120s
- один тест-файл: `npx vitest run test/<файл>.test.ts` — timeout 60s

## Env gotchas

- Node >= 22 (проверено 22.20.0); TypeScript грузится pi через jiti — dist-эмита НЕТ,
  импорты с расширением `.ts` (как в pi-autoresearch), `allowImportingTsExtensions`.
- Расширение — обычный Node-процесс: setTimeout/Promise доступны (в отличие от
  песочницы workflow-скриптов).
- `.pi/` и `.auto/` в .gitignore; bd-данные в `.beads/` — НЕ коммитить незакоммиченные
  чужие правки, `git add` только путями своей задачи.
- Секвенция шва: события `prompt-template:subagent:request|started|update|response|cancel`
  на `pi.events`; эталон типов —
  `C:/Users/user/.pi/agent/npm/node_modules/pi-subagents/src/api/delegation.d.ts`;
  правила статусов — `.../src/slash/delegation-adapters.js` (interrupted ПРОВЕРЯЕТСЯ
  ДО failed; completed без structuredOutput → failed; usage `?? 0` = «нет данных»).
- Референс порт-кода валидации контракта: `D:/Documents/Repositories/atomic-agent/src/tools/fusion/delegate-args.ts` (строки 306–520), `contract.ts`, `contract-inputs.ts`.
- Live smoke: `pi -p` с тестовым репо (`scripts/smoke/`), короткие задания, env
  `PI_FUSION_LIVE_SMOKE=1` вне npm test.

## Do not touch

- `openspec/**` — спеки/изменения OpenSpec; правки только по явной задаче или план-циклу (ревью до ГОДЕН).
- `.beads/issues.jsonl` — bd трекер, пишет только оркестратор.
- Чужие незакоммиченные файлы в рабочем дереве.
