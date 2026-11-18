# Changelog

## 1.2.9

- Claude Haiku participant labels run on the Claude subscription first, through headless Claude Code (allowlisted child environment, `--setting-sources ""`; a reply is accepted only when Claude Code reports the subscription sign-in, `apiKeySource: "none"`, and a Haiku model). The Anthropic key, when stored, is used only while the subscription is at its usage limit: the same model on the Messages API for 15 minutes, then the subscription again. With no key, a limit leaves the recording waiting without spending a labeling attempt. A daemon whose Claude Code is not runnable stops with a setup error.

## 1.2.8

- Avoid overlapping scans of malformed per-profile secret names while retaining redaction for long profile names.
- Keep Notion and LLM API credentials out of the subscription service-model child's environment without changing the daemon's environment.

## 1.2.7

- Read every Notion and LLM key from the environment first and the Keychain second: `NOTION_TOKEN_<PROFILE>`, `ANTHROPIC_API_KEY_<PROFILE>`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY_<PROFILE>` and `OPENAI_API_KEY`, so the daemon can run under `infisical-run`. A blank variable falls back to the Keychain. The profile's own LLM key now wins over the shared `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` variable, matching what the Keychain-only service already used. Plaud sign-ins stay in the Keychain. Log redaction covers the per-profile variable names.

## 1.2.6

- Add the explicit Toolbox service-engine policy and subscription-only Codex Sol labeler. Observe changes between daemon units without changing in-flight ingestion. Restore the configured provider when switched back; no automatic fallback.

## 1.2.5

- Find Notion rows by page id. Each Summary↔Transcript pair is kept by both page ids from the moment the rows are written (and backfilled from existing state); the title sync, the trash sync and a re-run of a recording open the pages by id. The `Recorded` minute + title lookup is only the first-time fallback, and its match is kept by id.
- Pairs are no longer dropped when their recording ages out of the 90-day window or a `Recorded` date is edited; a pair whose page answers 404 is kept as gone and reported once instead of every cycle.

## 1.2.4

- Rewrite the README and package description for any Plaud + Notion user; document the Notion schema, `scrub`, `logout` and the remaining CLI flags.

## 1.2.2

- Use high effort for Claude participant labeling, retaining automatic tool choice and thinking headroom.

## 1.2.1

- Request max effort for Claude participant labeling.
- Allow Haiku to think before calling the labels tool, with an 8,192-token output limit.

## 1.2.0

- Replace personal identities and call-like fixtures with clearly synthetic examples.
- Add staged, full-history CI and pre-publish package privacy/secret scans.
- Preserve home-derived configuration, Keychain accounts and existing runtime state.


## 1.1.0

Participant labeling now defaults to Claude Haiku 5.5 (`claude-haiku-5-5`),
replacing Claude Haiku 4.5. Existing installs that set `"llmModel":
"claude-haiku-4-5"` in `config.json` keep that model until the setting is
changed or removed. No request changes were needed: Haiku 5.5 accepts the
forced `plaud_labels` tool call.

## 1.0.0

First public release.

Polls Plaud and writes Summary and Transcript rows into a Plaud Notes Notion
database, with SSN and card redaction, participant labeling, and
Summary→Transcript title/participant sync. Secrets stay in Keychain (macOS)
or a local file store (Linux); config lives under `~/.plaud-notes-to-notion/`.
