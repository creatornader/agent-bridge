# 2026-10-23 Agent Bridge Dependency Scan Recurrence

## Status

The vulnerable package versions found in October are fixed in Agent Bridge
0.7.9. The OSV check now runs on pull requests and is a required status check
for `main`.

The weekly scan should fail while the lockfile contains a known vulnerable
version. The required pull-request check stops a dependency update with that
finding from merging into `main`.

## Impact

The scheduled security scans on October 4, 11, and 18 failed in the OSV
vulnerability gate. The October 18 scan found five advisories across
`@modelcontextprotocol/sdk` 1.30.1, `fast-uri` 3.1.6, and Hono 4.13.5. The
scanner completed and uploaded SARIF before reporting the findings.

After the first dependency patch, a later main-branch scan found four new
advisories against `fast-uri` 3.1.8. OSV identified 3.1.9 as the fixed version.
No scanner outage or SARIF upload failure occurred in these runs.

## Causes

Before PR #125, OSV did not run on pull requests. The weekly scan could discover
vulnerable lockfile entries only after they reached `main`. PR #125 enabled OSV
for pull requests and updated the then-known vulnerable packages.

The later advisories against `fast-uri` 3.1.8 were disclosed after that update.
PR #126 changed the override and lockfile to 3.1.9 and released package 0.7.9.

One enforcement gap remained after PR #125: GitHub's required status checks
included the other security-scan jobs but omitted `scan / OSV-Scanner (CVE
scan)`. A failing OSV result could therefore appear on a PR without blocking
its merge. The `main` branch protection now requires this check from the
GitHub Actions app and preserves the existing strict up-to-date rule and all
other required checks.

## Corrective Changes

- PR #125 updated the affected dependencies and enabled OSV on pull requests.
- PR #126 moved `fast-uri` to 3.1.9, passed the PR and main scans, and released
  package 0.7.9.
- GitHub branch protection now requires `scan / OSV-Scanner (CVE scan)` for
  pull requests to `main`.
- [SECURITY.md](../../SECURITY.md) and [CLAUDE.md](../../CLAUDE.md) record the
  scan and merge-check policy.

The branch-protection setting lives in GitHub rather than in the repository.
Keep it in sync if a workflow change renames the OSV job. Do not weaken or
suppress the scan to restore a green run.

## Verification

- The October 18 scheduled run, [39129159029](https://github.com/creatornader/agent-bridge/actions/runs/39129159029), uploaded SARIF and failed on five OSV findings.
- The follow-up main scan, [40029835319](https://github.com/creatornader/agent-bridge/actions/runs/40029835319), reported four advisories in `fast-uri` 3.1.8 and identified 3.1.9 as fixed.
- PR #126 and the main scan on commit `4413a92762dfa6a302e06026050018a3f74335c3` passed OSV after the update.
- npm reports package version 0.7.9, and the tagged GitHub release is published.
- Current Dependabot and code-scanning alert queries returned zero open alerts.
- No intentionally vulnerable pull request was created to test a failing merge gate. The check identity is confirmed from successful pull-request and main runs, and its required state was re-read from GitHub after the policy update.
