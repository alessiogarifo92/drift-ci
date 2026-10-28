// Docs come from the head of a pull request, so their size and shape are attacker-controlled: an oversized doc is
// skipped with a warning, and one nested so deep that the parser gives up must not crash the run.
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/check.ts';
import type { Reference } from '../src/core/reference.ts';
import type { Drift, Rule } from '../src/core/rules.ts';
import { scanSnapshot } from '../src/core/scan.ts';
import { changeSet, memorySnapshot } from './helpers/memory-snapshot.ts';

/** Flags every path reference. */
const everyPath: Rule = {
  id: 'path',
  kinds: ['path'],
  prepare: async () => undefined,
  check: (ref: Reference): Drift => ({ fact: ref.normalized, message: 'drifted' }),
  scan: (ref: Reference): Drift => ({ fact: ref.normalized, message: 'drifted' }),
};

const ok = 'See `src/a.ts`.\n';

async function check(files: Record<string, string>) {
  return runCheck(memorySnapshot({}), memorySnapshot(files), changeSet(), { rules: [everyPath] });
}

describe('docs the run refuses to index', () => {
  it('skips a doc larger than 1 MB, warns, and still checks the other docs', async () => {
    const result = await check({ 'README.md': ok, 'docs/huge.md': `${'x'.repeat(1_000_001)}\n\`src/b.ts\`\n` });
    expect(result.findings.map((f) => f.file)).toEqual(['README.md']);
    expect(result.warnings).toEqual(['docs/huge.md: skipped, larger than 1 MB']);
  });

  it('indexes a doc of exactly 1 MB', async () => {
    const body = `\`src/b.ts\`\n${'x'.repeat(1_000_000 - 11)}`;
    expect(body.length).toBe(1_000_000);
    const result = await check({ 'README.md': body });
    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['blockquote marks glued together', `${'>'.repeat(5000)} \`src/a.ts\`\n`],
    ['blockquote marks with spaces', `${'> '.repeat(5000)}\`src/a.ts\`\n`],
    ['nested lists', `${Array.from({ length: 400 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n')}\n`],
  ])('skips a doc with %s without crashing, and says so', async (_label, doc) => {
    const started = performance.now();
    const result = await check({ 'README.md': ok, 'docs/deep.md': doc });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.findings.map((f) => f.file)).toEqual(['README.md']);
    expect(result.warnings).toEqual(['docs/deep.md: skipped, nesting too deep']);
  });

  it('applies to scan mode as well', async () => {
    const files = { 'README.md': ok, 'docs/deep.md': `${'> '.repeat(5000)}x\n`, 'docs/huge.md': 'y'.repeat(1_000_001) };
    const result = await scanSnapshot(memorySnapshot(files), { rules: [everyPath] });
    expect(result.findings.map((f) => f.file)).toEqual(['README.md']);
    expect(result.warnings).toEqual(['docs/deep.md: skipped, nesting too deep', 'docs/huge.md: skipped, larger than 1 MB']);
  });

  it('still indexes ordinary nesting', async () => {
    const doc = `${'> '.repeat(20)}\`src/a.ts\`\n\n${Array.from({ length: 20 }, (_, i) => `${' '.repeat(i * 2)}- \`src/b${i}.ts\``).join('\n')}\n`;
    const result = await check({ 'README.md': doc });
    expect(result.findings).toHaveLength(21);
    expect(result.warnings).toEqual([]);
  });
});
