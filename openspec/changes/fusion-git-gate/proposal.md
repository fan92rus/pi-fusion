# Proposal: fusion-git-gate

> Status: rev.2 (набор утверждён владельцем 2026-11-02: «все кроме force и удаления»).
> Ревью 1.1 rev.2 — до кода. Язык артефактов — ru.

## Что

При включённом fusion лид получает разрешение на git по той же схеме, что bash-исключения
для bd и perl: одиночная команда `git <подкоманда> ...`. Разрешено всё, кроме:
- force-форм (push --force/-f/--force-with-lease, reset --hard, checkout --, restore без
  --staged, clean -f, commit --amend по умолчанию);
- удаления (push --delete / `:ref`, branch -d/-D, tag -d, remote remove, stash drop/clear,
  reflog delete, update-ref -d);
- глобальных опций до подкоманды (-c, -C, --git-dir, --work-tree) и интерактива (rebase -i).

## Зачем

Лид вынужден делегировать коммиты и push воркеру, а воркер по профилю git не выполняет.
Коммит одной строки занимает цикл делегирования. Владелец попросил git-разрешение
по аналогии с bash-исключениями.

## Как

- lead-access.ts: `isSingleGitInvocation`, таблицы force/delete-правил и ветка `git`
  в `classifyBashCommand`.
- restrictions.ts: ветка git в `gateDecision`; тексты отказа — как у bd.
- Без новых полей конфига: правила заданы в коде, как BD_SUBCOMMANDS.

## Риски (принятые)

- `git add .`/`-A` разрешены: лид может захватить чужие незакоммиченные файлы.
- Git-хуки репозитория исполняются при разрешённом commit/push.
- `reset --hard` отнесён к force (теряет незакоммиченное) — это моё толкование «force»;
  если владелец имел в виду иное, правило снимается отдельным решением.
