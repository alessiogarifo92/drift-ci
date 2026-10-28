# Drift CI

Checks every pull request for docs and AI-agent context files (AGENTS.md, CLAUDE.md, .cursorrules, copilot-instructions) that reference things the PR renamed or removed, and flags the exact lines before merge.

## GitHub Action

Add `.github/workflows/drift.yml`:

```yaml
name: Drift CI
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 2
      - uses: alessiogarifo92/drift-ci@main
```

Pin the action to a release tag or a commit SHA once there is one.

### How it works

- **Trigger: `pull_request` only.** Other events (`push`, ...) log a message and do nothing. `pull_request_target` works but warns: it runs with the base repository's token and a checkout of the base branch, which is rarely what you want for a check on a PR's own docs. A pull request with merge conflicts gets no `pull_request` run at all, so resolve them first.
- **What is compared.** On the default merge checkout, `HEAD` is the merge commit GitHub builds for the PR and its first parent is the base branch, so `fetch-depth: 2` is enough. If you check out the PR head instead (`ref: ${{ github.event.pull_request.head.sha }}`), the action fetches the base commit from `origin` and uses the merge-base, deepening the history once if needed. That needs the credentials `actions/checkout` persists (do not set `persist-credentials: false`), and falls back to a clear error that points at `fetch-depth: 0`.
- **Permalinks** point at `pull_request.head.sha`, with the file and line found in the merge commit. They differ from the head's own lines only when the base branch edited the same doc.

### What you get

- **Job summary**: every finding.
- **Annotations**: the first 10 findings on their lines (GitHub shows at most 10 per step); the summary has the rest.
- **One sticky PR comment**, updated in place on every push (found by a hidden marker; only the Actions bot's own comment is edited). Each finding links to the line at `head.sha` and shows the suggested replacement. Text quoted from the docs is neutralised: no `@`-mentions, no HTML. When a later push fixes everything, the comment is edited to say "no drift found" rather than deleted; a PR that never had findings gets no comment.
- **Fork PRs, or a token without `pull-requests: write`**: summary and annotations only, with a note in the summary. The job does not fail.

### Inputs

| Input | Default | |
|---|---|---|
| `fail-on` | empty | `warning` fails the job when there is at least one finding, `none` never does. Empty uses `failOn` from `.drift-ci.yml` (default `none`). |
| `comment` | `true` | `false` skips the PR comment. |
| `github-token` | `${{ github.token }}` | Token for the PR comment. Needs `pull-requests: write`. |
| `config` | empty | Reserved: only `.drift-ci.yml` at the repository root is read. Any other value is ignored with a warning. |

The job fails on an unreadable base, an invalid `.drift-ci.yml`, or an unexpected GitHub API error while commenting. Findings alone do not fail it unless `fail-on` (or `failOn` in the config) says `warning`.
