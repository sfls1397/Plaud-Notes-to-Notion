# Application privacy and security review

Reviewed during the October 12, 2026 Path 2 Entrypoint B Codex standardization. Base commit: d35a70bc3e1601c94bdd7ad0660081ff25030b7a. Candidate changes are described below; this document alone does not claim they are deployed.

Loopback OAuth state/PKCE, external API endpoints, secret redaction, local file permissions, package contents and stdin Keychain writer reviewed. Writer quoting now matches the utility parser; oversized/invalid input fails before writing and failed writes no longer delete the existing credential. Tooling PR13 is merged; these later runtime fixes still require their own release.

Scope: tracked source and scripts, raw Git metadata and full-history patch scans, production dependency manifests, actual package file inventory, local authentication boundaries, credential/logging paths, local data permissions, and separately managed runtime components where present. Scanner PASS is a limited set of checks, not a guarantee against all vulnerabilities. This was not an external penetration test or exhaustive formal verification. Live personal content was not copied into this repository, PRs or Notion.

Evidence: repository dependency/code gates and their negative enforcement tests; local build and relevant application tests; disposable Keychain create/update/escaping/large-session readbacks with cleanup; local HTTP authorization probes; ShellCheck and macOS Clang where applicable. Reviewed historical public automation identities remain exact; prospective commits require GitHub noreply.
