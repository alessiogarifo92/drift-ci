# Decisions

## Phase 1 — Idea (2026-10-26)

**Goal.** When a pull request renames or removes something (symbol, env var, CLI command, path, script, route), Drift CI flags — before merge — the exact lines in docs and AI-agent context files that are now wrong. Few false positives; deterministic core.

**Why now.** In 2026 coding agents read AGENTS.md / CLAUDE.md / docs as input, so a stale doc becomes a bug in generated code. Sold as AI-agent quality tooling, not "documentation tooling".

**Users.** Teams of 3–50 developers using AI coding agents (paying, private repos); OSS maintainers (free, public repos — distribution and validation).

**Shape chosen: C — hybrid.**
- Now: open-source deterministic core as a CLI + GitHub Action, running in the user's CI (code never leaves it).
- Later, only if validation passes: hosted GitHub App for teams (dashboard, org-wide rule packs, Marketplace billing).
- Rejected: A (hosted app first — infra and trust cost before demand is proven); B (CLI only — weak monetization).

**MVP scope.** Both agent context files (AGENTS.md, CLAUDE.md, .cursorrules, .cursor/rules, .github/copilot-instructions.md) and Markdown docs (README, docs/, runbooks). Deterministic checks only; LLM-proposed fixes are out of MVP.

**Pricing hypothesis.** Free for public repos; Team 29 €/month (up to 10 private repos); Business 99 €/month. Unvalidated.

**Validation gates (heuristics).**
1. On 50 public repos: ≥70% of warnings correct.
2. ≥50% of fix PRs opened on those repos accepted.
3. ≥3 paying pilots (29–99 €) within 6 weeks of launch. If this fails, fall back to the "report automatici" idea, not ReviewSieve.

**Known risks.** GitHub Agentic Workflows "Daily Documentation Updater" (post-merge, LLM) could add a pre-merge check; willingness to pay unproven; competitors DeepDocs, DocuPilot, Driftless, Swimm.

**Repo.** `alessiogarifo92/drift-ci`, public.

## Phase 2 — Tools & cost (2026-10-26)

Prices and licenses checked on official sources on 2026-10-26.

| Decision | Choice | License / cost today | Cost at 10x | Rejected |
|---|---|---|---|---|
| Language (CLI + Action) | TypeScript on Node; JavaScript GitHub Action, published on npm | MIT/Apache deps; €0 | €0 | Go (cgo for tree-sitter, second language for the app), Rust (overkill) |
| Markdown parsing | remark / mdast | MIT; €0 | €0 | — |
| Code parsing | None in MVP: changed names come from git renames/deletions, package.json/Makefile scripts, env vars, commands, paths. tree-sitter (MIT, `web-tree-sitter` WASM) only if false positives require it | €0 | €0 | tree-sitter from day one (more deps before need is shown) |
| CI | GitHub Actions on this public repo | €0 (standard runners unlimited on public repos) | €0 | — |
| Core license | Apache-2.0 | — | — | MIT (no patent grant), AGPL-3.0 (companies avoid it) |
| Hosted app (after validation only) | Cloudflare Workers + D1 | €0 (Free: 100,000 requests/day) | about $5/month (Workers Paid) | — |
| Billing (after validation only) | Paddle as merchant of record (5% + $0.50 per transaction; handles EU VAT), then GitHub Marketplace once the app has 100 installations (GitHub keeps 5%, USD only, publisher verification) | €0 until revenue | about €290/month at 100 orgs × €49 | Stripe direct (VAT OSS on us), Lemon Squeezy (signups reported gated, +1.5% international) |
| LLM fixes | Out of MVP; added later with a spend cap | €0 | usage-based | — |

**Open flags.**
- Tax: confirm with the commercialista how subscription sales to EU/non-EU customers fit the current tax regime before enabling payments.
- Name: "drift-ci" is provisional (similar names exist: Driftless, driftctl); `brand-strategist` check before launch.
- Permissive license: anyone may host the core; the paid value must live in the hosted app (dashboard, org-wide rule packs).

## Phase 3 — Architecture (2026-10-26)

Process: one `architect` proposal, red-teamed by a `critic` (verdict: accept with changes, all accepted). Confirmed by the user on 2026-10-26.

**Core principle.** A reference in a head-version doc is flagged only if it resolves in base and resolves to nothing in head. Pre-existing drift, already-fixed docs and things still present elsewhere are never flagged in diff mode.

