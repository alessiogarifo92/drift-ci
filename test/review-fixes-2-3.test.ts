// Regression tests for the review of tickets #2 and #3.
import { describe, expect, it } from 'vitest';
import { deriveDirectoryRenames } from '../src/core/snapshot.ts';
import { brief, index } from './indexer-support.ts';
import { indexMarkdown } from '../src/core/indexer.ts';

const repo = { owner: 'o', name: 'r' };
const withRepo = (src: string, defaultBranch?: string) =>
  brief(indexMarkdown('README.md', src, { repo: defaultBranch ? { ...repo, defaultBranch } : repo }));

describe('same-repo GitHub links pinned to a ref', () => {
  it.each([
    ['https://github.com/o/r/blob/3f2a9c1d0e8b9c/src/old.ts#L10', '~path:/src/old.ts'],
    ['https://github.com/o/r/blob/v1.2.0/docs/setup.md', '~path:/docs/setup.md'],
    ['https://github.com/o/r/blob/develop/docs/setup.md', '~path:/docs/setup.md'],
    ['https://github.com/o/r/blob/main/docs/setup.md', 'path:/docs/setup.md'],
    ['https://github.com/o/r/blob/master/docs/setup.md', 'path:/docs/setup.md'],
    ['https://github.com/o/r/tree/HEAD/docs/', 'path:/docs/'],
  ])('%s', (url, expected) => {
    expect(withRepo(`[x](${url})`)[0]).toMatch(new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@`));
  });

  it('treats the configured default branch as live', () => {
    expect(withRepo('[x](https://github.com/o/r/blob/develop/a.md)', 'develop')[0]).toMatch(/^path:\/a\.md@/);
  });
});

describe('absolute filesystem paths outside links are shadow', () => {
  it.each([
    ['The image reads /etc/nginx/nginx.conf', '~path:/etc/nginx/nginx.conf@1:17/text'],
    ['`/usr/local/bin/tool.sh`', '~path:/usr/local/bin/tool.sh@1:2/inline-code'],
    ['[root link](/docs/a.md)', 'path:/docs/a.md@1:13/link'],
  ])('%s', (src, expected) => {
    expect(brief(index(src))).toEqual([expected]);
  });
});

describe('link columns', () => {
  it('skips a title that repeats the URL', () => {
    expect(brief(index('[x](a.md "a.md")'))).toEqual(['path:a.md@1:5/link']);
  });
  it('points at the raw URL when it holds a markdown escape', () => {
    expect(brief(index('[x](a\\_b.md)'))).toEqual(['path:a_b.md@1:5/link']);
  });
});

describe('shell scanning', () => {
  const fence = (...lines: string[]) => ['```sh', ...lines, '```'].join('\n');
  const scripts = (src: string) =>
    index(src).filter((r) => r.kind === 'npm-script' || r.kind === 'make-target').map((r) => [r.normalized, r.context?.cwd]);

  it('lands at the repo root after git clone + cd into the clone', () => {
    expect(scripts(fence('git clone https://github.com/o/r.git', 'cd r', 'npm run build'))).toEqual([['build', undefined]]);
    expect(scripts(fence('git clone https://github.com/o/r.git && cd r && make build'))).toEqual([['build', undefined]]);
    expect(scripts(fence('git clone git@github.com:o/r.git my-r', 'cd my-r', 'npm test'))).toEqual([['test', undefined]]);
  });

  it('still tracks a cd into a subdirectory after a clone', () => {
    expect(scripts(fence('git clone https://github.com/o/r.git', 'cd r', 'cd packages/web', 'npm run dev'))).toEqual([
      ['dev', 'packages/web'],
    ]);
  });

  it('normalizes relative cds and marks dynamic ones', () => {
    expect(scripts(fence('cd packages/web', 'cd ../..', 'npm run a'))).toEqual([['a', undefined]]);
    expect(scripts(fence('cd packages/$PKG', 'npm run b'))).toEqual([['b', '$packages/$PKG']]);
    expect(scripts(fence('cd $(git rev-parse --show-toplevel)', 'npm run c'))[0]?.[1]).toMatch(/^\$/);
    expect(scripts(fence('cd /opt/app', 'npm run d'))).toEqual([['d', '/opt/app']]);
  });

  it('reads commands after shell keywords', () => {
    expect(scripts(fence('if [ -f .env ]; then npm run migrate; fi'))).toEqual([['migrate', undefined]]);
    expect(scripts(fence('for p in a b; do make lint; done'))).toEqual([['lint', undefined]]);
  });

  it('understands npm -C as a directory flag', () => {
    expect(scripts(fence('npm -C packages/web run dev'))).toEqual([['dev', 'packages/web']]);
  });

  it('keeps upper-case $NAME in inline code and shadows lower-case ones', () => {
    expect(brief(index('`$API_URL` and `$schema`'))).toEqual(['env:API_URL@1:2/inline-code', '~env:schema@1:17/inline-code']);
  });
});

describe('linear-time scanning of hostile input', () => {
  it('trims long punctuation runs and long backslash runs quickly', () => {
    const started = Date.now();
    index(`see ${')'.repeat(40_000)}a`);
    index(fence(`${'\\'.repeat(40_000)}a`));
    expect(Date.now() - started).toBeLessThan(1_500);
  });
  function fence(line: string) {
    return ['```sh', line, '```'].join('\n');
  }
});

describe('deriveDirectoryRenames with the head listing', () => {
  it('drops a directory that still has files in head', () => {
    const renames = [
      { from: 'docs/a.md', to: 'guides/a.md', similarity: 100 },
      { from: 'docs/b.md', to: 'guides/b.md', similarity: 100 },
    ];
    const base = ['docs/a.md', 'docs/b.md'];
    expect(deriveDirectoryRenames(renames, base)).toEqual([{ from: 'docs', to: 'guides', similarity: 100 }]);
    expect(deriveDirectoryRenames(renames, base, ['guides/a.md', 'guides/b.md', 'docs/c.md'])).toEqual([]);
  });

  it('drops a move into its own subdirectory', () => {
    const renames = [{ from: 'src/f.ts', to: 'src/lib/f.ts', similarity: 100 }];
    expect(deriveDirectoryRenames(renames, ['src/f.ts'], ['src/lib/f.ts'])).toEqual([]);
  });
});

describe('git grep ignores the user config', () => {
  it('returns clean text with grep.column=true set', async () => {
    const { createFixtureRepo } = await import('./helpers/fixture-repo.ts');
    const { openSnapshot } = await import('../src/git/snapshot.ts');
    const repo = createFixtureRepo('grep');
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'grep.column', GIT_CONFIG_VALUE_0: 'true' });
      const hits = await (await openSnapshot(repo.dir, 'HEAD')).grep('FOO_BAR');
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.text).not.toContain('\0');
    } finally {
      for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[key];
      Object.assign(process.env, saved);
      repo.cleanup();
    }
  });
});
