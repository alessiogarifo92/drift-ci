import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatText, formatWarnings } from '../src/cli/check.ts';
import type { CheckResult } from '../src/core/finding.ts';
import { VERSION, parseArgs, run, type Io } from '../src/cli/main.ts';
import { createFixtureRepo } from './helpers/fixture-repo.ts';

function capture(cwd = '/nonexistent'): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    cwd,
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

describe('parseArgs', () => {
  it('defaults to HEAD^..HEAD in the current directory, as text', () => {
    expect(parseArgs([], '/repo')).toEqual({
      kind: 'run',
      options: { base: 'HEAD^', head: 'HEAD', cwd: '/repo', format: 'text' },
    });
  });

  it('reads --base, --head, --cwd and --format', () => {
    expect(parseArgs(['--base', 'main', '--head', 'abc123', '--cwd', '/x', '--format', 'json'], '/repo')).toEqual({
      kind: 'run',
      options: { base: 'main', head: 'abc123', cwd: '/x', format: 'json' },
    });
  });

  it('accepts the check subcommand and treats it like the bare invocation', () => {
    expect(parseArgs(['check'], '/repo')).toEqual(parseArgs([], '/repo'));
    expect(parseArgs(['check', '--base', 'a', '--format', 'json'], '/repo')).toEqual(
      parseArgs(['--base', 'a', '--format', 'json'], '/repo'),
    );
  });

  it.each([['-h'], ['--help'], ['--base', 'x', '--help'], ['check', '--help']])('recognises help in %j', (...argv) => {
    expect(parseArgs(argv, '/repo')).toEqual({ kind: 'help' });
  });

  it.each([['-v'], ['--version']])('recognises %s', (flag) => {
    expect(parseArgs([flag], '/repo')).toEqual({ kind: 'version' });
  });

  it.each([
    [['--base'], '--base needs a value'],
    [['--head', '--cwd', '/x'], '--head needs a value'],
    [['--format'], '--format needs a value'],
    [['--format', 'yaml'], 'unknown format: yaml (expected json or text)'],
    [['--frobnicate'], 'unknown argument: --frobnicate'],
    [['stray'], 'unknown argument: stray'],
    [['check', 'check'], 'unknown argument: check'],
  ])('reports %j as an error', (argv, message) => {
    expect(parseArgs(argv, '/repo')).toEqual({ kind: 'error', message });
  });
});

describe('formatText and formatWarnings', () => {
  const result = (findings: CheckResult['findings'], warnings: string[] = []): CheckResult => ({
    schemaVersion: 1,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    findings,
    warnings,
  });
  const finding = (over: Partial<CheckResult['findings'][number]> = {}): CheckResult['findings'][number] => ({
    ruleId: 'path',
    kind: 'path',
    fact: 'src/old.ts',
    file: 'README.md',
    line: 3,
    col: 15,
    message: '`src/old.ts` was removed in this change',
    fingerprint: '0123456789abcdef',
    ...over,
  });

  it('prints one line per finding, the suggestion and a count', () => {
    const text = formatText(
      result([
        finding({ suggestion: 'lib/new.ts', message: '`src/old.ts` was renamed to `lib/new.ts` in this change' }),
        finding({ file: 'docs/a.md', line: 10, col: 2 }),
      ]),
    );
    expect(text).toBe(
      [
        'README.md:3:15  `src/old.ts` was renamed to `lib/new.ts` in this change',
        '  suggestion: lib/new.ts',
        'docs/a.md:10:2  `src/old.ts` was removed in this change',
        '2 findings',
        '',
      ].join('\n'),
    );
  });

  it('counts singular and zero', () => {
    expect(formatText(result([finding()]))).toMatch(/\n1 finding\n$/);
    expect(formatText(result([]))).toBe('0 findings\n');
  });

  it('prefixes warnings', () => {
    expect(formatWarnings(result([], ['one', 'two']))).toBe('warning: one\nwarning: two\n');
    expect(formatWarnings(result([]))).toBe('');
  });
});

