import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/check.ts';
import type { Finding } from '../src/core/finding.ts';
import type { Reference } from '../src/core/reference.ts';
import type { DiffHunk } from '../src/core/rules.ts';
import { envRule, envNamesIn } from '../src/core/rules/env.ts';
import type { RepoSnapshot } from '../src/core/snapshot.ts';
import { changeSet, memorySnapshot } from './helpers/memory-snapshot.ts';

type Files = Record<string, string>;

interface Scenario {
  /** Head files; the docs among them hold the references. */
  head: Files;
  hunks: readonly DiffHunk[];
}

const hunk = (path: string, removed: string[], added: string[] = []): DiffHunk => ({ path, removed, added });

/** A head snapshot that counts grep calls. */
function spied(files: Files): { snapshot: RepoSnapshot; greps: string[] } {
  const inner = memorySnapshot(files);
  const greps: string[] = [];
  return {
    greps,
    snapshot: {
      commit: inner.commit,
      listFiles: () => inner.listFiles(),
      readFile: (path) => inner.readFile(path),
      readFiles: (paths) => inner.readFiles(paths),
      grep: (word, options) => {
        greps.push(word);
        return inner.grep(word, options);
      },
    },
  };
}

async function run(s: Scenario): Promise<{ findings: Finding[]; warnings: string[]; greps: string[] }> {
  const { snapshot, greps } = spied(s.head);
  const result = await runCheck(memorySnapshot({}), snapshot, changeSet(), { rules: [envRule()], hunks: s.hunks });
  return { findings: result.findings, warnings: result.warnings, greps };
}

const brief = (findings: Finding[]): string[] => findings.map((f) => `${f.fact} -> ${f.suggestion ?? 'none'}`);

const README = 'Set `OLD_NAME` before starting.';

describe('envNamesIn: accessor forms', () => {
  it.each([
    ['process.env.OLD_NAME', 'const a = process.env.OLD_NAME;'],
    ['process.env.OLD_NAME', 'const a = process.env?.OLD_NAME ?? 1;'],
    ['OLD_NAME', "const a = process.env['OLD_NAME'];"],
    ['OLD_NAME', 'const a = process.env["OLD_NAME"];'],
    ['OLD_NAME', 'const a = process.env[`OLD_NAME`];'],
    ['OLD_NAME', "const a = process.env?.['OLD_NAME'];"],
    ['OLD_NAME', 'const a = import.meta.env.OLD_NAME;'],
    ['OLD_NAME', "const a = import.meta.env['OLD_NAME'];"],
    ['OLD_NAME', 'a = os.environ["OLD_NAME"]'],
    ['OLD_NAME', "a = os.environ[ 'OLD_NAME' ]"],
    ['OLD_NAME', "a = os.environ.get('OLD_NAME')"],
    ['OLD_NAME', 'a = os.environ.get("OLD_NAME", "x")'],
    ['OLD_NAME', 'a = os.getenv("OLD_NAME")'],
    ['OLD_NAME', 'a = os.getenv("OLD_NAME", default)'],
  ])('reads %s from %j', (name, line) => {
    expect(envNamesIn(line)).toEqual([name.replace('process.env.', '')]);
  });

  it('reads several names from one line, once each', () => {
    expect(envNamesIn('a(process.env.ONE_X, process.env.TWO_X, process.env.ONE_X)')).toEqual(['ONE_X', 'TWO_X']);
  });

  it.each([
    'const env = { A_B: 1 }',
    'const a = env.API_URL',
    'const a = process.env[name]',
    'const a = process.env["not valid"]',
    'const a = process.env["1ABC"]',
    'const a = process.env;',
    'const a = myprocess.env.A_B',
    'a = os.environ.get(name)',
    'a = os.getenv(f"{x}")',
    '// reads OLD_NAME from the environment',
  ])('finds nothing in %j', (line) => {
    expect(envNamesIn(line)).toEqual([]);
  });
});

