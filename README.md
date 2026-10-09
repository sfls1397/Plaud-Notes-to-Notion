# Plaud Notes to Notion

Mac Mini **LaunchAgent** that replaces the two Zapier Zaps
(*Peter / Tim: Plaud → Notion: Transcript + Summary*). When Plaud finishes a
recording's summary, it writes two rows into that person's **Plaud Notes**
Notion database — one `Summary`, one `Transcript` — structured exactly like the
Zap's rows. Every 5 minutes it also copies **Summary** title/participant edits
onto the matching **Transcript** row.

No Zapier, no extra runtime dependencies (Node ≥ 20 built-ins only).

## What it does (per profile)

| Step | Zap step it replaces | Notes |
| --- | --- | --- |
| Poll Plaud every **30 s** (deep 30-day scan every 10 min) | 1. Plaud *Transcript & Summary Ready* | Writes only once Plaud has **both** the auto summary and the transcript. Zapier took ~1–2 min. |
| `Recorded` = recording start, to the minute, true UTC | 2. Date/Time `+5 hours` | The Zap's +5h hid Plaud's Central-time-labelled-UTC bug and would be **1 h off after DST ends**. |
| **SSN redaction** (summary, transcript, title) | — (new) | Written *and* spoken digits, incl. answers in the next speaker's line. Runs before anything leaves the Mac. |
| **Card redaction** (summary, transcript, title) | — (new) | Credit/debit card numbers (full, or partial: "ending in", "begins with", "last four of the card", "the 4417 card"), security code (CVV/CVC) and expiration date. Written or spoken; runs before SSN redaction so a card's last four is never labelled an SSN. A full number or 4-digit partial found anywhere in a recording is removed everywhere in it. |
| Remove `PLAUD NOTE`; pair quotes `“…”` | 3–4. Formatter Text | The Zap turned every `"` into `”`. |
| Strip Plaud image embeds, `---`, blank lines; split `> **Label:** text` | 5. Code (JavaScript) | Ported verbatim. |
| Participants via **Claude Haiku 5.5** (default) or **GPT-6 Luna, high effort**, schema-checked JSON | 6. AI by Zapier | Also sees the transcript (names often only appear there) and the database's existing Participant spellings (e.g. `Casey - Bank`). Owner and `Speaker N` labels never listed. |
| Create **Summary** row (Notion markdown API) | 7. Notion | Block-for-block identical to the Zap's output. |
| Create **Transcript** row (one plain-text paragraph) | 8. Notion | Exact text — `*`, `_`, `#` in speech can never turn into formatting. |
| Summary → Transcript sync every **5 min** | Grok *Sync Plaud Transcripts to Summaries* (retired) | Pair by `Recorded` minute; skip ambiguous minutes; full 90-day reconcile daily. |

Reliability: per-file state (`~/.plaud-notes-to-notion/state/<profile>.json`) so a
crash never duplicates or loses a row; labeling retried 6× then falls back to
Plaud's own title; recordings still generating are re-checked every poll (up to
48 h); expired sign-ins raise a macOS notification (at most every 6 h).

## Profiles

`~/.plaud-notes-to-notion/config.json` — profiles differ only in *who* and *where*:

```json
{
  "pollSeconds": 30,
  "syncSeconds": 300,
  "llmModel": "claude-haiku-5-5",
  "profiles": {
    "peter": { "enabled": true,  "owner": "Peter", "notionDataSourceId": "<Plaud Notes data source id>", "startAfter": "<cutover ISO time>" },
    "tim":   { "enabled": false, "owner": "Tim",   "notionDataSourceId": "<Tim's Plaud Notes data source id>", "startAfter": "<cutover ISO time>" }
  }
}
```

- `startAfter` — only recordings **uploaded** after this instant are ingested. Set it to the moment the Zap is turned off so nothing is written twice.
- `ingest` / `syncTranscripts` (default `true`) — switch either half off.
- `credentials` — use another profile's Keychain secrets (e.g. a test profile that writes to a test database with Peter's sign-in).
- The daemon re-reads the file when it changes; turning a profile on needs no restart.

### LLM (participant labeling)

`llmModel` picks the provider: `claude-*` → Anthropic Messages API (key
`anthropic`), anything else → OpenAI Responses API (key `openai`). Default is
`claude-haiku-5-5`.

| Want | `config.json` | Key needed |
| --- | --- | --- |
| Claude Haiku (default) | omit `llmModel`, or `"llmModel": "claude-haiku-5-5"` | `set-secret anthropic` |
| Back to GPT-6 Luna | `"llmModel": "gpt-6-luna", "llmEffort": "high"` | `set-secret openai` |

`llmEffort` only applies to OpenAI. The daemon picks up an `llmModel` change on
its next loop (no restart). If the selected model's key is missing, that
profile pauses (no ingest or sync) until the key is saved — run
`doctor` first; it names the `set-secret` command.

## Setup (on the Mini, logged-in GUI session)

```bash
npm install -g plaud-notes-to-notion        # or build from a checkout: npm ci && npm run build
plaud-notes-to-notion login --profile peter # opens Plaud → sign in as that person → Authorize
plaud-notes-to-notion set-secret notion --profile peter   # Notion internal integration secret (paste, hidden)
plaud-notes-to-notion set-secret anthropic                # Anthropic API key (shared; Haiku, the default)
plaud-notes-to-notion set-secret openai                   # OpenAI API key (shared; only if llmModel is gpt-*)
plaud-notes-to-notion doctor --profile peter
sh "$(npm root -g)/plaud-notes-to-notion/examples/install-launchagent.sh"
```

The Notion integration needs **Read / Update / Insert** on that person's Plaud
Notes database (••• → Connections). Secrets live only in Keychain service
`plaud-notes-to-notion` (accounts `plaud:<profile>`, `notion:<profile>`, `anthropic`, `openai`; a
profile-specific `anthropic:<profile>` / `openai:<profile>` wins over the shared one).

## Everyday commands

```bash
plaud-notes-to-notion status                          # last poll / sync / write per profile
plaud-notes-to-notion once --profile peter --dry-run  # show what would be written, write nothing
plaud-notes-to-notion sync --profile peter --dry-run  # show Transcript fixes, change nothing
tail -f ~/Library/Logs/plaud-notes-to-notion.log
```

## Development

```bash
npm ci
npm test && npm run typecheck && npm run build
```

Tests use made-up SSNs and card numbers only. Never commit tokens, real transcripts or database ids.
