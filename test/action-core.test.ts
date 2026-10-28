import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionCore } from '../src/action/core.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

function summaryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drift-summary-'));
  dirs.push(dir);
  const path = join(dir, 'summary.md');
  writeFileSync(path, '');
  vi.stubEnv('GITHUB_STEP_SUMMARY', path);
  return path;
}

describe('createActionCore', () => {
  it('reads inputs from INPUT_* variables', () => {
    vi.stubEnv('INPUT_FAIL-ON', ' warning ');
    expect(createActionCore().getInput('fail-on')).toBe('warning');
    expect(createActionCore().getInput('comment')).toBe('');
  });

  it('appends the Markdown to the job summary file', async () => {
    const path = summaryFile();
    await createActionCore().writeSummary('### Drift CI\n');
    expect(readFileSync(path, 'utf8')).toBe('### Drift CI\n\n');
  });

  it('emits workflow commands for annotations and failures', () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const core = createActionCore();
    core.info('hello');
    core.warning('moved', { title: 'drift-ci', file: 'README.md', startLine: 3, startColumn: 15 });
    core.notice('2 more findings in the job summary');
    core.setFailed('nope');
    const text = out.join('');
    expect(text).toContain('hello');
    expect(text).toContain('::warning title=drift-ci,file=README.md,line=3,col=15::moved');
    expect(text).toContain('::notice::2 more findings in the job summary');
    expect(text).toContain('::error::nope');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
