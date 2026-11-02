# Requirements: fusion-git-gate

> Status: rev.7 (после НЕ ГОДЕН раундов 1–5; runs 10e6715d, 5ffb4b16, c97a1dd5). Основа: owner 2026-11-02
> «все кроме force и удаления» + решения по OQ-2..OQ-5. Нормативная таблица — design.md §2
> (GIT_RULES); здесь — требования, таблица — их реализация. Язык — ru; SHALL — en.
> Rev.7: канонизация токенов (`=`, сокращения длинных опций, прикреплённые значения,
> значения опций), requireAny по флагам, +refspec для fetch/pull, --exec/-x/--receive-pack/
> --upload-pack, submodule foreach; путь-форма checkout вынесена владельцу (OQ-6).

## FR-001 Single git invocation

WHEN fusion is on AND the lead issues a bash call whose first word is `git`, THE gate
SHALL allow it only if it is exactly one git invocation: no chains, redirects,
substitutions, unquoted expansion characters, and no global options before the subcommand
(argv[1] starting with `-`: `-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`, etc.).

## FR-002 Allow by default, closed denylist with required flags

THE gate SHALL allow every git subcommand and form NOT covered by FR-003..FR-005. A form is
refused only if a GIT_RULES entry refuses it: a forbidden flag, forbidden word or forbidden
prefix matches after token canonicalization (design §2, шаги 5–7), or a subcommand that
requires a flag (`requireAny`) lacks it as a real flag (not as a value of another option,
not after `--`). Unlisted forms are allowed by owner decision («все кроме force и удаления»)
and recorded as accepted residuals (design §6). Subcommands `rm`, `gc`, `prune`, `repack`,
`maintenance`, `filter-branch`, `filter-repo`, `replace`, `alias`, `config` are refused entirely.

Threat model: the gate prevents mistaken or inertial destructive calls by the lead. It is not
a sandbox (AGENTS §0 «trust not sandbox»); syntactic evasions (abbreviations, `=`-forms,
attached values, option values) are closed by canonicalization.

## FR-003 Force and working-tree destruction (refused)

