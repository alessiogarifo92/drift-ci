import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/check.ts';
import { fingerprint } from '../src/core/finding.ts';
import { indexMarkdown } from '../src/core/indexer.ts';
import type { Reference } from '../src/core/reference.ts';
import type { CheckContext, Drift, Rule } from '../src/core/rules.ts';
import { changeSet, memorySnapshot } from './helpers/memory-snapshot.ts';

/** Reports every reference of the given kinds whose name is in `drifted`. */
function stubRule(id: string, drifted: readonly string[], kinds: Rule['kinds'] = ['path']): Rule & {
  prepared: CheckContext[];
  seen: Reference[];
} {
  const rule = {
    id,
    kinds,
    prepared: [] as CheckContext[],
    seen: [] as Reference[],
    async prepare(ctx: CheckContext) {
      rule.prepared.push(ctx);
    },
    check(ref: Reference): Drift | undefined {
      rule.seen.push(ref);
      return drifted.includes(ref.normalized)
        ? { fact: ref.normalized, message: `${ref.normalized} drifted` }
        : undefined;
    },
  };
  return rule;
}

const snap = (files: Record<string, string>) => memorySnapshot(files);

describe('runCheck', () => {
  it('hands diff hunks to the rules (empty by default)', async () => {
    const hunks = [{ path: 'src/a.ts', removed: ['process.env.OLD_NAME'], added: [] }];
    const withHunks = stubRule('r', []);
    const without = stubRule('r', []);
    await runCheck(snap({}), snap({}), changeSet(), { rules: [withHunks], hunks });
    await runCheck(snap({}), snap({}), changeSet(), { rules: [without] });
    expect(withHunks.prepared[0]?.hunks).toEqual(hunks);
    expect(without.prepared[0]?.hunks).toEqual([]);
  });

  it('returns the versioned result with both commits', async () => {
    const base = memorySnapshot({}, { commit: 'a'.repeat(40) });
    const head = memorySnapshot({}, { commit: 'b'.repeat(40) });
    const result = await runCheck(base, head, changeSet(), { rules: [] });
    expect(result).toEqual({ schemaVersion: 1, base: 'a'.repeat(40), head: 'b'.repeat(40), findings: [], warnings: [], failOn: 'none' });
  });

  it('prepares each rule once with the listings fetched once', async () => {
    let listed = 0;
    const base = snap({ 'a.md': 'x' });
    const countingHead = { ...snap({ 'README.md': '`src/a.ts`' }) };
    const listFiles = countingHead.listFiles;
    countingHead.listFiles = async () => {
      listed++;
      return listFiles();
    };
    const rule = stubRule('stub', []);
    const changes = changeSet();
    await runCheck(base, countingHead, changes, { rules: [rule] });
    expect(listed).toBe(1);
    expect(rule.prepared).toHaveLength(1);
    const ctx = rule.prepared[0]!;
    expect(ctx.base).toBe(base);
    expect(ctx.head).toBe(countingHead);
    expect(ctx.changes).toBe(changes);
    expect(ctx.baseFiles.map((e) => e.path)).toEqual(['a.md']);
    expect(ctx.headFiles.map((e) => e.path)).toEqual(['README.md']);
  });

  it('builds a finding with fingerprint, kind, fact and optional suggestion', async () => {
    const line = 'Run `src/old.ts` now.';
    const head = snap({ 'README.md': line });
    const rule: Rule = {
      id: 'stub',
      kinds: ['path'],
      prepare: async () => {},
      check: (ref) => ({ fact: ref.normalized, message: 'gone', suggestion: 'src/new.ts' }),
    };
    const { findings } = await runCheck(snap({}), head, changeSet(), { rules: [rule] });
    expect(findings).toEqual([
      {
        ruleId: 'stub',
        kind: 'path',
        fact: 'src/old.ts',
        file: 'README.md',
        line: 1,
        col: 6,
        message: 'gone',
        suggestion: 'src/new.ts',
        fingerprint: fingerprint('stub', 'src/old.ts', 'README.md', line),
      },
    ]);
  });

  it('omits the suggestion key when the rule gives none', async () => {
    const rule = stubRule('stub', ['src/old.ts']);
    const { findings } = await runCheck(snap({}), snap({ 'README.md': '`src/old.ts`' }), changeSet(), { rules: [rule] });
    expect(findings).toHaveLength(1);
    expect('suggestion' in findings[0]!).toBe(false);
  });

  it('ignores shadow references', async () => {
    // Globs are recorded as shadow references by the indexer: measured, never reported.
    const content = 'Glob `src/*.ts` and `src/a.ts`.';
    expect(indexMarkdown('README.md', content).some((r) => r.shadow && r.normalized === 'src/*.ts')).toBe(true);
    const rule = stubRule('stub', ['src/*.ts', 'src/a.ts']);
    const { findings } = await runCheck(snap({}), snap({ 'README.md': content }), changeSet(), { rules: [rule] });
    expect(findings.map((f) => f.fact)).toEqual(['src/a.ts']);
    expect(rule.seen.map((r) => r.normalized)).toEqual(['src/a.ts']);
  });

  it('only reads indexed docs that are regular files', async () => {
    const rule = stubRule('stub', ['src/old.ts']);
    const head = memorySnapshot(
      {
        'README.md': '`src/old.ts`',
        'src/code.ts': '// `src/old.ts`',
        'notes.txt': '`src/old.ts`',
        'docs/guide.md': '`src/old.ts`',
        'docs/linked.md': 'target.md',
      },
      { symlinks: ['docs/linked.md'], submodules: ['docs/sub'] },
    );
    const { findings } = await runCheck(snap({}), head, changeSet(), { rules: [rule] });
    expect(findings.map((f) => f.file)).toEqual(['README.md', 'docs/guide.md']);
  });

  it('honours a custom docFilter', async () => {
    const rule = stubRule('stub', ['src/old.ts']);
    const head = snap({ 'README.md': '`src/old.ts`', 'notes.txt': '`src/old.ts`' });
    const { findings } = await runCheck(snap({}), head, changeSet(), {
      rules: [rule],
      docFilter: (path) => path === 'notes.txt',
    });
    expect(findings.map((f) => f.file)).toEqual(['notes.txt']);
  });

  it('dispatches a reference only to rules that handle its kind', async () => {
    const pathRule = stubRule('p', ['src/old.ts'], ['path']);
    const envRule = stubRule('e', ['src/old.ts'], ['env']);
    const { findings } = await runCheck(snap({}), snap({ 'README.md': '`src/old.ts`' }), changeSet(), {
      rules: [pathRule, envRule],
    });
    expect(findings.map((f) => f.ruleId)).toEqual(['p']);
    expect(envRule.seen).toEqual([]);
  });

  it('passes repo owner and name to the indexer for same-repo URLs', async () => {
    const rule = stubRule('stub', ['/src/a.ts']);
    const head = snap({ 'README.md': '[a](https://github.com/o/n/blob/main/src/a.ts)' });
    const withRepo = await runCheck(snap({}), head, changeSet(), { rules: [rule], repo: { owner: 'o', name: 'n' } });
    expect(withRepo.findings).toHaveLength(1);
    const without = await runCheck(snap({}), head, changeSet(), { rules: [stubRule('stub', ['/src/a.ts'])] });
    expect(without.findings).toEqual([]);
  });

  it('sorts by file, line, column then rule id', async () => {
    const a = stubRule('b-rule', ['x/1.ts', 'x/2.ts']);
    const b = stubRule('a-rule', ['x/1.ts']);
    const head = snap({
      'docs/z.md': '`x/1.ts`',
      'README.md': '`x/2.ts` and `x/1.ts`\n`x/1.ts`',
    });
    const { findings } = await runCheck(snap({}), head, changeSet(), { rules: [a, b] });
    expect(findings.map((f) => `${f.file}:${f.line}:${f.col}:${f.ruleId}`)).toEqual([
      'README.md:1:2:b-rule',
      'README.md:1:15:a-rule',
      'README.md:1:15:b-rule',
      'README.md:2:2:a-rule',
      'README.md:2:2:b-rule',
      'docs/z.md:1:2:a-rule',
      'docs/z.md:1:2:b-rule',
    ]);
  });

  it('dedupes findings with the same rule, position and fact', async () => {
    const dupe: Rule = {
      id: 'stub',
      kinds: ['path'],
      prepare: async () => {},
      check: () => ({ fact: 'src/old.ts', message: 'gone' }),
    };
    const twice: Rule = { ...dupe };
    const { findings } = await runCheck(snap({}), snap({ 'README.md': '`src/old.ts`' }), changeSet(), {
      rules: [dupe, twice],
    });
    expect(findings).toHaveLength(1);
  });

  it('keeps findings that differ only by fact', async () => {
    let n = 0;
    const rule: Rule = {
      id: 'stub',
      kinds: ['path'],
      prepare: async () => {},
      check: () => ({ fact: `f${n++}`, message: 'gone' }),
    };
    const { findings } = await runCheck(snap({}), snap({ 'README.md': '`src/old.ts`' }), changeSet(), {
      rules: [rule, { ...rule }],
    });
    expect(findings.map((f) => f.fact)).toEqual(['f0', 'f1']);
  });

  it('passes change-set warnings and rule warnings through', async () => {
    const rule: Rule = {
      id: 'stub',
      kinds: ['path'],
      prepare: async (ctx) => ctx.warn('stub says hello'),
      check: () => undefined,
    };
    const result = await runCheck(snap({}), snap({}), changeSet({ warnings: ['rename detection was skipped'] }), {
      rules: [rule],
    });
    expect(result.warnings).toEqual(['rename detection was skipped', 'stub says hello']);
  });

  it('does not repeat identical warnings', async () => {
    const rule: Rule = {
      id: 'stub',
      kinds: ['path'],
      prepare: async (ctx) => {
        ctx.warn('same');
        ctx.warn('same');
      },
      check: () => undefined,
    };
    const result = await runCheck(snap({}), snap({}), changeSet({ warnings: ['same'] }), { rules: [rule] });
    expect(result.warnings).toEqual(['same']);
  });
});

describe('defaultRules', () => {
  it('returns fresh rule instances, path rule included', async () => {
    const { defaultRules } = await import('../src/core/rules/index.ts');
    const first = defaultRules();
    expect(first.map((r) => r.id)).toContain('path');
    expect(defaultRules()[0]).not.toBe(first[0]);
  });
});
