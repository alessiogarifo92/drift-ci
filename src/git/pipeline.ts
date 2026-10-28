// The whole diff-mode run against a local repository: git adapters in, CheckResult out.
// Shared by the CLI and the GitHub Action so both report exactly the same findings.
import { runCheck } from '../core/check.ts';
import { loadConfig } from '../core/config.ts';
import type { CheckResult } from '../core/finding.ts';
import { defaultRules } from '../core/rules/index.ts';
import type { RepoIdentity } from '../core/shapes.ts';
import { computeChangeSet } from './changeset.ts';
import { computeHunks } from './hunks.ts';
import { readRepoSlug } from './remote.ts';
import { repositoryRoot } from './revision.ts';
import type { GitOptions } from './run.ts';
import { openSnapshot } from './snapshot.ts';

export interface DiffCheckOptions extends GitOptions {
  /** Overrides the owner/name read from the origin remote (the Action knows it from the event). */
  repo?: RepoIdentity;
}

/**
 * Checks the docs of `head` against what changed since `base`. `dir` may be any directory
 * inside the work tree: every git call runs at its top level, because `git grep` only
 * searches the directory it runs in. Throws GitError (bad ref, not a repository) and
 * ConfigError (invalid `.drift-ci.yml` in head).
 */
export async function runDiffCheck(
  dir: string,
  base: string,
  head: string,
  options: DiffCheckOptions = {},
): Promise<CheckResult> {
  const { repo: repoOverride, ...git } = options;
  const root = await repositoryRoot(dir, git);
  const [baseSnapshot, headSnapshot, changes, hunks, slug] = await Promise.all([
    openSnapshot(root, base, git),
    openSnapshot(root, head, git),
    computeChangeSet(root, base, head, git),
    computeHunks(root, base, head, git),
    repoOverride ? Promise.resolve(undefined) : readRepoSlug(root, git),
  ]);
  const repo = repoOverride ?? slug;
  const config = await loadConfig(headSnapshot);
  return runCheck(baseSnapshot, headSnapshot, changes, {
    rules: defaultRules(),
    hunks,
    config,
    ...(repo ? { repo } : {}),
  });
}
