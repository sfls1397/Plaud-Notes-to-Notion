# Plaud Notes to Notion

## Manual service engine

With the coordinated Toolbox adapter installed, `toolbox engine use sol` selects Codex `gpt-6.1-sol` on the managed ChatGPT subscription. `toolbox engine use claude` restores this application's configured provider/model (normally Claude Haiku), and `toolbox engine status` reports selection. The daemon snapshots policy between ingestion units, so running work is unchanged and no restart is required for later switches. Sol does not require an LLM API key and never falls back automatically. Malformed policy or failed subscription transport stops labeling rather than writing guessed participants. Install the adapter once using the normal safe daemon deployment procedure before switching.

A small macOS background service (LaunchAgent) that copies finished
[Plaud](https://www.plaud.ai/) recordings into a Notion database. For each
recording it writes two rows, one `Summary` and one `Transcript`. Every 5
minutes it also copies title and participant edits you make on a **Summary** row
onto the matching **Transcript** row.

Before anything leaves your Mac, Social Security numbers and payment-card
details are removed from the summary, transcript, and title. Participant names
are filled in by a language model (Claude Haiku on the Claude subscription by default, with the Anthropic API only on its usage limit; or OpenAI).

No runtime dependencies beyond Node.js 20 or later.

## What it does (per profile)

| Step | Notes |
| --- | --- |
| Poll Plaud every **30 s** (deep 30-day scan every 10 min) | Writes only once Plaud has **both** the auto summary and the transcript. Recordings still being processed are re-checked every poll for 48 h, then on deep scans. |
| `Recorded` = recording start, to the minute, as a true UTC instant | Uses the recording's start time from Plaud, not its upload time. |
| **SSN redaction** (summary, transcript, title) | Written and spoken digits, including answers given in the next speaker's line. |
| **Card redaction** (summary, transcript, title) | Credit/debit card numbers (full, or partial: "ending in", "begins with", "last four of the card", "the 0000 card"), security code (CVV/CVC) and expiration date, written or spoken. Runs before SSN redaction so a card's last four is never labelled an SSN. A full number or 4-digit partial found anywhere in a recording is removed everywhere in it. |
| Clean up Plaud's markdown | Removes the `PLAUD NOTE` header, image embeds, `---` rules and blank lines; pairs quotes as `“…”`; splits `> **Label:** text` callouts. |
| **Participants** via an LLM, schema-checked JSON | The model sees the summary, the start of the transcript (names often only appear there), and the database's existing Participant spellings, so a person is spelled the same way every time. The profile owner and `Speaker N` labels are never listed. |
| Create the **Summary** row | Page body is the cleaned summary, written with Notion's markdown API. The title is Plaud's own title without its date. |
| Create the **Transcript** row | The full transcript as plain text, so `*`, `_` or `#` in speech never turn into formatting. |
| Summary → Transcript sync every **5 min** | Finds each Summary's Transcript by page id: the state keeps every pair (Summary page id → Transcript page id) from the moment the rows are written. Only a Summary with no pair yet (a row made by hand, or one from before 1.2.5) is matched by `Recorded` minute (exactly one Summary and one Transcript; ambiguous minutes are skipped), and that match is then kept by id. A full 90-day reconcile runs once a day. |

Reliability: per-profile state (`~/.plaud-notes-to-notion/state/<profile>.json`)
so a crash never duplicates or loses a row; the participant call is retried 6
times, then the rows are written without participants; an expired sign-in raises
a macOS notification (at most every 6 h).

## Notion database

Each profile writes to one Notion database (data source) with these properties:

| Property | Type |
| --- | --- |
| `Meeting` | title |
| `Recorded` | date |
| `Type` | select or multi-select, with options `Summary` and `Transcript` |
| `Participants` | select or multi-select |

`doctor` checks the schema and names any property that is missing or has the
wrong type.

## Profiles

`~/.plaud-notes-to-notion/config.json`. A profile is one Plaud account writing
to one Notion database; profiles differ only in *who* and *where*:

```json
{
  "pollSeconds": 30,
  "syncSeconds": 300,
  "llmModel": "claude-haiku-5-5",
  "profiles": {
    "alex":   { "enabled": true,  "owner": "Alex Example",   "notionDataSourceId": "<data source id>", "startAfter": "2026-01-01T00:00:00Z" },
    "morgan": { "enabled": false, "owner": "Morgan Example", "notionDataSourceId": "<data source id>", "startAfter": "2026-01-01T00:00:00Z" }
  }
}
```

- `owner` — the person whose Plaud this is. They are left out of Participants.
- `notionDataSourceId` — the database's data source id (a `collection://…` id or plain id).
- `startAfter` — only recordings **uploaded** after this instant are written. If another tool was already copying recordings into the same database, set this to the moment you turned that tool off so nothing is written twice.
- `ingest` / `syncTranscripts` (default `true`) — switch either half off.
- `credentials` — use another profile's Keychain secrets (for example a test profile that writes to a test database with the same Plaud sign-in).
- `pollSeconds` (10–3600) and `syncSeconds` (60–86400) set the two loop intervals.
- The daemon re-reads the file when it changes; turning a profile on needs no restart.

### LLM (participant labeling)

`llmModel` picks the provider: `claude-*` → the Claude subscription through
headless Claude Code (`~/.local/bin/claude`, signed in with `claude /login`, or
`CLAUDE_SUBSCRIPTION_BIN`), anything else → OpenAI Responses API (key `openai`).
Default is `claude-haiku-5-5`. The Anthropic key (`anthropic`) is optional and
used only while the subscription is at its plan usage limit: the same model on
the Anthropic Messages API for 15 minutes, then the subscription again. A
session or 5-hour limit waits for the subscription; a server throttle or a bare
429 never moves to the API. With no key,
a limited note waits for the subscription without spending a labeling attempt.
The first limit also holds every label for the same 15 minutes (no Claude Code
is started meanwhile) and ends that poll cycle, so a limited subscription costs
one `claude -p` run per 15 minutes and one log line per poll cycle, not a run
and a log line per waiting note every 30 seconds.

Why it works this way:

- Haiku labels run on the Claude subscription and never on an Anthropic key (Peter: everything that used the Claude API moves to the Claude subscription, no exceptions; 11:08 PM CT Nov 17 2026; T3 Code chat T3-Agent Team Coordinator).
- The Claude API is the fallback only while the subscription is at its plan usage limit, then labels go back to the subscription (Peter: services outside T3 fall back to the Claude API only at the subscription's usage limit, then return to it; 11:58 PM CT Nov 17 2026; T3 Code chat T3-Agent Team Coordinator).
- A one-time failure, a server throttle or a bare 429 never falls back to the API (Peter: never fall back to the API on a one-time failure; 8:53 AM CT Nov 11 2026; T3 Code chat Figure out why both Claude providers don't work). The limit wording is Toolbox claude-side's `USAGE_LIMIT` in `lib/claude_side.py`.
- The tests that hold these rules are named for them in `tests/claude-subscription.test.ts`; the guards the code keeps beyond these are listed in [docs/GUARDS.md](docs/GUARDS.md).
`anthropicBaseUrl` and `openaiBaseUrl` override the API endpoints.

| Want | `config.json` | Key needed |
| --- | --- | --- |
| Claude Haiku (default) | omit `llmModel`, or `"llmModel": "claude-haiku-5-5"` | Claude Code signed in to the Claude subscription; `set-secret anthropic` only for the usage-limit fallback |
| OpenAI | e.g. `"llmModel": "gpt-6-luna", "llmEffort": "high"` | `set-secret openai` |

`llmEffort` only applies to OpenAI. Claude requests use high effort, automatic
tool choice so the model can think before returning Participants, and an
8,192-token output limit. The daemon picks up an `llmModel` change on its next
loop (no restart). If the selected model's key is missing, that profile pauses
(no ingest or sync) until the key is saved; `doctor` names the `set-secret`
command.

### Keys from the environment (for example `infisical-run`)

Every key except the Plaud sign-in can come from an environment variable. A
variable that is set and not blank is used; otherwise the Keychain item is read
exactly as before, so an unchanged LaunchAgent behaves as it always has.

| Keychain account | Environment variable |
| --- | --- |
| `notion:<profile>` | `NOTION_TOKEN_<PROFILE>` (e.g. `NOTION_TOKEN_ALEX`) |
| `anthropic:<profile>` | `ANTHROPIC_API_KEY_<PROFILE>` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai:<profile>` | `OPENAI_API_KEY_<PROFILE>` |
| `openai` | `OPENAI_API_KEY` |

`<PROFILE>` is the profile's `credentials` name in upper case, with anything
other than letters and digits turned into `_`. The profile's own key is still
tried before the shared one, each from its variable first and its Keychain item
second. The Plaud sign-in (`plaud:<profile>`) is refreshed and written back by
the daemon, so it always stays in the Keychain.

## Setup (macOS, logged-in GUI session)

```bash
npm install -g plaud-notes-to-notion        # the published package (see Deploy); a checkout is for development only
plaud-notes-to-notion login --profile alex   # opens Plaud → sign in → Authorize
plaud-notes-to-notion set-secret notion --profile alex   # Notion internal integration secret (paste, hidden)
plaud-notes-to-notion set-secret anthropic               # Anthropic API key (shared; only the fallback on the Claude subscription's usage limit)
plaud-notes-to-notion set-secret openai                  # OpenAI API key (shared; only if llmModel is not claude-*)
plaud-notes-to-notion doctor --profile alex
sh "$(npm root -g)/plaud-notes-to-notion/examples/install-launchagent.sh"
```

The Notion integration needs **Read / Update / Insert** on the database
(••• → Connections). On macOS, secrets live only in the Keychain service
`plaud-notes-to-notion` (accounts `plaud:<profile>`, `notion:<profile>`,
`anthropic`, `openai`; a profile-specific `anthropic:<profile>` /
`openai:<profile>` wins over the shared one). `set-secret` reads the value from
hidden input, or copies an existing Keychain item with
`--from-keychain <service>/<account>`. `login --no-browser` prints the sign-in
link instead of opening it. `sh examples/install-launchagent.sh [/path/to/bin/plaud-notes-to-notion.js]` installs or refreshes the LaunchAgent for the current user in its GUI session, so the Keychain works; no secret goes in the plist.

The install script writes `~/Library/LaunchAgents/com.plaud-notes-to-notion.plist`
for the current user and loads it; it runs `plaud-notes-to-notion run`.

## Deploy

The running service is only ever the published npm package. After a change is
merged: bump the version (`package.json`, `package-lock.json`, `CHANGELOG.md`),
publish a GitHub Release (its workflow tests, then publishes to npm), and on the
Mac run `npm install -g plaud-notes-to-notion@<version>`, then restart the
LaunchAgent. Never `git pull` or build in the checkout the LaunchAgent runs
from as a deploy step; `npm run build` in a checkout is for development.

## Everyday commands

```bash
plaud-notes-to-notion status                              # last poll / sync / write per profile
plaud-notes-to-notion once --profile alex --dry-run        # show what would be written, write nothing (--deep: 30-day scan)
plaud-notes-to-notion sync --profile alex --dry-run        # show Transcript fixes, change nothing (--full: 90-day reconcile)
plaud-notes-to-notion scrub --profile alex                 # find SSNs and card details in rows already in Notion
plaud-notes-to-notion scrub --profile alex --apply         # remove them
plaud-notes-to-notion logout --profile alex                # forget that profile's Plaud sign-in
tail -f ~/Library/Logs/plaud-notes-to-notion.log
```

## Development

```bash
npm ci
npm test && npm run typecheck && npm run build
```

Tests use explicitly fictional people, calls and all-zero SSNs; payment-card numbers are standard synthetic test values. Never commit tokens, real transcripts or database ids.

`PLAUD_NOTES_HOME` points config, state, logs and a file-based secret store at
another directory (used by tests).

### Privacy gates

Install Gitleaks 8.30.1 and enable the staged gate once per clone:

```bash
git config core.hooksPath .githooks
gitleaks git --log-opts=--all --config .gitleaks.toml --redact=100 --no-banner .
npm run build && npm run scan:package
```

Before a pull request is merged, `python3 .security/local-gate.py <PR number>`
runs Gitleaks, the production `npm audit`, offline Semgrep and the tests on the
exact PR head and records the result as the `local-gate` status. Push and
pull-request CI also scans full fetched history and package contents.
`prepublishOnly` rebuilds and scans the exact npm file list before publication.
Use home-derived paths and local config for real owners and destinations.
After a rewritten history, discard old clones and re-clone; merging old history
can restore removed data.
