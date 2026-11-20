# Types and strict lint

Dev process steps 3 and 4 for Plaud-Notes-to-Notion (D16, D19), copied from the Toolbox's `docs/TYPES-AND-LINT.md` and the sibling repositories' versions and scaled to this repository: almost all TypeScript, with two JavaScript files, the gate's Python in `.security` and a little shell. Whole kinds of mistakes fail in seconds, before any test runs. Lauren Tan puts "lint rules, type systems, compilers" in the deterministic layers that come first, ahead of prose rules, and says to "start with a lint rule to prevent new occurrences of anti-patterns and then clean up those old patterns as well". Comments "go stale easily", so no new one lands; the old ones are cleaned in a separate job after this one merges.

## What runs

| Tool | Checks | Pinned in |
|---|---|---|
| TypeScript's checker (`tsc`) | Types over `src`, `tests`, `bin` and `scripts` in strict mode, with `checkJs` for the JavaScript, plus implicit returns, switch fall through, missing `override` and unreachable code | `.lint/package-lock.json`, options in `.lint/tsconfig.json` |
| ESLint with typescript-eslint | Bugs in TypeScript and JavaScript: undefined names, duplicate keys, unreachable code, unused variables, the typescript-eslint recommended bug rules | `.lint/package-lock.json`, rules in `.lint/eslint.config.mjs` |
| Ruff | Python bugs in `.security`: undefined names, unused imports, bad escapes, dead conditions | `.cursor/install-lint.sh` (version and checksum), rules in `.lint/ruff.toml` |
| Pyright | Python types: wrong calls, unknown module attributes, Python 3.10 features on the Mini's Python 3.9 | `.lint/package-lock.json`, rules in `pyrightconfig.json` |
| Import check | No file outside `tests/` loads a test, a fixture, a worktree or another repository | `.security/lint.py`, reading imports with `.lint/reader.mjs` |
| Suppression check | No comment turns a checker off (`@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`, `# pyright:`, `# type: ignore`). ESLint runs with inline config off and Ruff with `--ignore-noqa`, so such comments do nothing anyway | `.security/lint.py` |
| Comment ban (step 4) | No new code comment in TypeScript, JavaScript, Python or shell, and no new Python docstring that nothing reads ([below](#the-comment-ban)) | `.security/lint.py`, `.lint/reader.mjs`; shell read by shfmt, pinned in `.cursor/install-lint.sh` |
| ShellCheck | Shell scripts, already in the gate (`.security/languages.py`), unchanged | `.cursor/install-shellcheck.sh` |

`python3 .security/lint.py gate` is the gate's step "Types and strict lint (Ruff, Pyright, ESLint, tsc, imports, comments)". In `.security/local-gate.py` it runs after the commit hook and after `Install dependencies` (`npm ci`, which moved out of `local-gate.json` so `tsc` can read the product's types), and before the security audit, the probes and every test. The gate's first step records each tool's pinned version. `.githooks/pre-commit` runs `python3 .security/lint.py staged` on the staged text with Ruff, Pyright, ESLint and the import, suppression and comment checks; `tsc` needs the whole tree, so it runs in the gate only. `.security/test_lint.py` is the gate's step "Lint step probes".

Install or update the tools with `bash .cursor/install-lint.sh`. They live in `~/.local/share/repo-lint/plaud-notes-to-notion/` (Ruff and shfmt in versioned folders, the Node tools in a folder named for the lockfile's hash), and `lint.py` finds them there, never on `PATH`. This differs from the Toolbox on purpose: the Toolbox links its tools into `~/.local/bin` and its gate pins those links, so a second repository linking a different `eslint` or `tsc` there would break the Toolbox's gate, and the Toolbox's installer deletes any `node-<hash>` folder next to its own. `REPO_LINT_HOME` moves the folder for tests; point it at a folder of its own, never at `~/.local/share/repo-lint` itself, because the installer's cleanup removes every `node-<hash>` folder directly under it.

Not copied from the Toolbox: dependency-cruiser (the reader already parses every file's imports, and a second parser adds a dependency to pin), `lib/bounded_read.py` (a Toolbox guard for a stalled volume read) and the JXA globals file (no JXA here).

## The ratchet

Each finding is keyed by its tool, rule, file and a hash of its line's text, so moving code does not change it. `.lint/baseline.json` holds today's findings and only shrinks:

- A change fails on a finding absent from both the baseline and the PR base, including indirect breakage in untouched files. Editing a finding's line changes its key, so editing a line that holds an old comment makes the comment new: remove the comment while you are there. A renamed file keeps its old findings.
- A finding already on the PR base is a warning even in a touched file, so a merge commit is never blamed for main's existing finding. Counts matter: one existing occurrence does not excuse a second new one.
- A baseline that gains an entry fails. The one way in is a new check's first entries: `python3 .security/lint.py baseline` writes them only for a tool the baseline's `tools` list does not hold yet. When code is fixed, the gate warns that entries are stale; `python3 .security/lint.py prune` drops them and never adds one (`prune --resolved-only` also leaves every kept entry's line field as it was).
- With no PR base (the deploy gate), findings outside the baseline are warnings. `local-gate.py PR_NUMBER` sets `LOCAL_GATE_BASE` to the merge base with `origin/main`.
- A change to a lint config, a pin or the lists of allowed comments needs an exact `.lint/policy-review.json` with `before`, `after` and a specific `reason` of at least 40 characters, from `policy_digest(base)` and `policy_digest()` in `.security/lint.py`. The note supplies the rationale; it never replaces the fresh reviewer. The PR that introduces `lint.py` needs none, since the base has nothing to weaken.

`python3 .security/lint.py counts` prints the findings per tool; `python3 .security/lint.py comments` lists every comment line the ban flags, for the cleanup jobs.

## Findings in today's code

Measured on main at 50cbeea with this step, before any cleanup:

| Tool | Before this PR | After this PR (held by the baseline) |
|---|---|---|
| Ruff | not run | 0 |
| Pyright | not run | 0 |
| ESLint | not run | 1 |
| tsc | not run (only `src` was typed, by `npm run typecheck`, with no findings) | 6 |
| Imports | not run | 0 |
| Suppression | not run | 0 |
| Comments | not checked | 444 lines in 49 files |
| **Total** | | **451** |

The six `tsc` findings are real mismatches that the product's own `npm run typecheck` never saw, because it reads `src` only: five test doubles of `Logger` (`tests/daemon-engine.test.ts` three, `tests/independent-side-effects.test.ts` and `tests/independent-status.test.ts` one each) that omit the required `verbose` method the tests never call, and `scripts/scan-package.js` line 10 passing a `Buffer` where `JSON.parse` is typed to take a string (it works, since `JSON.parse` converts it). The one ESLint finding is real too: `sourceFiles` in `tests/claude-subscription.test.ts` is defined and only calls itself. They are in the baseline and fixed by a later job, not here.

## Rules dropped, and why

False alarms must be zero, so a rule that flags correct code is off (Peter: false alarms must be zero, quality first, cost second, time third; about 7:50 PM CT Nov 15 2026). Each tool was first run with its widest rule set over the whole repository and every rule's hits were read.

**tsc** (widest: every strict option below plus `noUnusedLocals`, `noUnusedParameters`). Kept: `strict`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `allowUnreachableCode: false`, `allowUnusedLabels: false` (6 hits, the findings above). Dropped: `noPropertyAccessFromIndexSignature` (247 hits, every one a plain `a.b` on a record the code validates), `noUncheckedIndexedAccess` (74 hits, each an index read after a length check, a loop bound, a regular expression match or a test's own assertion, so the element is there), `exactOptionalPropertyTypes` (28 hits: an optional field deliberately set to `undefined`, and options objects passed through), `noUnusedLocals` and `noUnusedParameters` (7 hits each; ESLint's unused variable rule owns them, so one mistake is not counted twice).

**ESLint** (widest: every core rule that is not deprecated plus typescript-eslint strict and stylistic with type information; 3,460 hits in 74 rules). Kept: the Toolbox's core bug rules (undefined names, duplicate keys and cases, unreachable code, bad regular expressions, self assignment, unsafe negation and the like) for JavaScript, and typescript-eslint's `recommended` set for TypeScript with the core rules it replaces switched off for TypeScript (`tsc` owns undefined names and redeclared names there). Dropped, after reading the hits: every style, ordering and size rule (`sort-keys`, `one-var`, `no-magic-numbers`, `curly`, `id-length`, `no-ternary`, `func-style`, `max-statements`, `complexity`, `init-declarations` and the like); the typed rules that guess wrong without `noUncheckedIndexedAccess` or about flags that change in callbacks (`no-unnecessary-condition`: 33 hits, among them `while (!stopping ...)` that a signal handler ends and `if (st)` after an index read; `no-unmodified-loop-condition`, `no-loop-func`, `require-atomic-updates`, whose hits are the same state read after an await on purpose); the `no-unsafe-*` family (`JSON.parse` results that the next lines validate by hand); `restrict-template-expressions`, `no-base-to-string`, `restrict-plus-operands` and `prefer-promise-reject-errors` (a value already known to print right; `buf += chunk` of a Buffer); `no-promise-executor-return`, `no-void`, `no-empty` and `no-bitwise` (`new Promise((r) => setTimeout(r, n))`, deliberate unawaited work, a catch that ignores a failed `kill`, `O_RDONLY | O_NOFOLLOW`); `consistent-return` and `no-invalid-void-type` (event handlers and a function that returns a value only to stop); `no-use-before-define` (function hoisting), `no-useless-assignment`, `no-useless-escape` (a redundant backslash inside a character class changes nothing), `new-cap` (a constant function named in capitals), `require-await` and `no-await-in-loop` (deliberate sequencing); `@typescript-eslint/no-unnecessary-type-assertion`, `no-non-null-assertion`, `no-dynamic-delete`, `no-unused-expressions` (a ternary of two counters `ready ? a++ : b++;` is correct and meant), `no-explicit-any` and `ban-ts-comment` (the suppression check owns it). `no-unused-vars` ignores arguments, caught errors, rest siblings and names starting `_`.

**Ruff** (widest: `--select ALL`, 2,899 hits in `.security`): the Toolbox's reviewed rule list, which finds nothing here. Style families (quotes, annotations, docstrings, print, subprocess without `check`, test assertion style) flag correct code, so they stay off, as in the Toolbox.

**Pyright** (31 errors in standard mode over `.security`): `reportOptionalMemberAccess` (15, `spec.loader.exec_module` and `Popen.stdin`), `reportArgumentType` (10, `ModuleSpec | None`), `reportOptionalOperand`, `reportPossiblyUnboundVariable` and the other Toolbox filters are off for the same reason: the code has no annotations and the checks flag standard idioms. `reportAttributeAccessIssue` is kept for module attributes only (`os.nope`), not for `module.ROOT = ...` assignments in the probes (4 hits), `reportCallIssue` for wrong argument counts and names, and `reportGeneralTypeIssues` for features that need Python 3.10. One trap the sibling repositories found and `lint.py` closes: Pyright skips every folder whose name starts with a dot, and `.security` is one, so a plain run reports "0 errors" having read nothing. `lint.py` copies the Python files to folders without the leading dot (`.security` becomes `dot-security`), maps findings back to the real path and fails when Pyright reads fewer files than it was given.

## The comment ban

Build step 4 (D19). Comments go stale, and agents copy them and lean on them; the fix for code that needs explaining is a better name or a test.

**What fails.** Each line of a new comment is one finding, `comments no-comment`: `//` and `/* */` (including JSDoc blocks) in TypeScript and JavaScript, `#` in Python and shell, whether on its own line or after code. A Python docstring nothing reads is `comments no-docstring`, per line, and a bare string used as a statement counts the same way.

**How it reads code, so text is never a false alarm.** TypeScript and JavaScript through the TypeScript compiler's own parser and comment ranges (`.lint/reader.mjs`), Python through `tokenize` and `ast`, shell through shfmt's bash parser. Strings, template strings, regular expressions, heredoc bodies, `$#`, `${#name}` and `a#b` are never comments. Only `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.py`, `.sh` and `.bash` files are read, plus files with no suffix whose first line is a python, sh, bash, dash or ksh shebang. Data and text files (JSON, YAML, TOML, Markdown, plist) are never read. A file the reader cannot parse is its own finding (`comments unreadable-javascript`, `comments unreadable-shell`), so no comment slips through unread (none today). zsh files are not read, since shfmt reads no zsh (none today).

**Allowed.**
- A shebang on line 1.
- A comment line holding a link to an upstream issue, pull request, bug or RFC: issues, pulls, merge requests and discussions on GitHub, GitLab and Codeberg, except Peter's own repositories (`sfls1397`), which are not upstream; `bugs.` and `bugzilla.` hosts and `show_bug.cgi`; crbug and the Chromium and Google issue trackers; rfc-editor.org and the IETF datatracker.
- License text: the file's leading comment block, when any of its lines holds `SPDX-License-Identifier:`, `Copyright`, `Licensed under`, `Permission is hereby granted` or `All rights reserved`.
- Comments a tool needs to work: Python's encoding line on line 1 or 2 (PEP 263) and ShellCheck's `# shellcheck shell=`, `source=` and `source-path=` directives. Nothing else qualifies: `# shellcheck disable=`, `# noqa` and `eslint-disable` turn a checker off rather than help it work, so they are the suppression check's findings, counted once.

**Docstrings count, unless the program reads them.** A docstring is prose for a reader and goes stale like a comment. A docstring the code reads is program text: the module docstring of a file that reads `__doc__` (`lint.py` prints it as usage) and a function or class docstring the same file reads as `name.__doc__`.

## Comments in today's code

Measured on main at 50cbeea with this check: 444 comment lines in 49 files (TypeScript and JavaScript 381, Python 51, shell 12). 134 of the TypeScript lines open a JSDoc block, and none of the Python lines is a docstring nothing reads. Six comment lines cite a Peter instruction, in `src/claude-subscription.ts` (3), `src/llm.ts` (2) and `tests/claude-subscription.test.ts` (1): the rules that the Claude subscription is used first and the API only after a usage limit (Nov 11 and Nov 17 2026). Each "why" moves to the rule or test that owns it before its comment is deleted. Six comments in `.security` and `.githooks` name Toolbox pull requests and a date as history; git already holds that. No lesson ID sits in any comment. The baseline holds all 444.

| Folder | Files | Lines |
|---|---|---|
| `src` (top level) | 18 | 317 |
| `src/plaud` | 6 | 31 |
| `.security` | 7 | 51 |
| `tests` | 10 | 28 |
| `.cursor` | 3 | 5 |
| `.githooks` | 2 | 4 |
| `bin` | 1 | 4 |
| `examples` | 1 | 3 |
| `scripts` | 1 | 1 |
| **All** | **49** | **444** |

The most: `src/llm.ts` 38, `src/sync.ts` 37, `src/claude-subscription.ts` 33, `src/card.ts` 28, `src/format.ts` 26, `src/ingest.ts` 24.

## The cleanup plan

One job per part, on a mid tier model (Peter: it does not need a high model; about 8:45 PM CT Nov 15 2026), each after the one before merges. This PR does not clean any comment.

| Part | Files | Lines | Why this order |
|---|---|---|---|
| 1 | `.githooks`, `.cursor`, `bin`, `examples`, `scripts` and `.security` | 68 | Small, mostly shell and gate code, so the method is proven cheaply and the gate's own files are kept apart from the product |
| 2 | `src/card.ts`, `claude-subscription.ts`, `config.ts`, `constants.ts`, `daemon.ts` | 99 | Holds three of the Peter citations, which move to the rule or test that guards the subscription first behavior |
| 3 | `src/format.ts`, `ingest.ts`, `llm.ts`, `lock.ts`, `log.ts` | 95 | The other two Peter citations (`llm.ts`) |
| 4 | `src/notion.ts`, `paths.ts`, `runtime.ts`, `scrub.ts`, `secrets.ts`, `ssn.ts`, `state.ts`, `sync.ts` | 123 | The redaction and sync code, where each comment describes a guard that a test must name |
| 5 | `src/plaud` and `tests` | 59 | Last, so any reason that belongs in a test name is already there; holds the test file's Peter citation |

Where each kind's "why" goes: narration goes nowhere (a better name for the function or constant, or a test, when the code is unclear without it); a Peter citation goes in the name of the test that guards the behavior or in `README.md` when it is user facing; history (a pull request, a date) is already in git; a docstring the program prints stays. Each part's job: list the part's comments with `python3 .security/lint.py comments`, move or drop each one, change no behavior (a rename is the only code change allowed), prove it with identical syntax trees before and after (TypeScript with `ts.createSourceFile` and comments ignored, Python with `ast.dump` minus docstring statements, shell with `shfmt -mn`), run `python3 .security/lint.py prune --resolved-only` so the baseline loses only resolved entries, and put the before and after comment counts in the PR. A comment inside an empty `catch { /* ... */ }` is a comment like any other: the reader finds it, and removing it leaves an empty block that ESLint's `no-empty` rule (off here, with its reason above) does not flag.

## Changing a pin or a rule

Edit `.lint/package.json` and regenerate `.lint/package-lock.json` (`npm install --package-lock-only` in `.lint`), or the Ruff and shfmt versions and checksums in `.cursor/install-lint.sh`, run the installer, then `python3 .security/lint.py counts`. Compare finding counts before and after a config edit and check that the intended diagnostic changed: an accepted but misspelled rule key can leave the wrong behavior in force. A pin or rule that finds new findings in today's code needs those fixed in the same PR, since the baseline never grows. The security scan audits the lint tools' dependencies at the high threshold with no exceptions.
