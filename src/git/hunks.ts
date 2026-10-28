// Diff hunks from `git diff -U0 -M <base> <head>`: the removed and added lines of
// each changed region, which the env rule reads to find names a change stopped using.
import type { DiffHunk } from '../core/rules.ts';
import { DEFAULT_RENAME_LIMIT } from './changeset.ts';
import { resolveCommit } from './revision.ts';
import { runGit, type GitOptions } from './run.ts';

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34,
};

/** A git path as printed in a diff header: C-quoted (`"a/caf\303\251"`) or plain. */
function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const inner = raw.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] as string;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const escaped = SIMPLE_ESCAPES[inner[i + 1] ?? ''];
    if (escaped !== undefined) {
      bytes.push(escaped);
      i++;
    } else {
      bytes.push(92); // unknown escape: keep the backslash
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path of a `--- ` / `+++ ` header line's operand, or `undefined` for `/dev/null`. */
function headerPath(operand: string): string | undefined {
  // git appends a tab to names with spaces so that patch(1) finds where the name ends.
  const raw = operand.replace(/\t.*$/, '');
  const path = unquote(raw);
  if (path === '/dev/null') return undefined;
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

/**
 * Parses the output of `git diff -U0` into one `DiffHunk` per `@@` block. The path is the head
 * path, or the base path of a deleted file. Binary files, pure renames and mode changes have no
 * hunks and so produce nothing. Hunk line counts decide where a hunk ends, so a removed line
 * such as `-- text` (shown as `--- text`) is never mistaken for a file header.
 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  let basePath: string | undefined;
  let headPath: string | undefined;
  let current: { removed: string[]; added: string[] } | undefined;
  let removedLeft = 0;
  let addedLeft = 0;

  for (const line of lines) {
    if (removedLeft > 0 || addedLeft > 0) {
      if (line.startsWith('-') && removedLeft > 0) {
        current?.removed.push(line.slice(1));
        removedLeft--;
        continue;
      }
      if (line.startsWith('+') && addedLeft > 0) {
        current?.added.push(line.slice(1));
        addedLeft--;
        continue;
      }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      removedLeft = 0;
      addedLeft = 0;
    } else if (line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('diff --git ')) {
      basePath = undefined;
      headPath = undefined;
    } else if (line.startsWith('--- ')) {
      basePath = headerPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      headPath = headerPath(line.slice(4));
    } else {
      const header = HUNK_HEADER.exec(line);
      if (header === null) continue;
      const path = headPath ?? basePath;
      if (path === undefined) continue;
      removedLeft = header[1] === undefined ? 1 : Number(header[1]);
      addedLeft = header[2] === undefined ? 1 : Number(header[2]);
      current = { removed: [], added: [] };
      hunks.push({ path, removed: current.removed, added: current.added });
    }
  }
  return hunks;
}

/**
 * Hunks between two commits, with renames followed (a renamed file shows only its edited lines).
 * Both revisions are resolved to commits first, so an unknown one rejects with `UnknownRevisionError`.
 * One git call for the whole diff, however many files changed.
 */
export async function computeHunks(
  repoDir: string,
  base: string,
  head: string,
  options: GitOptions = {},
): Promise<DiffHunk[]> {
  const baseSha = await resolveCommit(repoDir, base, options);
  const headSha = await resolveCommit(repoDir, head, options);
  const { stdout } = await runGit(
    repoDir,
    [
      '-c', `diff.renameLimit=${DEFAULT_RENAME_LIMIT}`,
      'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv',
      '--src-prefix=a/', '--dst-prefix=b/',
      baseSha, headSha,
    ],
    options,
  );
  return parseUnifiedDiff(stdout.toString('utf8'));
}
