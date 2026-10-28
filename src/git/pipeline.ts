// The whole run against a local repository, git adapters in, result out: diff mode (CheckResult) and scan
// mode (ScanResult). Shared by the CLI and the GitHub Action so both report exactly the same findings.
import { runCheck } from '../core/check.ts';
import { loadConfig } from '../core/config.ts';
import type { CheckResult, ScanResult } from '../core/finding.ts';
import { defaultRules } from '../core/rules/index.ts';
import { scanSnapshot } from '../core/scan.ts';
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
  /**
   * Which side's `.drift-ci.yml` to apply (default `head`). The Action uses `base`, so a pull request cannot
   * loosen or disable its own check: a config change applies once merged, as GitHub does for CODEOWNERS.
   */
  configFrom?: 'base' | 'head';
}

/**
 * Checks the docs of `head` against what changed since `base`. `dir` may be any directory
 * inside the work tree: every git call runs at its top level, because `git grep` only
 * searches the directory it runs in. Throws GitError (bad ref, not a repository) and
 * ConfigError (invalid `.drift-ci.yml` on the side `configFrom` names).
 */
export async function runDiffCheck(
  dir: string,
  base: string,
  head: string,
  options: DiffCheckOptions = {},
): Promise<CheckResult> {
  const { repo: repoOverride, configFrom = 'head', ...git } = options;
  const root = await repositoryRoot(dir, git);
  const [baseSnapshot, headSnapshot, changes, hunks, slug] = await Promise.all([
    openSnapshot(root, base, git),
    openSnapshot(root, head, git),
    computeChangeSet(root, base, head, git),
    computeHunks(root, base, head, git),
    repoOverride ? Promise.resolve(undefined) : readRepoSlug(root, git),
  ]);
  const repo = repoOverride ?? slug;
  const config = await loadConfig(configFrom === 'base' ? baseSnapshot : headSnapshot);
  return runCheck(baseSnapshot, headSnapshot, changes, {
    rules: defaultRules(),
    hunks,
    config,
    ...(repo ? { repo } : {}),
  });
}

/**
 * Scan mode (beta): the references of the docs of `head` that resolve to nothing at `head`, without a
 * base. Same root resolution, config and repository identity as `runDiffCheck`; throws the same errors.
 */
export async function runScan(dir: string, head: string, options: GitOptions & { repo?: RepoIdentity } = {}): Promise<ScanResult> {
  const { repo: repoOverride, ...git } = options;
  const root = await repositoryRoot(dir, git);
  const [headSnapshot, slug] = await Promise.all([
    openSnapshot(root, head, git),
    repoOverride ? Promise.resolve(undefined) : readRepoSlug(root, git),
  ]);
  const repo = repoOverride ?? slug;
  const config = await loadConfig(headSnapshot);
  return scanSnapshot(headSnapshot, {
    rules: defaultRules(),
    config,
    ...(repo ? { repo } : {}),
  });
}
