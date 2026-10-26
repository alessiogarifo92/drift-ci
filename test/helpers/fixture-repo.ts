// Builds a throwaway two-commit git repository from a fixture directory:
// HEAD^ holds the `base/` tree and HEAD holds the `head/` tree.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Git metadata files cannot be stored under their real names inside this repo's
 * own fixtures (a fixture `.gitignore` would apply to drift-ci itself), so
 * fixtures spell them with a leading underscore and the helper renames them.
 */
const RENAMED_ON_COPY: Readonly<Record<string, string>> = {
  _gitignore: '.gitignore',
  _gitattributes: '.gitattributes',
  _gitmodules: '.gitmodules',
};

export interface FixtureRepo {
  /** Working directory of the temporary repository. */
  dir: string;
  baseSha: string;
  headSha: string;
  /** Runs git in the repository and returns trimmed stdout. */
  git: (...args: string[]) => string;
  cleanup: () => void;
}

// Isolated from the user's and the system's git config, deterministic dates.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Drift Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@drift-ci.invalid',
  GIT_COMMITTER_NAME: 'Drift Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@drift-ci.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function runGit(dir: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

/** Copies `from` into `to` (missing `from` = empty tree), applying RENAMED_ON_COPY. */
function copyTree(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (!statSync(from).isDirectory()) throw new Error(`fixture tree is not a directory: ${from}`);
  cpSync(from, to, { recursive: true });
  renameGitMetadata(to);
}

function renameGitMetadata(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      renameGitMetadata(path);
      continue;
    }
    const target = RENAMED_ON_COPY[entry.name];
    if (target) renameSync(path, join(dir, target));
  }
}

/** Removes everything but `.git` from the working tree. */
function clearWorkingTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name !== '.git') rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Creates the repository for `test/fixtures/<caseName>/{base,head}`, or for any
 * directory holding `base/` and `head/` when given an absolute path.
 * A missing `base/` or `head/` stands for an empty tree.
 */
export function createFixtureRepo(caseName: string, options: { parentDir?: string } = {}): FixtureRepo {
  const caseDir = resolve(FIXTURES_DIR, caseName);
  if (!existsSync(join(caseDir, 'base')) && !existsSync(join(caseDir, 'head'))) {
    throw new Error(`fixture not found (needs base/ or head/): ${caseDir}`);
  }

  const dir = mkdtempSync(join(options.parentDir ?? tmpdir(), `drift-${basename(caseDir)}-`));
  const git = (...args: string[]) => runGit(dir, args);
  try {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'core.autocrlf', 'false');
    git('config', 'commit.gpgsign', 'false');

    copyTree(join(caseDir, 'base'), dir);
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'base');

    clearWorkingTree(dir);
    copyTree(join(caseDir, 'head'), dir);
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'head');

    return {
      dir,
      baseSha: git('rev-parse', 'HEAD^'),
      headSha: git('rev-parse', 'HEAD'),
      git,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