describe('run', () => {
  const repo = createFixtureRepo('path-renamed-file');
  const githubRepo = createFixtureRepo('cli-github-url');
  githubRepo.git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  const emptyDir = mkdtempSync(join(tmpdir(), 'drift-cli-'));
  afterAll(() => {
    repo.cleanup();
    githubRepo.cleanup();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('prints help and exits 0', async () => {
    const io = capture();
    expect(await run(['--help'], io)).toBe(0);
    expect(io.out).toMatch(/^Usage: drift-ci/);
    expect(io.out).toContain('--format');
  });

  it('prints the version and exits 0', async () => {
    const io = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(io.out).toBe(`${VERSION}\n`);
  });

  it('exits 2 with usage on a bad argument', async () => {
    const io = capture();
    expect(await run(['--nope'], io)).toBe(2);
    expect(io.err).toMatch(/^drift-ci: unknown argument: --nope\n\nUsage:/);
    expect(io.out).toBe('');
  });

  it('exits 2 on an unknown format', async () => {
    const io = capture(repo.dir);
    expect(await run(['check', '--format', 'xml'], io)).toBe(2);
    expect(io.err).toMatch(/^drift-ci: unknown format: xml \(expected json or text\)/);
    expect(io.out).toBe('');
  });

  it('prints the result as JSON with --format json', async () => {
    const io = capture(repo.dir);
    expect(await run(['check', '--base', repo.baseSha, '--head', repo.headSha, '--format', 'json'], io)).toBe(0);
    expect(io.out.startsWith('{\n  "schemaVersion": 1,\n')).toBe(true);
    expect(io.out.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(io.out) as CheckResult;
    expect(parsed).toMatchObject({ schemaVersion: 1, base: repo.baseSha, head: repo.headSha, warnings: [] });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      ruleId: 'path',
      kind: 'path',
      fact: 'src/old.ts',
      file: 'README.md',
      line: 3,
      col: 15,
      message: '`src/old.ts` was renamed to `lib/new.ts` in this change',
      suggestion: 'lib/new.ts',
    });
    expect(parsed.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(io.err).toBe('');
  });

  it('prints text by default and behaves the same with or without the check subcommand', async () => {
    const bare = capture(repo.dir);
    const check = capture(repo.dir);
    expect(await run([], bare)).toBe(0);
    expect(await run(['check'], check)).toBe(0);
    expect(bare.out).toBe(
      'README.md:3:15  `src/old.ts` was renamed to `lib/new.ts` in this change\n  suggestion: lib/new.ts\n1 finding\n',
    );
    expect(check.out).toBe(bare.out);
    expect(bare.err).toBe('');
  });

  it('honours --cwd and explicit refs', async () => {
    const io = capture('/nonexistent');
    expect(await run(['--cwd', repo.dir, '--base', repo.baseSha, '--head', 'main'], io)).toBe(0);
    expect(io.out).toMatch(/1 finding\n$/);
  });

  it('finds nothing between identical commits', async () => {
    const io = capture(repo.dir);
    expect(await run(['--base', 'HEAD', '--head', 'HEAD'], io)).toBe(0);
    expect(io.out).toBe('0 findings\n');
  });

  it('reads same-repo GitHub URLs through the origin remote', async () => {
    const io = capture(githubRepo.dir);
    expect(await run(['--format', 'json'], io)).toBe(0);
    const parsed = JSON.parse(io.out) as CheckResult;
    expect(parsed.findings.map((f) => [f.fact, f.suggestion])).toEqual([['src/old.ts', undefined]]);
  });

  it('does not read GitHub URLs as paths without a matching origin', async () => {
    const io = capture();
    const other = createFixtureRepo('cli-github-url');
    try {
      other.git('remote', 'add', 'origin', 'https://example.com/acme/demo.git');
      expect(await run(['--cwd', other.dir], io)).toBe(0);
      expect(io.out).toBe('0 findings\n');
    } finally {
      other.cleanup();
    }
  });

  it('exits 2 with a one-line message when a ref does not resolve', async () => {
    const io = capture(repo.dir);
    expect(await run(['--base', 'no-such-ref'], io)).toBe(2);
    expect(io.err).toBe('drift-ci: unknown revision: no-such-ref\n');
    expect(io.out).toBe('');
  });

  it('exits 2 when the directory is not a git repository', async () => {
    const io = capture(emptyDir);
    expect(await run([], io)).toBe(2);
    expect(io.err).toMatch(/^drift-ci: .*\n$/);
    expect(io.err.trimEnd().split('\n')).toHaveLength(1);
    expect(io.out).toBe('');
  });

  it('exits 2 when the directory does not exist', async () => {
    const io = capture('/nonexistent-drift-ci-dir');
    expect(await run([], io)).toBe(2);
    expect(io.err).toMatch(/^drift-ci: repository directory does not exist/);
  });

  it('does not treat a ref as an option', async () => {
    const io = capture(repo.dir);
    expect(await run(['--base', '--output=/tmp/x'], io)).toBe(2);
    expect(io.err).toContain('--base needs a value');
  });
});
