# Design: fusion-git-gate

> Status: rev.7 (после НЕ ГОДЕН раундов 1–5; раунд 5 — run c97a1dd5). Требования — requirements.md (FR-001..FR-006).
> Принцип: тесты НЕ перечисляются вручную, а генерируются из таблицы GIT_RULES. Угроза: лид
> по ошибке или по инерции выполняет разрушающую команду. Gate — не песочница (AGENTS §0:
> «trust not sandbox»), поэтому полная защита от намеренного обхода не заявляется; класс
> синтаксических обходов (сокращения, `=`, прикреплённые значения, значения опций) закрывается
> канонизацией токенов (§2, шаги 5–7).

## 1. Точки вставки

- `extensions/pi-fusion/lead-access.ts`: `isSingleGitInvocation` (по образцу
  `isSingleBdInvocation`, ~415); таблица `GIT_RULES` (§2); ветка `git` в `BashClassification`
  и `classifyBashCommand` (~450–456).
- `extensions/pi-fusion/restrictions.ts`: `gateDecision` (~391–442) — ветка git по образцу
  bd; причина отказа — из правила таблицы. Текст «other» (~454) НЕ меняется (решение супервизора,
  rev.7 impl): существующие тесты пинят его байт-в-байт, FR-006 требует прохождения без правок;
  git-ветка проходит общий путь отказа.

## 2. Таблица GIT_RULES и алгоритм

Запись: `{ sub, forbid, forbidPrefix?, requireAny?, valueOpts, allowLong?, reason }`.

- `forbid` — короткие буквы (`-f`) и длинные имена (`--force`). Длинное имя совпадает точно
  ИЛИ как однозначный префикс (git принимает сокращения) — кроме имён из `allowLong`.
- `forbidPrefix` — сырой токен начинается с префикса (`+`, `:`).
- `requireAny` — хотя бы один ФЛАГ (не значение и не аргумент после `--`) должен совпасть
  ТОЧНО; иначе отказ.
- `valueOpts` — опции, которые потребляют следующий токен или остаток кластера как значение.
- Регистр — регистрозависимый (`-b` ≠ `-B`, `-c` ≠ `-C`, `-d` ≠ `-D`, `-m` ≠ `-M`).

| sub | forbid | forbidPrefix | requireAny | valueOpts | allowLong |
|---|---|---|---|---|---|
| push | -f, --force, --force-with-lease, --force-if-includes, -d, --delete, --mirror, --prune, --all, --no-verify, -n, --receive-pack, --exec | `+`, `:` | — | --receive-pack, --exec | — |
| pull | -f, --force, -p, --prune, --prune-tags, --upload-pack | `+` | — | --upload-pack | — |
| fetch | -f, --force, -p, --prune, --prune-tags, --upload-pack | `+` | — | --upload-pack | — |
| reset | --hard, --merge, --keep, -p, --patch | — | — | — | — |
| checkout | -f, --force, -B, --discard-changes, `--`, -p, --patch | — | — | -b, -B, -c, -C, --orphan | — |
| switch | -f, --force, -C, --force-create, --discard-changes | — | — | -c, -C, --create, --force-create | — |
| restore | --worktree, -W, -p, --patch | — | --staged, -S | -s, --source | — |
| clean | -i, --interactive | — | -n, --dry-run | -e, --exclude | — |
| stash | drop, clear, pop, -p, --patch | — | — | — | — |
| worktree | remove, prune, -f, --force | — | — | — | — |
| submodule | -f, --force, foreach | — | — | — | — |
| branch | -d, -D, --delete, -f, --force, -M, -C | — | — | — | — |
| tag | -d, --delete, -f, --force | — | — | — | — |
| remote | remove, rm, set-url, prune, rename | — | — | — | — |
| symbolic-ref | -d, --delete | — | — | — | — |
| update-ref | -d | — | — | — | — |
| reflog | delete, expire | — | — | — | — |
| notes | — | — | action (argv[2]) = list \| show | — | — |
| commit | --amend, --no-verify, -n, -e, --edit, -p, --patch, --interactive, -F, --file, -C, -c, --reuse-message, --reedit-message, --fixup, --squash, --template, -t, --allow-empty, --allow-empty-message | — | -m, --message | -m, -F, -C, -c, -t, --message, --file, --reuse-message, --reedit-message, --fixup, --squash, --template, --author, --date | --all |
| rebase | -i, --interactive, -x, --exec | — | — | -x, --exec | — |
| add | -i, --interactive, -p, --patch, -e, --edit | — | — | — | — |
| rm, gc, prune, repack, maintenance, filter-branch, filter-repo, replace, alias, config | весь подкомандный отказ (любые аргументы) | — | — | — | — |

