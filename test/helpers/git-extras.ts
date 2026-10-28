// Extra history shapes for fixture repos that the base/head helper cannot express.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FixtureRepo } from './fixture-repo.ts';

/**
 * Adds a commit on top of HEAD that also contains one raw index entry, e.g. a
 * submodule gitlink (`160000`, a commit SHA) or a symlink (`120000`, a blob oid).
 * Returns the new commit's SHA. The working tree is not touched.
 */
export function commitWithIndexEntry(
  repo: FixtureRepo,
  entry: { mode: string; oid: string; path: string },
  message = 'add index entry',
): string {
  repo.git('update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${entry.path}`);
  repo.git('commit', '--quiet', '--no-verify', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

/**
 * Rewrites the repository's `main` so that base and head have an older parent
 * (an empty root commit) before them, which is what a `fetch-depth: 2` clone
 * cuts off. Returns the SHAs of the new base, new head and that root commit.
 */
export function withOlderHistory(repo: FixtureRepo): { baseSha: string; headSha: string; rootSha: string } {
  const emptyTree = repo.git('hash-object', '-t', 'tree', '/dev/null');
  const rootSha = repo.git('commit-tree', emptyTree, '-m', 'root');
  const baseSha = repo.git('commit-tree', `${repo.baseSha}^{tree}`, '-p', rootSha, '-m', 'base');
  const headSha = repo.git('commit-tree', `${repo.headSha}^{tree}`, '-p', baseSha, '-m', 'head');
  repo.git('update-ref', 'refs/heads/main', headSha);
  return { baseSha, headSha, rootSha };
}

/** `git clone --depth <depth>` of the repository. `file://` is required for --depth to apply. */
export function shallowClone(repo: FixtureRepo, depth: number): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'drift-shallow-'));
  const dir = join(parent, 'clone');
  try {
    execFileSync('git', ['clone', '--quiet', '--depth', String(depth), pathToFileURL(repo.dir).href, dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}
