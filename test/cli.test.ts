import { afterAll, describe, expect, it } from 'vitest';
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
  it('defaults to HEAD^..HEAD in the current directory', () => {
    expect(parseArgs([], '/repo')).toEqual({
      kind: 'run',
      options: { base: 'HEAD^', head: 'HEAD', cwd: '/repo' },
    });
  });

  it('reads --base, --head and --cwd', () => {
    expect(parseArgs(['--base', 'main', '--head', 'abc123', '--cwd', '/x'], '/repo')).toEqual({
      kind: 'run',
      options: { base: 'main', head: 'abc123', cwd: '/x' },
    });
  });

  it.each([['-h'], ['--help'], ['--base', 'x', '--help']])('recognises help in %j', (...argv) => {
    expect(parseArgs(argv, '/repo')).toEqual({ kind: 'help' });
  });

  it.each([['-v'], ['--version']])('recognises %s', (flag) => {
    expect(parseArgs([flag], '/repo')).toEqual({ kind: 'version' });
  });

  it.each([
    [['--base'], '--base needs a value'],
    [['--head', '--cwd', '/x'], '--head needs a value'],
    [['--frobnicate'], 'unknown argument: --frobnicate'],
    [['stray'], 'unknown argument: stray'],
  ])('reports %j as an error', (argv, message) => {
    expect(parseArgs(argv, '/repo')).toEqual({ kind: 'error', message });
  });
});

describe('run', () => {
  const repo = createFixtureRepo('sample');
  afterAll(() => repo.cleanup());

  it('prints help and exits 0', () => {
    const io = capture();
    expect(run(['--help'], io)).toBe(0);
    expect(io.out).toMatch(/^Usage: drift-ci/);
  });

  it('prints the version and exits 0', () => {
    const io = capture();
    expect(run(['--version'], io)).toBe(0);
    expect(io.out).toBe(`${VERSION}\n`);
  });

  it('exits 2 with usage on a bad argument', () => {
    const io = capture();
    expect(run(['--nope'], io)).toBe(2);
    expect(io.err).toMatch(/^drift-ci: unknown argument: --nope\n\nUsage:/);
    expect(io.out).toBe('');
  });

  it('resolves base and head in a repository', () => {
    const io = capture(repo.dir);
    expect(run([], io)).toBe(0);
    expect(io.out).toContain(`base ${repo.baseSha}\nhead ${repo.headSha}\n`);
    expect(io.out).toContain('0 findings');
    expect(io.err).toBe('');
  });

  it('honours --cwd and explicit refs', () => {
    const io = capture('/nonexistent');
    expect(run(['--cwd', repo.dir, '--base', repo.baseSha, '--head', 'main'], io)).toBe(0);
    expect(io.out).toContain(`base ${repo.baseSha}\nhead ${repo.headSha}\n`);
  });

  it('exits 2 when a ref does not resolve', () => {
    const io = capture(repo.dir);
    expect(run(['--base', 'no-such-ref'], io)).toBe(2);
    expect(io.err).toMatch(/^drift-ci: cannot resolve commits in .*: /);
    expect(io.out).toBe('');
  });

  it('does not treat a ref as an option', () => {
    const io = capture(repo.dir);
    expect(run(['--base', '--output=/tmp/x'], io)).toBe(2);
    expect(io.err).toContain('--base needs a value');
  });
});
