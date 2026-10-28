import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/check.ts';
import type { CheckResult } from '../src/core/finding.ts';
import { defaultRules } from '../src/core/rules/index.ts';
import { computeChangeSet } from '../src/git/changeset.ts';
import { computeHunks } from '../src/git/hunks.ts';
import { openSnapshot } from '../src/git/snapshot.ts';
import { createFixtureRepo, FIXTURES_DIR, type FixtureRepo } from './helpers/fixture-repo.ts';
import { commitWithIndexEntry } from './helpers/git-extras.ts';

interface Expected {
  ruleId: string;
  file: string;
  line: number;
  col: number;
  suggestion?: string;
}

async function check(repo: FixtureRepo, base: string, head: string): Promise<CheckResult> {
  const [baseSnap, headSnap, changes, hunks] = await Promise.all([
    openSnapshot(repo.dir, base),
    openSnapshot(repo.dir, head),
    computeChangeSet(repo.dir, base, head),
    computeHunks(repo.dir, base, head),
  ]);
  return runCheck(baseSnap, headSnap, changes, { rules: defaultRules(), hunks });
}

const repos: FixtureRepo[] = [];
afterAll(() => repos.forEach((repo) => repo.cleanup()));
function repoFor(caseName: string): FixtureRepo {
  const repo = createFixtureRepo(caseName);
  repos.push(repo);
  return repo;
}

const cases = readdirSync(FIXTURES_DIR)
  .filter((name) => existsSync(join(FIXTURES_DIR, name, 'expected.json')))
  .sort();

describe('default rules on fixture repositories', () => {
  it('has fixtures for every acceptance case', () => {
    expect(cases).toEqual(
      expect.arrayContaining([
        'path-renamed-file',
        'path-deleted-file',
        'path-preexisting-broken',
        'path-doc-updated',
        'path-gitignored-build',
        'path-monorepo',
        'path-case-rename',
        'env-deleted-everywhere',
        'env-moved-to-schema',
        'env-still-in-compose',
        'env-still-in-workflow',
        'env-renamed',
        'script-renamed',
        'script-workspace-removed',
        'script-invalid-package-json',
        'make-target-moved',
        'make-multi-target',
        'bin-renamed',
      ]),
    );
  });

  it.each(cases)('%s matches expected.json', async (name) => {
    const expected = JSON.parse(readFileSync(join(FIXTURES_DIR, name, 'expected.json'), 'utf8')) as Expected[];
    const repo = repoFor(name);
    const result = await check(repo, repo.baseSha, repo.headSha);
    const actual = result.findings.map(({ ruleId, file, line, col, suggestion }) => ({
      ruleId,
      file,
      line,
      col,
      ...(suggestion === undefined ? {} : { suggestion }),
    }));
    expect(actual).toEqual(expected);
    // Optional `expected-warnings.json`: one substring per warning (parser messages vary by Node version).
    const warningsFile = join(FIXTURES_DIR, name, 'expected-warnings.json');
    const expectedWarnings = existsSync(warningsFile) ? (JSON.parse(readFileSync(warningsFile, 'utf8')) as string[]) : [];
    expect(result.warnings).toEqual(expectedWarnings.map((text) => expect.stringContaining(text)));
    expect(result.base).toBe(repo.baseSha);
    expect(result.head).toBe(repo.headSha);
  });
});

describe('path rule and submodules', () => {
  // base = README only; with = base + a gitlink at vendor/lib.
  const setup = () => {
    const repo = repoFor('path-submodule');
    const withSubmodule = commitWithIndexEntry(repo, { mode: '160000', oid: repo.headSha, path: 'vendor/lib' });
    return { repo, withSubmodule };
  };

  it('treats a path under a gitlink as resolving on both sides', async () => {
    const { repo, withSubmodule } = setup();
    // Same README, gitlink kept: nothing resolves differently.
    const next = (() => {
      repo.git('commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'touch');
      return repo.git('rev-parse', 'HEAD');
    })();
    expect((await check(repo, withSubmodule, next)).findings).toEqual([]);
  });

  it('flags a path under a gitlink when the submodule is removed', async () => {
    const { repo, withSubmodule } = setup();
    const result = await check(repo, withSubmodule, repo.headSha);
    expect(result.findings.map((f) => [f.fact, f.message])).toEqual([
      ['vendor/lib/src/a.c', '`vendor/lib/src/a.c` was removed in this change'],
    ]);
  });

  it('does not flag a path that only exists once the submodule is added', async () => {
    const { repo, withSubmodule } = setup();
    expect((await check(repo, repo.headSha, withSubmodule)).findings).toEqual([]);
  });
});
