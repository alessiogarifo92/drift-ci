import { describe, expect, it } from 'vitest';
import { MAX_ANNOTATIONS, emitAnnotations } from '../src/action/annotations.ts';
import { fakeCore, finding } from './helpers/action-fakes.ts';

describe('emitAnnotations', () => {
  it('emits one warning per finding, on its file, line and column', () => {
    const core = fakeCore();
    emitAnnotations(core, [finding()]);
    expect(core.annotations).toEqual([
      {
        level: 'warning',
        message: 'path `src/old.ts` was renamed to `lib/new.ts` in this change (suggestion: lib/new.ts)',
        properties: { title: 'drift-ci', file: 'README.md', startLine: 3, startColumn: 15 },
      },
    ]);
  });

  it('leaves the suggestion out when there is none', () => {
    const core = fakeCore();
    emitAnnotations(core, [finding({ suggestion: null })]);
    expect(core.annotations[0]?.message).toBe('path `src/old.ts` was renamed to `lib/new.ts` in this change');
  });

  it('caps the annotations at 10 and points to the job summary for the rest', () => {
    const core = fakeCore();
    const findings = Array.from({ length: 14 }, (_, i) => finding({ line: i + 1 }));
    emitAnnotations(core, findings);
    expect(MAX_ANNOTATIONS).toBe(10);
    expect(core.annotations.filter((a) => a.level === 'warning')).toHaveLength(10);
    expect(core.annotations.filter((a) => a.level === 'warning').map((a) => a.properties?.startLine)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(core.annotations.at(-1)).toEqual({
      level: 'notice',
      message: '4 more findings in the job summary',
      properties: undefined,
    });
    expect(core.annotations).toHaveLength(11);
  });

  it('adds no notice at exactly 10, and a singular one at 11', () => {
    const exactly = fakeCore();
    emitAnnotations(exactly, Array.from({ length: 10 }, (_, i) => finding({ line: i + 1 })));
    expect(exactly.annotations.some((a) => a.level === 'notice')).toBe(false);

    const eleven = fakeCore();
    emitAnnotations(eleven, Array.from({ length: 11 }, (_, i) => finding({ line: i + 1 })));
    expect(eleven.annotations.at(-1)?.message).toBe('1 more finding in the job summary');
  });

  it('emits nothing for no findings', () => {
    const core = fakeCore();
    emitAnnotations(core, []);
    expect(core.annotations).toEqual([]);
  });
});
