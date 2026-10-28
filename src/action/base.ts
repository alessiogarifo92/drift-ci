// Which commits to compare. On `pull_request` the checkout is the merge commit refs/pull/N/merge,
// whose first parent is the base branch: that is the base to diff against. A checkout of the PR
// head (`ref: ${{ github.event.pull_request.head.sha }}`) has no such commit, so the base branch
// tip is fetched and the merge-base with HEAD is used.
import { runGit } from '../git/run.ts';
import { ActionError, errorMessage } from './errors.ts';

/** Runs `git <args>` in the checkout and returns trimmed stdout; rejects when git fails. */
export type GitRunner = (args: readonly string[]) => Promise<string>;

export function createGitRunner(dir: string): GitRunner {
  return async (args) => (await runGit(dir, args)).stdout.toString('utf8').trim();
}

export interface ResolvedBase {
  base: string;
  head: string;
}

const DEEPEN_BY = 100;

/**
 * The commits to check: `head` is HEAD, `base` the merge commit's first parent or the merge-base
 * with `baseSha`. Throws ActionError when neither can be found.
 *
 * On a merge checkout the docs checked are those of the merge commit (what would land), while
 * permalinks point at `pull_request.head.sha`: a line can differ between the two only when the
 * base branch edited the same doc.
 */
export async function resolveBase(
  git: GitRunner,
  { headSha, baseSha }: { headSha: string; baseSha: string },
): Promise<ResolvedBase> {
  const [head, ...parents] = (await git(['rev-list', '--parents', '-n1', 'HEAD'])).split(/\s+/).filter(Boolean);
  if (!head) throw new ActionError('cannot read HEAD: is the repository checked out?');

  // A PR head that is itself a merge commit (the branch merged main) also has two parents, but
  // its first parent is not the base branch: only a commit other than head.sha is the merge ref.
  const [firstParent] = parents;
  if (parents.length === 2 && firstParent && head !== headSha) return { base: firstParent, head };

  try {
    await git(['fetch', '--no-tags', 'origin', baseSha]);
  } catch (error) {
    throw new ActionError(
      `could not fetch the base commit ${baseSha.slice(0, 7)} from origin: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let base = await mergeBase(git, baseSha);
  if (!base) {
    // A shallow checkout may stop short of the common ancestor; a complete one refuses to deepen.
    // Both tips are named: recent git deepens only the history of the refs being fetched, so
    // deepening the base alone leaves HEAD's shallow boundary where it was.
    await git(['fetch', '--no-tags', `--deepen=${DEEPEN_BY}`, 'origin', baseSha, head]).catch(() => undefined);
    base = await mergeBase(git, baseSha);
  }
  if (!base) {
    throw new ActionError(
      `no common ancestor found between the base commit ${baseSha} and HEAD, even after fetching more history. ` +
        'Check out the PR with `fetch-depth: 0`, or keep the default merge checkout of actions/checkout (no `ref:`).',
    );
  }
  return { base, head };
}

async function mergeBase(git: GitRunner, baseSha: string): Promise<string | undefined> {
  try {
    return (await git(['merge-base', baseSha, 'HEAD'])).trim() || undefined;
  } catch {
    return undefined;
  }
}
