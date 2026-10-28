// ChangeSet from `git diff -M -z --name-status <base> <head>`.
import { deriveDirectoryRenames, type ChangeSet, type Rename } from '../core/snapshot.ts';
import { GitError } from './errors.ts';
import { resolveCommit } from './revision.ts';
import { runGit, type GitOptions } from './run.ts';
import { openSnapshot } from './snapshot.ts';

/** Raised for the call (git's built-in default is 1000 and often unset in config). */
export const DEFAULT_RENAME_LIMIT = 100_000;

export interface ChangeSetOptions extends GitOptions {
  /** `diff.renameLimit` for the call; rename detection is skipped above it. Default 100000. */
  renameLimit?: number;
}

type ParsedNameStatus = Pick<ChangeSet, 'renamed' | 'deleted' | 'added' | 'modified'>;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parses `git diff -z --name-status`: `<status> NUL <path> NUL` per change, with
 * a second path for renames and copies (`R087 NUL from NUL to NUL`). Every list is sorted.
 *
 * - `R<nnn>`: rename. `C<nnn>` (only with `-C`, which is not used): the copy counts as added.
 * - `T` (file/symlink/submodule swap) counts as modified.
 */
export function parseNameStatus(output: Buffer): ParsedNameStatus {
  const result: ParsedNameStatus = { renamed: [], deleted: [], added: [], modified: [] };
  const fields = output.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();

  const next = (what: string): string => {
    const field = fields.shift();
    if (field === undefined) throw new GitError(`truncated git diff output: missing ${what}`);
    return field;
  };

  while (fields.length > 0) {
    const status = next('status');
    switch (status[0]) {
      case 'A':
        result.added.push(next('path'));
        break;
      case 'D':
        result.deleted.push(next('path'));
        break;
      case 'M':
      case 'T':
        result.modified.push(next('path'));
        break;
      case 'C':
        next('source path');
        result.added.push(next('path'));
        break;
      case 'R': {
        const similarity = Number(status.slice(1));
        if (!Number.isInteger(similarity)) throw new GitError(`unexpected git diff status: ${status}`);
        const from = next('source path');
        result.renamed.push({ from, to: next('destination path'), similarity });
        break;
      }
      default:
        throw new GitError(`unexpected git diff status: ${JSON.stringify(status)}`);
    }
  }

  result.added.sort(compareStrings);
  result.deleted.sort(compareStrings);
  result.modified.sort(compareStrings);
  result.renamed.sort((a, b) => compareStrings(a.from, b.from));
  return result;
}

/**
 * A warning when git's stderr says rename detection gave up (too many files for
 * `diff.renameLimit`): the affected renames are then reported as delete + add.
 */
export function renameLimitWarning(stderr: string, renameLimit: number): string | undefined {
  if (!/rename detection was skipped/.test(stderr)) return undefined;
  const suggested = /renameLimit variable to at least (\d+)/.exec(stderr)?.[1];
  return (
    `rename detection was skipped (more changed files than diff.renameLimit=${renameLimit} allows): ` +
    'renamed files may be reported as deleted and added' +
    (suggested === undefined ? '' : `; git suggests a limit of at least ${suggested}`)
  );
}

/**
 * What changed between two commits: file renames (>= 50% similar), deletions,
 * additions, in-place modifications and the directory renames implied by the renames.
 *
 * Both revisions are resolved to commits first, so a missing one rejects with
 * `UnknownRevisionError` (in a shallow clone: one beyond the fetched depth).
 */
export async function computeChangeSet(
  repoDir: string,
  base: string,
  head: string,
  options: ChangeSetOptions = {},
): Promise<ChangeSet> {
  const { renameLimit = DEFAULT_RENAME_LIMIT, ...gitOptions } = options;
  if (!Number.isInteger(renameLimit) || renameLimit < 1) {
    throw new RangeError(`renameLimit must be a positive integer, got ${renameLimit}`);
  }

  const baseSha = await resolveCommit(repoDir, base, gitOptions);
  const headSha = await resolveCommit(repoDir, head, gitOptions);

  const { stdout, stderr } = await runGit(
    repoDir,
    [
      '-c', `diff.renameLimit=${renameLimit}`,
      'diff', '-M', '-z', '--name-status', '--no-color', '--no-ext-diff',
      baseSha, headSha,
    ],
    gitOptions,
  );
  const { renamed, deleted, added, modified } = parseNameStatus(stdout);

  const warnings: string[] = [];
  const warning = renameLimitWarning(stderr, renameLimit);
  if (warning !== undefined) warnings.push(warning);

  let renamedDirs: Rename[] = [];
  if (renamed.length > 0) {
    const [baseSnapshot, headSnapshot] = await Promise.all([
      openSnapshot(repoDir, baseSha, gitOptions),
      openSnapshot(repoDir, headSha, gitOptions),
    ]);
    const [baseEntries, headEntries] = await Promise.all([baseSnapshot.listFiles(), headSnapshot.listFiles()]);
    renamedDirs = deriveDirectoryRenames(
      renamed,
      baseEntries.map((e) => e.path),
      headEntries.map((e) => e.path),
    );
  }

  return { renamed, deleted, added, modified, renamedDirs, warnings };
}
