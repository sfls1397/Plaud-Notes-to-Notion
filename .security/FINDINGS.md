# Dependency and Code Security Findings

These gates extend Gitleaks without weakening its config. Tooling-only rollout: no runtime source, product version or dependency version changes. Existing findings below are explicitly documented rather than represented as fixed. The gate accepts only their exact fingerprints; new/changed findings, expired exceptions and scanner/registry failures block commits/PRs/publishing. No broad baseline, directory waiver or inline nosemgrep suppression.

## Coverage

Offline ruleset v1 has 13 reviewed JavaScript/TypeScript and Python rules for dynamic code execution, shell-mode subprocesses, request-to-shell injection, disabled TLS, insecure hashes and unsafe deserialization/YAML. It is a high-signal starter set, not exhaustive security review or Semgrep Pro analysis. Tests and scripts are scanned; `.semgrepignore` excludes only generated output, caches and dependencies. Scan output contains rule/file/line, never source snippets.

## Dependency Findings

No production dependency advisories at rollout.


## Code Findings

No findings after rule review. The request-to-shell rule targets child-process calls, not RegExp.exec.


## Running and Reviewing

Enable `.githooks` for every clone. Install Semgrep using the pin in `.cursor/install-semgrep.sh` and Python 3.10+; Mini Codex/Claude Code share the installed hook/scanner. `python3 .security/scan.py all` runs `npm audit --omit=dev --audit-level=high --json` and `semgrep scan --config .security/semgrep.yml --error --strict --metrics off --disable-version-check --disable-nosem --json`. npm registry/network errors fail closed. Pre-commit scans index bytes and audits staged package files when those files or policy change. The local pre-PR/pre-deploy gate (`.security/local-gate.py`) and npm prepublishOnly run the full gate. Cursor installation uses `.cursor/install-security.sh`, which also runs the full gate.

Raw npm audit may exit 1 for the documented high findings above. The wrapper prints each finding and accepts only exact, unexpired fingerprints with a reason and remediation tracking. Never extend expiry or change a fingerprint without reviewing the finding; remove entries when remediated. The local gate (`.security/local-gate.py`) runs negative tests for new/changed high findings, outages, unsafe staged code hidden by unstaged edits, invalid rules and expired policy. Keep all scanner/agent setup files excluded from npm packages.

## Complete repository privacy and language gates

The privacy gate also checks raw Git author/committer headers and commit messages. New commits require GitHub noreply; history permits only GitHub noreply and the exact public tool identities documented by metadata.py. Mailmap cannot conceal private identities. Commit-msg scans messages for secrets; pre-push runs metadata, full-history Gitleaks and full dependency/code checks. Before merging, run `python3 .security/local-gate.py PR_NUMBER` from the reviewed PR checkout: it runs every gate plus this repository's tests (`.security/local-gate.json`) on the exact head in a clean worktree and records the result on that SHA as the `local-gate` commit status and a PR comment. Then `python3 .security/merge-pr.py PR_NUMBER` requires that recorded PASS from the owner on the exact head (GitHub Actions are not the merge gate), reruns full local gates, and merges with a matching-head condition. Public repositories also require the `local-gate` status in branch protection; private branch protection depends on the account plan, so there the command is an enforced agent workflow, not a GitHub-side access restriction.

The code gate includes checksum-pinned ShellCheck at warning/error threshold for shell files, including extensionless wrappers, and Clang Static Analyzer for C/Objective-C helpers on macOS. On macOS the local gate (`.security/local-gate.py`) runs the Clang analysis for native helpers; Linux reports the platform handoff explicitly. No source language is silently claimed as analyzed by Semgrep. Add language-appropriate checks before adding a new runtime language. All scanners run locally and report locations/rule names without source snippets. Runtime downloads and separately installed language environments require their own dependency audit; npm audit of the parent manifest alone does not cover them.