describe('envNamesIn: dotenv keys', () => {
  it.each([
    ['API_KEY=', ['API_KEY']],
    ['export API_KEY=abc', ['API_KEY']],
    ['  API_KEY = abc', ['API_KEY']],
    ['api_key=abc', ['api_key']],
    ['# API_KEY=abc', []],
    ['', []],
    ['not a key=1', []],
    ['1KEY=1', []],
  ])('reads %j', (line, expected) => {
    expect(envNamesIn(line, true)).toEqual(expected);
  });
});

describe('envRule: what is drift', () => {
  it('flags a name read in removed code and found in no remaining file but docs', async () => {
    const { findings } = await run({
      head: { 'README.md': README, 'src/app.js': 'run();' },
      hunks: [hunk('src/app.js', ['const a = process.env.OLD_NAME;'])],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'env',
      kind: 'env',
      fact: 'env:OLD_NAME',
      file: 'README.md',
      line: 1,
      col: 6,
      message: 'environment variable `OLD_NAME` is no longer read anywhere in the code after this change',
    });
    expect(findings[0]?.suggestion).toBeUndefined();
  });

  it.each([
    ['process.env.OLD_NAME', 'x = process.env.OLD_NAME'],
    ['bracket', "x = process.env['OLD_NAME']"],
    ['import.meta', 'x = import.meta.env.OLD_NAME'],
    ['os.environ[]', 'x = os.environ["OLD_NAME"]'],
    ['os.environ.get', "x = os.environ.get('OLD_NAME')"],
    ['os.getenv', 'x = os.getenv("OLD_NAME", "d")'],
  ])('flags a doc reference when %s was removed', async (_label, line) => {
    const { findings } = await run({
      head: { 'README.md': README },
      hunks: [hunk('src/app.js', [line])],
    });
    expect(brief(findings)).toEqual(['env:OLD_NAME -> none']);
  });

  it('flags the key of a removed `.env.example` line, in every known file name', async () => {
    for (const path of ['.env.example', 'config/.env.sample', '.env.template', '.env.dist', 'example.env']) {
      const { findings } = await run({
        head: { 'README.md': README },
        hunks: [hunk(path, ['# comment', 'OLD_NAME=abc', 'OTHER_KEEP=1'])],
      });
      expect(brief(findings), path).toEqual(['env:OLD_NAME -> none']);
    }
  });

  it('does not read assignments of other files as env names', async () => {
    const { findings, greps } = await run({
      head: { 'README.md': README },
      hunks: [hunk('config.ini', ['OLD_NAME=abc']), hunk('.env', ['OLD_NAME=abc'])],
    });
    expect(findings).toEqual([]);
    expect(greps).toEqual([]);
  });

  it('flags a name that only docs and a fence still mention', async () => {
    const { findings } = await run({
      head: { 'README.md': 'x', 'docs/setup.md': '```dotenv\nOLD_NAME=1\n```\n', 'AGENTS.md': 'see `OLD_NAME`' },
      hunks: [hunk('src/app.js', ['process.env.OLD_NAME'])],
    });
    expect(findings.map((f) => f.file)).toEqual(['AGENTS.md', 'docs/setup.md']);
  });

  it('ignores a doc hit outside the indexed docs when it is Markdown anyway', async () => {
    const { findings } = await run({
      head: { 'README.md': README, 'notes/todo.md': 'OLD_NAME', 'rules/a.mdx': 'OLD_NAME', 'x/y.mdc': 'OLD_NAME' },
      hunks: [hunk('src/app.js', ['process.env.OLD_NAME'])],
    });
    expect(brief(findings)).toEqual(['env:OLD_NAME -> none']);
  });

  it('does not let .cursorrules keep a name alive', async () => {
    const { findings } = await run({
      head: { 'README.md': README, '.cursorrules': 'OLD_NAME' },
      hunks: [hunk('src/app.js', ['process.env.OLD_NAME'])],
    });
    expect(findings.map((f) => f.file)).toEqual(['.cursorrules', 'README.md']);
  });
});

