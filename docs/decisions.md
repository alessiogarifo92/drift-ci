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
