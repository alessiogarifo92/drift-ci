import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/core/finding.ts';
import { VERSION, parseArgs, run, type Io } from '../src/cli/main.ts';
import { reportFailure } from '../src/cli/check.ts';
import { ConfigError } from '../src/core/config.ts';
import { GitError } from '../src/git/errors.ts';
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

  it('reads --fail-on, for check and for the bare invocation', () => {
    expect(parseArgs(['--fail-on', 'warning'], '/repo')).toEqual({
      kind: 'run',
      options: { base: 'HEAD^', head: 'HEAD', cwd: '/repo', format: 'text', failOn: 'warning' },
    });
    expect(parseArgs(['check', '--fail-on', 'none'], '/repo')).toMatchObject({ options: { failOn: 'none' } });
  });

  it('parses scan with its own options and no base', () => {
    expect(parseArgs(['scan'], '/repo')).toEqual({
      kind: 'scan',
      options: { head: 'HEAD', cwd: '/repo', format: 'text' },
    });
    expect(parseArgs(['scan', '--head', 'abc', '--cwd', '/x', '--format', 'json', '--fail-on', 'warning'], '/repo')).toEqual({
      kind: 'scan',
      options: { head: 'abc', cwd: '/x', format: 'json', failOn: 'warning' },
    });
  });

  it.each([['-h'], ['--help'], ['--base', 'x', '--help'], ['check', '--help'], ['scan', '--help'], ['scan', '-h']])('recognises help in %j', (...argv) => {
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
    [['--fail-on'], '--fail-on needs a value'],
    [['--fail-on', 'error'], 'unknown --fail-on value: error (expected none or warning)'],
    [['scan', '--fail-on', 'any'], 'unknown --fail-on value: any (expected none or warning)'],
    [['scan', '--base', 'x'], '--base is not supported by scan (it looks at one commit)'],
    [['scan', '--format', 'xml'], 'unknown format: xml (expected json or text)'],
    [['scan', '--head'], '--head needs a value'],
    [['scan', 'extra'], 'unknown argument: extra'],
    [['scan', 'scan'], 'unknown argument: scan'],
  ])('reports %j as an error', (argv, message) => {
    expect(parseArgs(argv, '/repo')).toEqual({ kind: 'error', message });
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
    expect(parsed).toMatchObject({ schemaVersion: 1, mode: 'diff', base: repo.baseSha, head: repo.headSha, warnings: [] });
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
      'README.md\n  3:15  `src/old.ts` was renamed to `lib/new.ts` in this change\n    -> lib/new.ts\n\n1 finding in 1 file\n',
    );
    expect(check.out).toBe(bare.out);
    expect(bare.err).toBe('');
  });

  it('honours --cwd and explicit refs', async () => {
    const io = capture('/nonexistent');
    expect(await run(['--cwd', repo.dir, '--base', repo.baseSha, '--head', 'main'], io)).toBe(0);
    expect(io.out).toMatch(/1 finding in 1 file\n$/);
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

  it('flags a removed environment variable, from the repository root or from a subdirectory', async () => {
    const envRepo = createFixtureRepo('env-deleted-everywhere');
    try {
      const sub = join(envRepo.dir, 'src', 'deep');
      mkdirSync(sub, { recursive: true });
      const expected = ['README.md:6:1', 'README.md:9:23'];
      for (const cwd of [envRepo.dir, join(envRepo.dir, 'src'), sub]) {
        const io = capture(cwd);
        expect(await run(['--format', 'json'], io), cwd).toBe(0);
        const parsed = JSON.parse(io.out) as CheckResult;
        expect(parsed.findings.map((f) => `${f.file}:${f.line}:${f.col}`), cwd).toEqual(expected);
        expect(parsed.findings.every((f) => f.ruleId === 'env' && f.fact === 'env:API_KEY'), cwd).toBe(true);
        expect(io.err).toBe('');
      }
      // --cwd pointing into a subdirectory behaves the same.
      const viaFlag = capture('/nonexistent');
      expect(await run(['--cwd', sub], viaFlag)).toBe(0);
      expect(viaFlag.out).toMatch(/^README\.md\n {2}6:1 {3}environment variable `API_KEY` is no longer read/);
    } finally {
      envRepo.cleanup();
    }
  });

  it('does not flag a variable that a subdirectory file outside the working directory still uses', async () => {
    // Without resolving the top level, `git grep` would only see the subdirectory and report drift.
    const envRepo = createFixtureRepo('env-still-in-compose');
    try {
      const sub = join(envRepo.dir, 'src');
      const io = capture(sub);
      expect(await run([], io)).toBe(0);
      expect(io.out).toBe('0 findings\n');
    } finally {
      envRepo.cleanup();
    }
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

describe('exit codes', () => {
  const found = createFixtureRepo('path-renamed-file'); // one finding between HEAD^ and HEAD
  const configured = createFixtureRepo('config-ignore'); // .drift-ci.yml: failOn warning, one finding
  afterAll(() => {
    found.cleanup();
    configured.cleanup();
  });

  it('exits 0 with findings when failOn is none (the default)', async () => {
    const io = capture(found.dir);
    expect(await run(['check'], io)).toBe(0);
    expect(io.out).toMatch(/1 finding in 1 file\n$/);
    expect(await run(['check', '--fail-on', 'none'], capture(found.dir))).toBe(0);
  });

  it('exits 1 with --fail-on warning and findings, still printing them', async () => {
    const io = capture(found.dir);
    expect(await run(['check', '--fail-on', 'warning'], io)).toBe(1);
    expect(io.out).toMatch(/1 finding in 1 file\n$/);
    expect(io.err).toBe('');
    expect(await run(['--fail-on', 'warning'], capture(found.dir))).toBe(1);
  });

  it('exits 1 with --fail-on warning and --format json, the document showing the effective failOn', async () => {
    const io = capture(found.dir);
    expect(await run(['--fail-on', 'warning', '--format', 'json'], io)).toBe(1);
    expect((JSON.parse(io.out) as CheckResult).failOn).toBe('warning');
  });

  it('exits 0 with --fail-on warning when there is nothing to report', async () => {
    const io = capture(found.dir);
    expect(await run(['--fail-on', 'warning', '--base', 'HEAD', '--head', 'HEAD'], io)).toBe(0);
    expect(io.out).toBe('0 findings\n');
  });

  it('exits 1 when the config says failOn: warning', async () => {
    expect(await run([], capture(configured.dir))).toBe(1);
  });

  it('lets --fail-on none override a config with failOn: warning', async () => {
    const io = capture(configured.dir);
    expect(await run(['--fail-on', 'none'], io)).toBe(0);
    expect(io.out).toMatch(/1 finding in 1 file\n$/);
  });

  it('exits 2 for a bad argument, an unknown subcommand, a bad ref and an invalid config', async () => {
    const invalid = createFixtureRepo('config-invalid');
    try {
      expect(await run(['--fail-on', 'maybe'], capture(found.dir))).toBe(2);
      expect(await run(['frobnicate'], capture(found.dir))).toBe(2);
      expect(await run(['check', '--base', 'no-such-ref'], capture(found.dir))).toBe(2);
      expect(await run(['scan', '--head', 'no-such-ref'], capture(found.dir))).toBe(2);
      expect(await run(['--fail-on', 'warning'], capture(invalid.dir))).toBe(2);
      expect(await run(['scan', '--fail-on', 'warning'], capture(invalid.dir))).toBe(2);
    } finally {
      invalid.cleanup();
    }
  });

  it('prints nothing on stdout when it exits 2', async () => {
    const io = capture(found.dir);
    expect(await run(['--base', 'no-such-ref', '--fail-on', 'warning'], io)).toBe(2);
    expect(io.out).toBe('');
  });
});

describe('reportFailure', () => {
  it('prints a git failure by its first line and exits 2', () => {
    const io = capture();
    expect(reportFailure(new GitError('git rev-parse failed\nfatal: noise'), io)).toBe(2);
    expect(io.err).toBe('drift-ci: git rev-parse failed\n');
  });

  it('prints a config error and exits 2', () => {
    const io = capture();
    expect(reportFailure(new ConfigError('.drift-ci.yml: bad'), io)).toBe(2);
    expect(io.err).toBe('drift-ci: .drift-ci.yml: bad\n');
  });

  it.each([
    [new TypeError('x is undefined'), 'x is undefined'],
    [new RangeError('Maximum call stack size exceeded'), 'Maximum call stack size exceeded'],
    ['plain string', 'plain string'],
  ])('reports an unexpected error as an internal error and exits 2, not 1 (%#)', (error, text) => {
    const io = capture();
    expect(reportFailure(error, io)).toBe(2);
    expect(io.err).toBe(`drift-ci: internal error: ${text}\n`);
    expect(io.out).toBe('');
  });
});

describe('help', () => {
  it('lists both commands, the beta label, --fail-on and the exit codes', async () => {
    const io = capture();
    expect(await run(['--help'], io)).toBe(0);
    expect(io.out).toContain('drift-ci scan [options]   (beta)');
    expect(io.out).toContain('--fail-on <level>');
    expect(io.out).toContain('Exit codes: 0 ok, 1 findings with failOn warning, 2 usage or runtime error.');
    const scanHelp = capture();
    await run(['scan', '--help'], scanHelp);
    expect(scanHelp.out).toBe(io.out);
  });
});

describe('scan command', () => {
  const repo = createFixtureRepo('scan-sample');
  afterAll(() => repo.cleanup());

  it('starts its stderr with the beta line and prints the findings as text', async () => {
    const io = capture(repo.dir);
    expect(await run(['scan'], io)).toBe(0);
    expect(io.err.startsWith('scan mode (beta): ')).toBe(true);
    expect(io.err).toContain(repo.headSha.slice(0, 7));
    expect(io.out).toBe(
      [
        'README.md',
        '  3:36  npm script `deploy` (package `demo`) does not exist at this commit',
        '  4:37  `src/gone.ts` does not exist at this commit',
        '  6:26  Make target `release` does not exist at this commit',
        '',
        '3 findings in 1 file',
        '',
      ].join('\n'),
    );
  });

  it('prints the scan result as JSON, with mode scan and no base', async () => {
    const io = capture(repo.dir);
    expect(await run(['scan', '--format', 'json'], io)).toBe(0);
    const parsed = JSON.parse(io.out) as Record<string, unknown>;
    expect(parsed).toMatchObject({ schemaVersion: 1, mode: 'scan', head: repo.headSha, warnings: [], failOn: 'none' });
    expect(parsed).not.toHaveProperty('base');
    expect(io.out.startsWith('{\n  "schemaVersion": 1,\n  "mode": "scan",\n')).toBe(true);
    expect(io.err.startsWith('scan mode (beta): ')).toBe(true);
  });

  it('never reports environment variables or bins, although the docs mention them', async () => {
    const io = capture(repo.dir);
    await run(['scan', '--format', 'json'], io);
    const parsed = JSON.parse(io.out) as CheckResult;
    expect(parsed.findings.map((f) => f.ruleId).sort()).toEqual(['make-target', 'npm-script', 'path']);
    expect(io.out).not.toContain('APP_SECRET');
    expect(io.out).not.toContain('drift-ci --help');
  });

  it('exits 1 with --fail-on warning, 0 without, and honours --head', async () => {
    expect(await run(['scan', '--fail-on', 'warning'], capture(repo.dir))).toBe(1);
    expect(await run(['scan', '--fail-on', 'none'], capture(repo.dir))).toBe(0);
    const base = capture(repo.dir);
    // The base commit is an empty tree: nothing to scan, nothing to fail on.
    expect(await run(['scan', '--head', repo.baseSha, '--fail-on', 'warning'], base)).toBe(0);
    expect(base.out).toBe('0 findings\n');
  });

  it('honours --cwd', async () => {
    const io = capture('/nonexistent');
    expect(await run(['scan', '--cwd', repo.dir], io)).toBe(0);
    expect(io.out).toMatch(/3 findings in 1 file\n$/);
  });

  it('exits 2 when the directory is not a git repository', async () => {
    const io = capture(mkdtempSync(join(tmpdir(), 'drift-scan-')));
    try {
      expect(await run(['scan'], io)).toBe(2);
      expect(io.err).toMatch(/^drift-ci: .*\n$/);
      expect(io.out).toBe('');
    } finally {
      rmSync(io.cwd, { recursive: true, force: true });
    }
  });
});

