# Changelog

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