describe('envRule: what is not drift', () => {
  it.each([
    ['a zod/envalid schema', { 'src/env.js': 'export const env = z.object({ OLD_NAME: z.string() })' }],
    ['docker-compose.yml', { 'docker-compose.yml': 'services:\n  app:\n    environment:\n      OLD_NAME: x' }],
    ['a workflow env block', { '.github/workflows/ci.yml': 'env:\n  OLD_NAME: x' }],
    ['code elsewhere', { 'src/other.js': 'use(process.env.OLD_NAME)' }],
    ['a remaining .env.example', { '.env.example': 'OLD_NAME=' }],
    ['a script', { 'run.sh': 'echo "$OLD_NAME"' }],
  ])('keeps the name when %s still has it', async (_label, extra) => {
    const { findings } = await run({
      head: { 'README.md': README, ...extra },
      hunks: [hunk('src/app.js', ['process.env.OLD_NAME'])],
    });
    expect(findings).toEqual([]);
  });

  it('matches whole words only', async () => {
    const { findings } = await run({
      head: { 'README.md': README, 'src/a.js': 'process.env.OLD_NAME_V2' },
      hunks: [hunk('src/app.js', ['process.env.OLD_NAME'])],
    });
    expect(brief(findings)).toEqual(['env:OLD_NAME -> none']);
  });

  it('never checks well-known variables', async () => {
    const { findings, greps } = await run({
      head: { 'README.md': 'x' },
      hunks: [hunk('a.js', ['process.env.NODE_ENV', 'process.env.GITHUB_TOKEN', 'process.env.HOME', 'process.env.npm_x'])],
    });
    expect(findings).toEqual([]);
    expect(greps).toEqual([]);
  });

  it('produces nothing without hunks (scan mode)', async () => {
    const { findings, warnings, greps } = await run({ head: { 'README.md': README }, hunks: [] });
    expect(findings).toEqual([]);
    expect(warnings).toEqual([]);
    expect(greps).toEqual([]);
  });

  it('ignores added lines on their own', async () => {
    const { findings, greps } = await run({
      head: { 'README.md': README },
      hunks: [hunk('src/app.js', [], ['process.env.OLD_NAME'])],
    });
    expect(findings).toEqual([]);
    expect(greps).toEqual([]);
  });

  it('does not flag a doc reference to a name the diff did not touch', async () => {
    const { findings } = await run({
      head: { 'README.md': 'Set `OLD_NAME` and `OTHER_NAME`.' },
      hunks: [hunk('src/app.js', ['process.env.OTHER_NAME'])],
    });
    expect(brief(findings)).toEqual(['env:OTHER_NAME -> none']);
  });

  it('refuses to run check before prepare', () => {
    const ref: Reference = {
      kind: 'env', normalized: 'OLD_NAME', file: 'README.md', line: 1, col: 1,
      source: 'inline-code', contextLine: '`OLD_NAME`', shadow: false,
    };
    expect(() => envRule().check(ref, { path: 'README.md' })).toThrow(/prepare\(\) must run before check\(\)/);
  });
});

