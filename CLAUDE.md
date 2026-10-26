# Drift CI

Checks every pull request for docs and AI-agent context files (AGENTS.md, CLAUDE.md, .cursorrules, copilot-instructions) that reference things the PR renamed or removed, and flags the exact lines before merge.

Phase-1 decisions: `docs/decisions.md`. Research: Notion page "Ricerca di mercato – Idee di app per lavoro e vita quotidiana (ottobre 2026)", sections 5–6.

## Bootstrap: load the shared skills repo (do this before any work)

This project relies on the private repo `alessiogarifo92/claude-skills` (skills, agents, global rules). A remote session (Claude Code on the web, a cloud container, a GitHub Action) does not have `~/.claude/`, so without this step none of those rules apply.

1. Attach it: `mcp__claude-code-remote__add_repo` with `owner=alessiogarifo92`, `repo=claude-skills` (access `read`), run the clone command it returns, then `register_repo_root`.
2. If the clone already existed (an earlier attach, a container reused), update it first: `git -C <clone> fetch origin main`, then fast-forward (`git -C <clone> merge --ff-only origin/main`, or rebase a working branch). The project's `.claude/session-start-hook.sh` does this on every session start and prints the skills commit and whether it is behind: read that line and act on it. If the project has no `.claude/session-start-hook.sh`, add it and its `.claude/settings.json` entry (copy `<clone>/templates/session-start-hook.sh`; the JSON is in its header) and commit them on the working branch without asking. State the skills commit in your first visible message. Run `bash <clone>/scripts/install.sh` (links every skill into `~/.claude/skills`, agents into `~/.claude/agents`, `CLAUDE.md` into `~/.claude/CLAUDE.md`), then check `ls ~/.claude/skills ~/.claude/agents`. If the running session does not pick the agents up, dispatch `general-purpose` with an explicit `model` and the agent file's body pasted into the brief, plus an instruction to load that agent's frontmatter `skills:` with the Skill tool first and to respect its read-only / no-git limits. If a named skill is still missing from the Skill list, Read `<clone>/<skill>/SKILL.md` directly and follow it. Read the clone's `README.md`.
3. New application or project: invoke `project-lifecycle` first, then `autonomous-workflow` to run its phases unattended. An existing backlog or multi-stage goal: `autonomous-workflow`. A single ticket: `product-ownership`.
   Claude Code detects agent files added to an existing `~/.claude/agents/` without a restart, but not when that directory did not exist at session start (typical in a fresh container). Then either restart the session once, or use the fallback above for this session. `templates/session-start-hook.sh` can install everything before the session starts (best effort).
4. If the attach fails, say so in visible text and ask the user how to proceed. Never continue silently without the rules.

Run / preview (manual gate): none yet (CLI not scaffolded; decided in phase 3).

Repo visibility: public (check: `gh api repos/<owner>/<repo> --jq .private`). Private means finite GitHub Actions minutes: `npm run verify` / `make verify` locally is the push gate, and a CI job that never starts follows `test-verification`'s billing fallback.

Needed environment variables / connectors for this project: none yet.
