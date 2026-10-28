// Runs the built CLI (dist/cli.js, the file the package ships) in a child process against fixture
// repositories and compares its JSON with the fixtures' expected findings. `npm run build` first:
// a stale dist/ fails here, which is the point.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckResult, ScanResult } from '../src/core/finding.ts';
import { createFixtureRepo, FIXTURES_DIR, type FixtureRepo } from './helpers/fixture-repo.ts';

const execFileAsync = promisify(execFile);
const DIST_CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const built = existsSync(DIST_CLI);
if (!built) console.warn(`cli-dist: ${DIST_CLI} is missing, skipping the built-CLI tests (run \`npm run build\`)`);

interface Expected {
  ruleId: string;
  file: string;
  line: number;
  col: number;
  suggestion?: string;
}

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DIST_CLI, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

const expectedOf = (caseName: string, file: string): Expected[] =>
  JSON.parse(readFileSync(join(FIXTURES_DIR, caseName, file), 'utf8')) as Expected[];

const essence = ({ ruleId, file, line, col, suggestion }: Expected): Expected => ({
  ruleId,
  file,
  line,
  col,
  ...(suggestion === undefined ? {} : { suggestion }),
});

const repos: FixtureRepo[] = [];
afterAll(() => repos.forEach((repo) => repo.cleanup()));
function repoFor(caseName: string): FixtureRepo {
  const repo = createFixtureRepo(caseName);
  repos.push(repo);
  return repo;
}

describe.skipIf(!built)('dist/cli.js', () => {
  it.each(['path-renamed-file', 'script-renamed', 'env-deleted-everywhere'])(
    'check --format json on %s matches expected.json',
    async (caseName) => {
      const repo = repoFor(caseName);
      const { code, stdout, stderr } = await cli(['check', '--format', 'json', '--cwd', repo.dir]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      const result = JSON.parse(stdout) as CheckResult;
      expect(result).toMatchObject({ schemaVersion: 1, mode: 'diff', base: repo.baseSha, head: repo.headSha });
      expect(result.findings.map(essence)).toEqual(expectedOf(caseName, 'expected.json').map(essence));
    },
  );

  it('scan --format json on scan-sample matches expected-scan.json', async () => {
    const repo = repoFor('scan-sample');
    const { code, stdout, stderr } = await cli(['scan', '--format', 'json', '--cwd', repo.dir]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^scan mode \(beta\): /);
    const result = JSON.parse(stdout) as ScanResult;
    expect(result).toMatchObject({ schemaVersion: 1, mode: 'scan', head: repo.headSha });
    expect(result.findings.map(essence)).toEqual(expectedOf('scan-sample', 'expected-scan.json').map(essence));
  });

  it('exits 1 with --fail-on warning when there are findings, text on stdout', async () => {
    const repo = repoFor('path-renamed-file');
    const { code, stdout } = await cli(['--fail-on', 'warning', '--cwd', repo.dir]);
    expect(code).toBe(1);
    expect(stdout).toBe(
      'README.md\n  3:15  `src/old.ts` was renamed to `lib/new.ts` in this change\n    -> lib/new.ts\n\n1 finding in 1 file\n',
    );
  });

  it('exits 2 with a usage message on a bad argument', async () => {
    const { code, stdout, stderr } = await cli(['--nope']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^drift-ci: unknown argument: --nope\n\nUsage:/);
  });

  it('prints help with the beta scan command', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('drift-ci scan [options]   (beta)');
  });
});
