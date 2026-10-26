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
