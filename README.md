# Plaud Notes to Notion

A small macOS background service (LaunchAgent) that copies finished
[Plaud](https://www.plaud.ai/) recordings into a Notion database. For each
recording it writes two rows, one `Summary` and one `Transcript`. Every 5
minutes it also copies title and participant edits you make on a **Summary** row
onto the matching **Transcript** row.

Before anything leaves your Mac, Social Security numbers and payment-card
details are removed from the summary, transcript, and title. Participant names
are filled in by a language model (Anthropic Claude by default, or OpenAI).

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
| Summary → Transcript sync every **5 min** | Pairs rows by `Recorded` minute and skips ambiguous minutes. A full 90-day reconcile runs once a day. |

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

`llmModel` picks the provider: `claude-*` → Anthropic Messages API (key
`anthropic`), anything else → OpenAI Responses API (key `openai`). Default is
`claude-haiku-5-5`. `anthropicBaseUrl` and `openaiBaseUrl` override the API
endpoints.

| Want | `config.json` | Key needed |
| --- | --- | --- |
| Claude Haiku (default) | omit `llmModel`, or `"llmModel": "claude-haiku-5-5"` | `set-secret anthropic` |
| OpenAI | e.g. `"llmModel": "gpt-6-luna", "llmEffort": "high"` | `set-secret openai` |

`llmEffort` only applies to OpenAI. Claude requests use high effort, automatic
tool choice so the model can think before returning Participants, and an
8,192-token output limit. The daemon picks up an `llmModel` change on its next
loop (no restart). If the selected model's key is missing, that profile pauses
(no ingest or sync) until the key is saved; `doctor` names the `set-secret`
command. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment is used
before the Keychain key.

## Setup (macOS, logged-in GUI session)

```bash
npm install -g plaud-notes-to-notion        # or build from a checkout: npm ci && npm run build
plaud-notes-to-notion login --profile alex   # opens Plaud → sign in → Authorize
plaud-notes-to-notion set-secret notion --profile alex   # Notion internal integration secret (paste, hidden)
plaud-notes-to-notion set-secret anthropic               # Anthropic API key (shared; the default model)
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
link instead of opening it.

The install script writes `~/Library/LaunchAgents/com.plaud-notes-to-notion.plist`
for the current user and loads it; it runs `plaud-notes-to-notion run`.

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