**Modules** (single npm package `src/core`, `src/cli`, `src/action`; ESLint `no-restricted-imports` bans `node:fs`, `node:child_process`, `@actions/*` from `src/core`; split into workspaces only when the hosted app exists):
- `RepoSnapshot` adapter: `listFiles`, `readFile`, `grep` over a commit via `git ls-tree` / `cat-file --batch` / `git grep <sha>`; never a working tree. A REST-backed implementation later serves the app.
- `ChangeSet` from `git diff -M -z --name-status base head`; directory renames derived (git diff has none); raise `diff.renameLimit` and log when it is hit.
- Fact extractors: path, npm script, Make target, bin. Paths/scripts/targets/bins use a dual inventory (base vs head). Env vars: candidates from removed diff lines, confirmed only if `git grep -w NAME head` finds the name in no non-doc file (no whole-tree env extraction).
- `ReferenceIndexer` (remark-parse + remark-gfm + remark-frontmatter): links/images/definitions, inline code by shape, shell/dotenv fences, plain text only for exact drifted paths with `/` and env names with `_`. Other sources run as shadow rules, recorded by the harness, never reported. Positions: unist lines 1-indexed, columns in UTF-16 code units.
- `Matcher` → `Finding {ruleId, file, line, col, message, suggestion?, fingerprint}` → `Suppressor` → reporters. Versioned JSON finding schema.

**Resolution rules.**
- Paths: candidates in order doc-relative, nearest package root, repo root; flag only if the matched base candidate is gone and no candidate exists in head.
- Scripts keyed by (package, name), matched against the nearest `package.json` or explicit `-w`/`--filter`/`cd` context.
- Make: all `Makefile`, `GNUmakefile`, `*.mk`; multi-target lines split; never run make.
- Removed paths matching head `.gitignore` or common build dirs are suppressed; a submodule gitlink prefix counts as "resolves"; case-only renames follow the labelling rubric.

**Action.**
- Base resolved by the action itself: HEAD with two parents → `^1`; otherwise fetch `pull_request.base.sha` and use the merge-base; fail loudly if neither works. Documented: conflicted PRs get no `pull_request` run.
- Output: one sticky PR comment (hidden marker, permalinks to `head.sha` lines, suggestion), job summary, top 10 annotations per step. Token `contents: read` + `pull-requests: write`. Trigger `pull_request` only.
- Fork PRs: summary + annotations only. No `workflow_run` commenter in the MVP (the artifact-supplied PR number is attacker-controlled).
- `failOn` default `none` (warn only); `warning` opt-in.
- Runtime `node24`; esbuild bundle in committed `dist/`, CI fails if stale; `dist/licenses.txt`; npm publish `--provenance`.

**CLI.** Output `text` (default) and `json`. Scan mode (references unresolved at head; paths, scripts, targets, bins only) ships in the CLI as beta; off in the Action.

**Config.** `.drift-ci.yml` at the root only (name provisional with the product name): `version`, `docs.include/exclude`, `checks`, `ignore`, `failOn`. Default excludes: changelogs, history/release notes, ADRs, archives, migration guides, vendored code. Inline `<!-- drift-ignore-next-line -->` and `drift-ignore-start/end`; historical-context keywords ("renamed from", "formerly", "deprecated", "removed in", "previously") suppress.

**Out of MVP.** Routes, SARIF, `.github/drift-ci.yml`, Go/Rust/Ruby env accessors, fork commenter, tree-sitter, check-run API.

**Validation harness** (in a separate private repo, `drift-ci-validation`, so labels about other people's repos are never public):
- 50 SHA-pinned repos, selection criteria frozen before the first run.
- Gate 1 (≥70%) measured on diff-mode precision only, replaying first-parent commits (commit vs `^1`), not merges; scan mode reported separately. Warnings capped per repo; stratified sample reweighted to the population; per-repo cluster bootstrap CI.
- Labels keyed by fingerprint; flag-correct and suggestion-correct labelled separately; objective secondary label (line later edited/removed in history); blind second labeller on ~50 findings, agreement reported.
- Gate 2 (≥50% fix PRs accepted): one batched PR per repo, only from findings labelled correct, fixed response window, no-response counted separately.
- Harness times each run (monorepo cost not yet measured).

**Testing / CI.** Fixtures `test/fixtures/<case>/{base,head,expected.json}` built into temp 2-commit repos; pure unit tests for indexer/extractors; reporter snapshots; edge cases (delete+add, dir rename, monorepo resolution, CRLF, case, fence without lang, UTF-16 columns). Vitest + v8 coverage. CI on Node 24 (+22 for the CLI): lint, typecheck, tests + coverage, dogfood (`uses: ./`), dist freshness.

**Still unverified.** Official wording on conflicted PRs and `GITHUB_SHA`; reachability of old `refs/pull/N/merge` SHAs (permalinks use `head.sha` anyway); git's built-in `diff.renameLimit` value (unset in config on git 2.43).
