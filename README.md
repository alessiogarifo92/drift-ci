# Drift CI

Checks every pull request for docs and AI-agent context files (AGENTS.md, CLAUDE.md, .cursorrules, copilot-instructions) that reference things the PR renamed or removed, and flags the exact lines before merge.

## CLI

Requires Node 22 or later and git. The CLI reads commits straight from git, never the working tree.

```sh
drift-ci check [--base <ref>] [--head <ref>] [--cwd <dir>] [--format text|json] [--fail-on none|warning]
drift-ci scan  [--head <ref>] [--cwd <dir>] [--format text|json] [--fail-on none|warning]   # beta
```

A bare `drift-ci` is `drift-ci check`.

### `check`

Compares the docs of `--head` with what changed since `--base` and reports every reference the change renamed or removed: file paths, npm scripts, Make targets, bins and environment variables. A reference is reported only when it pointed at something in the base commit and points at nothing in the head commit, so drift that was already there, and docs already fixed in the same change, are never reported.

| Option | Default | |
|---|---|---|
| `--base <ref>` | `HEAD^` | Commit to compare against. |
| `--head <ref>` | `HEAD` | Commit whose docs are checked. |
| `--cwd <dir>` | current directory | Any directory inside the repository. |
| `--format <format>` | `text` | `text` or `json`. |
| `--fail-on <level>` | `failOn` of `.drift-ci.yml`, else `none` | `warning` makes findings fail the run. |

Docs, checks, ignores and `failOn` come from `.drift-ci.yml` at the root of the head commit.

### `scan` (beta)

Looks at one commit, with no base: it reports references in the docs that do not exist at `--head`. Use it to audit a repository that has never been checked. It is a beta: with no change to prove a reference once worked, expect false positives (a doc may legitimately name a file of another repository).

Scan reports only references it can judge from the commit alone:

- **Paths** that exist nowhere they could resolve. Paths under a build directory or ignored by a `.gitignore` are skipped, and so is a token like `owner/repo` that has no extension, no trailing `/` and no existing parent directory.
- **npm scripts** written as `npm run <script>` or `pnpm run <script>` that the resolved `package.json` does not define. `npm start`, `pnpm <script>`, `yarn` and `bun` forms are skipped: they can run a file or a dependency's bin.
- **Make targets** that no makefile in scope defines, only when there is such a makefile, it includes nothing scan cannot read, and no file of that name exists.

Scan never reports environment variables (they need the diff to be told apart from variables the project still reads) and never reports bins (a command name cannot be told from any other program). It takes no `--base`. Its text output starts with a `scan mode (beta): ...` line on stderr.

### Output

Text, the default, groups findings by file:

```text
README.md
  3:15  `src/old.ts` was renamed to `lib/new.ts` in this change
    -> lib/new.ts

docs/dev.md
  10:2  npm script `build` (package `app`) was removed in this change

2 findings in 2 files
```

Each line is `line:column  message`; `->` introduces the replacement text the doc should use, when git or the manifests show where the thing went. With no findings the output is `0 findings`. Warnings (a `package.json` that does not parse, a rename limit that was hit) go to stderr as `warning: ...` lines, never to stdout.

`--format json` prints one document, two-space indented, on stdout:

```json
{
  "schemaVersion": 1,
  "mode": "diff",
  "base": "<full SHA>",
  "head": "<full SHA>",
  "findings": [
    {
      "ruleId": "path",
      "kind": "path",
      "fact": "src/old.ts",
      "file": "README.md",
      "line": 3,
      "col": 15,
      "message": "`src/old.ts` was renamed to `lib/new.ts` in this change",
      "fingerprint": "0123456789abcdef",
      "suggestion": "lib/new.ts"
    }
  ],
  "warnings": [],
  "failOn": "none"
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Version of this schema; `1` today. Fields are only ever added within a version. |
| `mode` | `diff` for `check`, `scan` for `scan`. |
| `base` | Full SHA of the base commit. Absent in `scan`. |
| `head` | Full SHA of the head (or scanned) commit. |
| `findings[].ruleId` | `path`, `npm-script`, `make-target`, `bin` or `env` (`scan`: never `bin` or `env`). |
| `findings[].kind` | Kind of reference: `path`, `npm-script`, `make-target`, `command` or `env`. |
| `findings[].fact` | What drifted, e.g. a repo-relative path or `package.json#build`. |
| `findings[].file`, `line`, `col` | Where the doc mentions it; 1-indexed, columns in UTF-16 code units. |
| `findings[].message` | What happened to it. |
| `findings[].suggestion` | Optional. The replacement text, in the style the doc used. Never present in `scan`. |
| `findings[].fingerprint` | Stable id of the finding; survives unrelated edits above it. |
| `warnings` | Conditions that may make the result incomplete. |
| `configChanged` | Only present, as `true`, when the change itself edits `.drift-ci.yml`: the check ran with the new version. |
| `failOn` | The effective level the exit code used: `--fail-on` if given, else `failOn` of `.drift-ci.yml`, else `none`. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The run completed, and either there are no findings or `failOn` is `none`. |
| `1` | There are findings and the effective `failOn` (`--fail-on`, else `.drift-ci.yml`) is `warning`. Findings are still printed. |
| `2` | Usage or runtime error: unknown option or subcommand, unknown ref, not a git repository, invalid `.drift-ci.yml`, or an unexpected internal error (`drift-ci: internal error: ...`). Nothing is printed on stdout. |