Алгоритм `isSingleGitInvocation`:
1. `tokenizeShellCommand`; ошибка → отказ её причиной (как у bd). FR-001 (метасимволы,
   подстановки, `\`, `#`) обеспечивает токенизатор lead-access.ts (~301–380).
2. `argv[0] === "git"`, иначе «первый токен не git».
3. argv[1] начинается с `-` → «глобальные опции git до подкоманды запрещены».
4. Любой токен с `expansion !== undefined` → отказ.
5. `sub = argv[1]`. Если `sub` в `rm|gc|prune|repack|maintenance|filter-branch|filter-repo|replace|alias|config` → отказ целиком. Если `sub` нет в таблице → разрешено (FR-002).
6. Канонизация argv[2..] слева направо с состоянием «ожидаю значение»:
   - токен после `--` (сам `--` — отдельный флаг, см. forbid checkout) — только позиционный;
   - если предыдущий флаг в `valueOpts` и значение ещё не взято → токен = значение, не флаг;
   - `--name=value` → флаг `--name`, значение отделено;
   - длинный `--name` → флаг; для `forbid` проверяется точно и как префикс (`--amen` → `--amend`);
   - короткий кластер `-abc`: буквы идут как флаги, пока буква не из `valueOpts`; тогда остаток кластера — значение (`-mn` = сообщение «n», `-CHEAD` = значение), иначе следующий токен — значение;
   - `-<буквы>` в кластере проверяются по `forbid` (`-nm` → `-n` → отказ, `-am` → `-a` и `-m`).
7. `forbid` и `forbidPrefix` проверяются по всем канонизированным флагам и сырым токенам (ложный отказ для значения допустим — закрытый отказ). Первое совпадение → отказ с причиной записи.
8. `requireAny` проверяется ТОЛЬКО по флагам, полученным на шаге 6 (значения не засчитываются); `notes` — по argv[2]. Нет → отказ.
9. Иначе — разрешено.

Исключения, которые работают (не попадают в запреты): `clean -n`, `clean -fn` (кластер
с `-n`), `restore --staged f`, `log -p`, `diff -p`, `show -p`, `commit -a -m x`,
`commit -am x`, `commit --all -m x`, `commit -mn` (сообщение «n»), `notes list`, `notes show`.

## 3. Тесты: генерация из таблицы (TDD, red → green)

test/lead-access.test.ts. Набор строится циклом по GIT_RULES:

**3.1 forbid.** Для каждой записи и каждого элемента `forbid`: `git <sub> <элемент>` (с типовыми
аргументами `origin main`, `f`, `x`) → отказ. Для каждой короткой буквы — также в кластере
(`-f` → `-fx`). Для каждого длинного — также `=`-форма (`--force=1`) и каждый однозначный
префикс длиной ≥ 3 символов после `--` (`--forc`, `--amen`) → отказ.
**3.2 forbidPrefix.** `git push origin +main`, `git fetch origin +main:main`, `git push origin :main` → отказ.
**3.3 requireAny.** `commit` без `-m` (`git commit`, `git commit -a`) → отказ; `commit -m x`,
`commit -am x`, `commit --message=x`, `commit --all -m x` → разрешено; `restore f` → отказ;
`restore --staged f` → разрешено; `restore --staged --worktree f` → отказ; `clean -f` → отказ;
`clean -n` и `clean --dry-run` → разрешено; `clean -e -n` → отказ (`-n` — значение `-e`);
`notes add` → отказ; `notes add -m list` → отказ; `notes list` / `notes show` → разрешено.
**3.4 Значения и кластеры.** `commit -nm x` → отказ (`-n`); `commit -mn` → разрешено
(сообщение «n»); `commit -F/tmp/m` → отказ; `commit -CHEAD` → отказ; `commit --file=m` → отказ;
`commit --amen -m x` → отказ; `clean -fd` → отказ; `clean -fn` → разрешено; `push -fu origin main` → отказ;
`add -Ap` → отказ; `rebase --exec 'git reset --hard'` → отказ; `rebase -x cmd` → отказ;
`submodule foreach 'x'` → отказ; `push --force-w origin main` → отказ (префикс `--force-with-lease`).

**3.5 Контроль ложных отказов** (разрешено, все ОБЯЗАНЫ проходить): `git status`;
`git log --oneline -5`; `git log -p -1`; `git diff HEAD`; `git diff --cached`; `git show HEAD -p`;
`git add extensions/a.ts`; `git add .`; `git add -A`; `git commit -m "feat: x"`;
`git commit -a -m x`; `git commit -m x -- path`; `git push origin main`; `git push -u origin main`;
`git push --set-upstream origin main`; `git pull --rebase`; `git pull --ff-only`; `git fetch origin`;
`git checkout -b feat`; `git switch -c feat`; `git stash push -m x`; `git stash list`;
`git stash apply`; `git remote -v`; `git restore --staged f`; `git branch`; `git worktree list`;
`git merge --no-edit main`.

**3.6 Оболочка и глобальные опции** (отказ): `git status; rm -rf x`; `git status $(id)`;
`git status > f`; `git status && x`; `git -C /tmp status`; `git -c core.pager=x log`;
`git --git-dir=x status`; `git --work-tree=x status`.

test/restrictions.test.ts: gateDecision при on (allow/deny) и при off (inert).
Регрессия perl/bd: существующие тесты без правок.

## 4. Гейты

npm test, npm run typecheck, npx biome check (изменённые файлы), npm run build,
openspec validate --all.

## 5. Файлы

extensions/pi-fusion/lead-access.ts, extensions/pi-fusion/restrictions.ts,
test/lead-access.test.ts, test/restrictions.test.ts; guidance/README — после решения
владельца по OQ (task 2.3).

## 6. Остаточные риски и принятые решения

- **R-6 (ВОПРОС ВЛАДЕЛЬЦУ, OQ-6): путь-форма `git checkout <path>` без `--`.** Без git нельзя
  отличить `checkout <ветка>` от `checkout <путь>`; вторая молча откатывает правки файла.
  Рассматривается как принятый residual по OQ-5 (checkout без -f разрешён), пока владелец
  не решит иначе. Вариант «запрет всего checkout без -b/--orphan» — рекомендуется
  использовать `switch` вместо него (switch не принимает пути).
- Denylist закрыт по решению владельца: неперечисленные формы разрешены. Новые опасные формы
  добавляются в GIT_RULES и получают тесты автоматически (§3.1–§3.3).
- Полная защита от намеренного обхода не заявляется (не песочница). Закрыт класс
  синтаксических обходов: сокращения длинных опций, `=`-формы, прикреплённые значения,
  значения опций в requireAny. Не закрыты: команды, которые сами запускают произвольный код
  вне таблицы (`git bisect run`, `git am` с хуками), — принятый residual.
- `add .`/`-A`, `commit -a`: лид может захватить чужие незакоммиченные изменения (OQ-4).
- `checkout`/`switch` без force-флагов в общем дереве могут переключить чужую работу (OQ-5).
- Команды, которые могут открыть редактор без TTY (`merge` без `--no-edit`, `cherry-pick`,
  `revert`, `tag -a` без `-m`, non-interactive `rebase`): разрешены; риск зависания —
  остаточный, закрывается таймаутом bash.
- Git-хуки репозитория исполняются при разрешённом commit/push (pre-commit bd export).
- Произвольный remote push: ограничение remote не вводится.
- Ложные отказы (закрытый отказ): неквотированные `~ ! * ? [ ] { }` (нужны кавычки:
  `git show "HEAD~1"`); слова `pop`/`drop`/`clear` в аргументах `stash`/`remote`; любой
  префикс длинного запрещённого флага (`--no` для commit/push, `--m` для reset);
  `-n` для push (dry-run); `commit --author`/`--date` с значением; `commit --all` разрешён.
