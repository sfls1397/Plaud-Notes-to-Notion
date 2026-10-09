# Changelog

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