## GitHub Action

Add `.github/workflows/drift.yml`:

```yaml
name: Drift CI
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: drift-ci-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 2
      - uses: alessiogarifo92/drift-ci@main # for trying it out: see "Pin the action" below
```

The `concurrency` block makes a newer push cancel the run of the previous one, so two runs never race to update the same sticky comment.

**Pin the action.** `@main` follows whatever lands on the default branch: a compromised or broken push would run in your workflow with your `pull-requests: write` token. For anything beyond trying it out, pin a full commit SHA of a release, with the tag in a comment so Dependabot can update it:

```yaml
      - uses: alessiogarifo92/drift-ci@<commit-sha> # vX.Y.Z
```

A tag can be moved after you reviewed it; a commit SHA cannot.

### How it works

- **Trigger: `pull_request` only.** Other events (`push`, ...) log a message and do nothing. `pull_request_target` works but warns: it runs with the base repository's token and a checkout of the base branch, which is rarely what you want for a check on a PR's own docs. A pull request with merge conflicts gets no `pull_request` run at all, so resolve them first.
- **What is compared.** On the default merge checkout, `HEAD` is the merge commit GitHub builds for the PR and its first parent is the base branch, so `fetch-depth: 2` is enough. If you check out the PR head instead (`ref: ${{ github.event.pull_request.head.sha }}`), the action fetches the base commit from `origin` and uses the merge-base, deepening the history once if needed. That needs the credentials `actions/checkout` persists (do not set `persist-credentials: false`), and falls back to a clear error that points at `fetch-depth: 0`.
- **Permalinks** point at `pull_request.head.sha`, with the file and line found in the merge commit. They differ from the head's own lines only when the base branch edited the same doc.

### What you get

- **Job summary**: every finding.
- **Annotations**: the first 10 findings on their lines (GitHub shows at most 10 per step); the summary has the rest. Warnings of the run itself (an unreadable `package.json`, a skipped doc) go to the log and the summary, never to annotations, so they cannot push findings out of the ten.
- **One sticky PR comment**, updated in place on every push (found by a hidden marker; only a comment by `github-actions[bot]`, or by the user the token belongs to when it is a personal or app token, is edited). Each finding links to the line at `head.sha` (Markdown files open as source, `?plain=1`, so the line anchor works) and shows the suggested replacement. When the pull request itself changes `.drift-ci.yml`, a note at the top says the check used the new configuration. Text quoted from the docs is neutralised: no `@`-mentions, no HTML. When a later push fixes everything, the comment is edited to say "no drift found" rather than deleted; a PR that never had findings gets no comment.
- **Fork PRs, or a token without `pull-requests: write`**: summary and annotations only, with a note in the summary. The job does not fail.

### Inputs

| Input | Default | |
|---|---|---|
| `fail-on` | empty | `warning` fails the job when there is at least one finding, `none` never does. Empty uses `failOn` from `.drift-ci.yml` (default `none`). |
| `comment` | `true` | `false` skips the PR comment. |
| `github-token` | `${{ github.token }}` | Token for the PR comment. Needs `pull-requests: write`. |
| `config` | empty | Reserved: only `.drift-ci.yml` at the repository root is read. Any other value is ignored with a warning. |

The job fails on an unreadable base, an invalid `.drift-ci.yml`, or an unexpected GitHub API error while commenting. Findings alone do not fail it unless `fail-on` (or `failOn` in the config) says `warning`.
