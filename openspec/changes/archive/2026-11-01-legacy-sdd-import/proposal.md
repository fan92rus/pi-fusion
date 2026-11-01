# Legacy SDD Import

## Why

Проект мигрировал с процесса SDD (npm `@felipefontoura/pi-sdd-kit`, каталог `.ai/sdd/`)
на OpenSpec. Этот архив сохраняет все прежние SDD-документы дословно, чтобы при
удалении `.ai/sdd/` не потерять ни строчки утверждённых требований, проектного плана
и исследовательского контекста.

## What Changes

- Дословный (побайтовый) перенос документов SDD-процесса:
  - `PLAN.md` — утверждённый владельцем проектный план (F01–F20, фазы, риски);
  - `INDEX.md` — индекс спек SDD-процесса;
  - `ideas/001-fusion-mode-for-pi.md` — исходная идея и согласованные решения A–H;
  - `specs/001-fanout-engine/` — утверждённые требования и дизайн rev.5.2 движка
    fan-out (F04–F07, F09, FR-011 model-window).
- Спека 002 перенесена НЕ сюда, а в активное изменение
  `openspec/changes/fusion-roles-and-lead-access/` (см. его proposal.md).

## Status Mapping (на момент миграции, 2026-11-01)

| SDD-артефакт | Статус в SDD | Факт в коде | Где теперь |
|---|---|---|---|
| PLAN.md | plan:approved | частично реализован | этот архив |
| specs/001-fanout-engine | requirements:approved, design rev.5.2 (draft по .status) | **реализован в коде** (`extensions/pi-fusion/`: пул, шов, отчёты, окно 429×5) | этот архив |
| specs/002-fusion-roles-and-lead-access | requirements:approved (метка), design:draft, независимое ревью НЕ ГОДЕН (см. bd pi-fusion-8t2.1.*) | не реализован | активное изменение `fusion-roles-and-lead-access` |
| спеки 003–005 | только строки INDEX (никогда не создавались) | — | строки PLAN/INDEX в этом архиве |

## Impact

- Никакого кода. Файлы preserved as-is; раскладка сохраняет работоспособность
  относительных ссылок (`specs/001-fanout-engine/requirements.md` → `../../PLAN.md`,
  `../../ideas/…` указывают на корень этого архива).
- `.status`-файлы скопированы как есть — они относятся к покинутому SDD-процессу
  и не используются OpenSpec.
- Детали текущего поведения (реализованного) ищите в коде `extensions/pi-fusion/`;
  этот архив — исторический источник требований и решений, не зеркало кода.
