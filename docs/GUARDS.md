# Guards the code keeps

Code comments are banned here (docs/TYPES-AND-LINT.md → The comment ban), so each reason that a comment used to carry lives in the name of the test that guards it, or in this list when no test names it. A line here that gains a test should move into that test's name. The Peter citations for the Claude subscription rules are in README.md → LLM (participant labeling).

| Guard | File | Why |
|---|---|---|
| A 404 on a page is never a deletion | `src/notion.ts` `pageState` | A 404 means permanently deleted or access lost. Only an explicit trashed page is a deletion. Held by the test "does nothing when a page 404s" in `tests/sync.test.ts`. |
| The Keychain password goes on stdin of `security -i`, never on its command line | `src/secrets.ts` | An argument shows in `ps`. `-U` updates an existing item. The write needs the GUI Terminal.app session on the Mini and fails without it. |
| A refresh re-reads the Keychain first | `src/plaud/session.ts` | The daemon and a manual CLI run share one sign-in. If the other process already rotated the refresh token, use it instead of burning ours. |
| A JSON state file is written to a temporary file and renamed | `src/paths.ts` | A crash then never leaves half a state file. |
| The loopback callback binds `127.0.0.1` and `::1` only | `src/plaud/callback.ts` | Plaud's registered redirect for this public client is `localhost:8199`. The test "answers on 127.0.0.1 and rejects an unexpected state without exchanging a code" in `tests/guards.test.ts` holds the state check, not the bind. |
| An authentication failure ends the ingest cycle and is thrown | `src/ingest.ts` `runIngest` | A bad sign-in affects every file, so the daemon alerts once instead of failing each note. |
| Redaction runs cards first, then SSNs, across the whole recording | `src/ingest.ts` `prepareRecording`, `src/scrub.ts` | "Last four of the card" belongs to the card, not the SSN. A value spoken in the transcript is removed from the summary and title too. Held by "treats 'last four of the card' as the card, not the SSN" in `tests/card.test.ts`. |
| A request to OpenAI is sent with `store: false` | `src/llm.ts` | OpenAI otherwise keeps the request and response. Held by "asks OpenAI not to store the request" in `tests/llm.test.ts`. |
| A refused Claude Code run is a permanent failure | `src/llm.ts` | A run that used an API key or the wrong model never gets better by retrying, while a limit, an exit or a timeout can. Held by "a refused subscription run is not a limit" in `tests/claude-subscription.test.ts`. |
| Only stderr and the last plain stdout line are read as Claude Code's own words | `src/claude-subscription.ts` | The same rule as Toolbox claude-side, so a note's own text can never read as a usage limit. |
| Claude Code gets `USER` and `LOGNAME` from the operating system account | `src/claude-subscription.ts` `subscriptionEnv` | Claude Code finds its subscription sign-in in the login Keychain by `USER`, and a LaunchAgent's environment may not carry it ("Not logged in"). Held by "keeps only the allowlist" in `tests/claude-subscription.test.ts`. |
| The meeting title is Plaud's title minus its leading `MM-DD ` date | `src/format.ts` `meetingTitle` | The account owner asked for it on 2026-09-26. Held by "is Plaud's title with only the leading date removed" in `tests/format.test.ts`. |
| A failed log write is swallowed | `src/log.ts` | Logging must never crash the run. |
| A stdin error on the `security` child is swallowed | `src/secrets.ts` `defaultSecurityRun` | The write can hit `EPIPE` when the child exits early. The child's close or error event settles the promise, so the stream error needs no handling of its own. |
| An audit exception pins every affected installed version and advisory chain, not just the package name | `.security/scan.py` `audit_key` | A name alone would let a later, different vulnerable version ride on an old exception. |
| The installer sets a GitHub noreply committer identity when none is configured | `.cursor/install-security.sh` | CI has no committer identity by default, and an unset one would take the runner's hostname. |
| Semgrep installs through the system pip | `.cursor/install-semgrep.sh` | Default cloud images omit `ensurepip`; the same pin is kept. |
| OpenAI labels default to GPT-6 Luna at high reasoning effort | `src/constants.ts`, `src/llm.ts` | On a 9 recording test high gave the same labels as max with about 3.5 times fewer output tokens. The effort is ignored for Claude models. |
| Participant names have commas stripped | `src/format.ts` `cleanParticipants` | Notion rejects commas in multi-select options. Held by "removes the owner, generic labels, commas and duplicates" in `tests/format.test.ts`. |
| The scrub command is a one off for rows written before a redaction existed, and is a dry run unless `apply` is set | `src/scrub.ts` | SSNs were not redacted in the Zap era and cards not before 2026-10-01. |