- `push`: `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, any token starting `+`.
- `fetch`, `pull`: `-f`, `--force`; any refspec starting `+`.
- `reset`: `--hard`, `--merge`, `--keep`.
- `checkout`: `-f`, `--force`, `-B` (resets an existing branch), `--discard-changes`, any
  token `--` (path form discards file changes). Path form without `--` — см. OQ-6.
- `switch`: `-f`, `--force`, `-C`, `--force-create`, `--discard-changes`.
- `restore`: REQUIRES a real `--staged` (or `-S`); refused WITHOUT it; refused with
  `--worktree`, `-W`. `restore --staged <path>` (unstage) stays allowed.
- `clean`: REQUIRES a real `-n` or `--dry-run`; refused without it. `clean -fn` (cluster
  containing `-n`) is allowed; `clean -fd` is refused; `-n` consumed as value of `-e` does not count.
- `stash`: refused for `drop`, `clear`, `pop` (any argv[2..] word).
- `worktree`: refused for `remove`, `prune`, `-f`, `--force`. `worktree list` allowed.
- `submodule`: refused for `-f`, `--force`, `foreach` (runs arbitrary command in each submodule).

## FR-004 Deletion and ref rewriting (refused)

- `push`: `--delete`, `-d`, token starting `:`, `--mirror`, `--prune`, `--all`, `--receive-pack`,
  `--exec` (runs remote command).
- `pull`, `fetch`: `--prune`, `-p`, `--prune-tags`, `--upload-pack`.
- `branch`: `-d`, `-D`, `--delete`, `-f`, `--force`, `-M`, `-C`.
- `tag`: `-d`, `--delete`, `-f`, `--force`.
- `remote`: `remove`, `rm`, `set-url`, `prune`, `rename` (any argv[2..] word).
- `symbolic-ref`: `-d`, `--delete`. `update-ref`: `-d`. `reflog`: `delete`, `expire`.
- `rebase`: `-i`, `--interactive`, `-x`, `--exec` (runs arbitrary command).
- `notes`: REQUIRES action `list` or `show` as argv[2]; any other notes action refused.

## FR-005 Bypass, interactive and message-source forms (refused)

- `commit`: `--amend`, `--no-verify`, `-n` (hook bypass; OQ-2, OQ-3 — decided: refused);
  `-e`, `--edit`, `-p`, `--patch`, `--interactive` (editor/interactive); message sources
  other than `-m`/`--message`: `-F`, `--file` (incl. attached `-F/tmp/m`, `--file=m`), `-C`,
  `-c`, `-t`, `--reuse-message`, `--reedit-message`, `--fixup`, `--squash`, `--template`;
  `--allow-empty`, `--allow-empty-message`. `commit` REQUIRES a real `-m` or `--message`
  (otherwise it opens an editor). `commit -a`, `commit --all` and `commit -m … -- <path>`
  are allowed (OQ-4).
- `push`: `--no-verify`, `-n` (hook bypass; `-n` also refused as dry-run alias — conservative).
- `add`: `-i`, `--interactive`, `-p`, `--patch`, `-e`, `--edit`. `add .` and `add -A` allowed (OQ-4).
- `clean`: `-i`, `--interactive`.
- `checkout`, `restore`, `stash`, `reset`: `-p`, `--patch`.
- Canonicalization (design §2): long flags are matched exactly or by unambiguous prefix (`--amen`
  = `--amend`, `--force-w` = `--force-with-lease`); `--name=value` is matched by name; short
  clusters are expanded to letters until a value-taking letter (`-mn` = message «n», `-CHEAD`
  = value of `-C`); a value consumed by a value-taking option never counts as a flag.
- `log -p`, `diff -p`, `show -p` remain allowed (read-only).

## FR-006 Inert when off, regression of existing exceptions

WHEN fusion is off, the git branch SHALL NOT change behaviour. Child sessions are
unaffected. The perl and bd classifiers, their refusal texts and the shellPath disabling
rule SHALL stay behaviourally identical; existing tests SHALL pass without edits.

## Решения владельца (2026-11-02)

- OQ-2 (`commit --amend`): ЗАПРЕТ — подтверждено.
- OQ-3 (`--no-verify`/`-n`, `push --no-verify`): ЗАПРЕТ — подтверждено.
- OQ-4 (`add .`/`-A`, `commit -a`): РАЗРЕШЕНО.
- OQ-5 (`checkout`/`switch` без `-f` при грязном дереве): РАЗРЕШЕНО. Относится только к
  переключению веток; `restore` без `--staged` этим решением НЕ разрешён (FR-003).

## OQ-6 (РЕШЕНО владельцем 2026-11-02: вариант (а) — принять как residual)

Путь-форма `git checkout <path>` (без `--`) молча откатывает правки файла. Без git нельзя
отличить её от переключения на ветку. Варианты:
- (а) принять как residual по OQ-5 (текущий rev.7; checkout без `--` разрешён);
- (б) запретить `checkout` без `-b`/`--orphan` и рекомендовать `switch` (switch не принимает пути).
Решение владельца: вариант (а). checkout без `--` разрешён; риск записан как residual R-6 (design §6).

## Принятые residual-решения rev.7 (design §6)

- `replace`, `filter-branch`, `filter-repo`, `gc`, `config`, `alias`, `rm` — отказ целиком:
  переписывают историю/хуки или обходят правила; это расширяет запрет, а не ослабляет его.
- Ложный отказ для слов `pop`/`drop`/`clear` в аргументах `stash`/`remote`, для префиксов
  длинных запрещённых флагов и для неквотированных `~ ! * ? [ ] { }` — допустим (закрытый отказ).
- Полная защита от намеренного обхода не заявляется (не песочница).