describe('envRule: rename suggestions', () => {
  const suggestions = async (hunks: DiffHunk[], doc = README): Promise<string[]> =>
    brief((await run({ head: { 'README.md': doc, 'src/app.js': 'x' }, hunks })).findings);

  it('suggests the added name for exactly one removed and one added name in a hunk', async () => {
    expect(
      await suggestions([hunk('src/app.js', ['a = process.env.OLD_NAME'], ['a = process.env.NEW_NAME'])]),
    ).toEqual(['env:OLD_NAME -> NEW_NAME']);
    const [finding] = (
      await run({
        head: { 'README.md': README },
        hunks: [hunk('src/app.js', ['a = process.env.OLD_NAME'], ['a = process.env.NEW_NAME'])],
      })
    ).findings;
    expect(finding?.message).toBe('environment variable `OLD_NAME` was renamed to `NEW_NAME` in this change');
  });

  it('works across accessor forms and for `.env.example` keys', async () => {
    expect(
      await suggestions([hunk('app.py', ['a = os.environ["OLD_NAME"]'], ["a = os.environ.get('NEW_NAME')"])]),
    ).toEqual(['env:OLD_NAME -> NEW_NAME']);
    expect(await suggestions([hunk('.env.example', ['OLD_NAME='], ['NEW_NAME='])])).toEqual([
      'env:OLD_NAME -> NEW_NAME',
    ]);
  });

  it('gives no suggestion when the hunk removes two names', async () => {
    expect(
      await suggestions(
        [hunk('a.js', ['process.env.OLD_NAME', 'process.env.TWO_NAME'], ['process.env.NEW_NAME'])],
        'Set `OLD_NAME` and `TWO_NAME`.',
      ),
    ).toEqual(['env:OLD_NAME -> none', 'env:TWO_NAME -> none']);
  });

  it('gives no suggestion when the hunk adds two names or none', async () => {
    expect(
      await suggestions([hunk('a.js', ['process.env.OLD_NAME'], ['process.env.NEW_NAME', 'process.env.TWO_NAME'])]),
    ).toEqual(['env:OLD_NAME -> none']);
    expect(await suggestions([hunk('a.js', ['process.env.OLD_NAME'], ['nothing()'])])).toEqual([
      'env:OLD_NAME -> none',
    ]);
  });

  it('gives no suggestion when the added name is the removed one', async () => {
    expect(
      await suggestions([hunk('a.js', ['a = process.env.OLD_NAME'], ['b = process.env.OLD_NAME'])]),
    ).toEqual(['env:OLD_NAME -> none']);
  });

  it('keeps a suggestion that every hunk agrees on', async () => {
    expect(
      await suggestions([
        hunk('a.js', ['process.env.OLD_NAME'], ['process.env.NEW_NAME']),
        hunk('.env.example', ['OLD_NAME='], ['NEW_NAME=']),
      ]),
    ).toEqual(['env:OLD_NAME -> NEW_NAME']);
  });

  it('drops the suggestion when hunks disagree', async () => {
    expect(
      await suggestions([
        hunk('a.js', ['process.env.OLD_NAME'], ['process.env.NEW_NAME']),
        hunk('b.js', ['process.env.OLD_NAME'], ['process.env.OTHER_NAME']),
      ]),
    ).toEqual(['env:OLD_NAME -> none']);
  });

  it('drops the suggestion when another hunk removes the name without a replacement', async () => {
    expect(
      await suggestions([
        hunk('a.js', ['process.env.OLD_NAME'], ['process.env.NEW_NAME']),
        hunk('b.js', ['process.env.OLD_NAME'], []),
      ]),
    ).toEqual(['env:OLD_NAME -> none']);
  });
});

describe('envRule: candidate limit', () => {
  const names = Array.from({ length: 250 }, (_, i) => `VAR_${String(i).padStart(3, '0')}`);

  it('checks only the first 200 sorted candidates and warns', async () => {
    const { greps, warnings, findings } = await run({
      head: { 'README.md': 'Set `VAR_000` and `VAR_199` and `VAR_200` and `VAR_249`.' },
      hunks: [hunk('a.js', names.map((n) => `process.env.${n}`))],
    });
    expect(greps).toHaveLength(200);
    expect([...greps].sort()).toEqual(names.slice(0, 200));
    expect(warnings).toEqual([
      'environment variable check limited to the first 200 of 250 removed names: later ones were not checked',
    ]);
    expect(findings.map((f) => f.fact)).toEqual(['env:VAR_000', 'env:VAR_199']);
  });

  it('does not warn at exactly 200 candidates and counts each name once', async () => {
    const { greps, warnings } = await run({
      head: { 'README.md': 'x' },
      hunks: [hunk('a.js', names.slice(0, 200).map((n) => `process.env.${n}`)), hunk('b.js', ['process.env.VAR_000'])],
    });
    expect(greps).toHaveLength(200);
    expect(warnings).toEqual([]);
  });

  it('does not count well-known names against the limit', async () => {
    const { greps, warnings } = await run({
      head: { 'README.md': 'x' },
      hunks: [hunk('a.js', ['process.env.NODE_ENV', ...names.slice(0, 200).map((n) => `process.env.${n}`)])],
    });
    expect(greps).toHaveLength(200);
    expect(warnings).toEqual([]);
  });
});
