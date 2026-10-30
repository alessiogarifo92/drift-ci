import { describe, expect, it } from 'vitest';
import { hasHistoricalContext, splitLines, suppressedLines } from '../src/core/suppress.ts';

const suppressed = (text: string): number[] => [...suppressedLines(splitLines(text))].sort((a, b) => a - b);

describe('splitLines', () => {
  it('normalizes CRLF and CR, and drops a BOM, like the indexer', () => {
    expect(splitLines('\uFEFFa\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('suppressedLines', () => {
  it('suppresses nothing without a directive', () => {
    expect(suppressed('a\nb\nc')).toEqual([]);
    expect(suppressed('')).toEqual([]);
  });

  describe('drift-ignore-next-line', () => {
    it('suppresses the line right after it', () => {
      expect(suppressed('<!-- drift-ignore-next-line -->\n`src/old.ts`\n`src/old.ts`')).toEqual([2]);
    });

    it('skips blank lines to the next non-blank line', () => {
      expect(suppressed('<!-- drift-ignore-next-line -->\n\n   \n`src/old.ts`\nnext')).toEqual([4]);
    });

    it('does not suppress the line holding the comment', () => {
      expect(suppressed('<!-- drift-ignore-next-line -->\nx')).not.toContain(1);
    });

    it('is accepted inside a line with other content', () => {
      expect(suppressed('Intro text <!-- drift-ignore-next-line -->\n`src/old.ts`\nmore')).toEqual([2]);
    });

    it('does nothing at the end of the file', () => {
      expect(suppressed('x\n<!-- drift-ignore-next-line -->\n\n')).toEqual([]);
    });

    it('applies to each of two consecutive comments', () => {
      expect(suppressed('<!-- drift-ignore-next-line -->\na\n<!-- drift-ignore-next-line -->\nb\nc')).toEqual([2, 4]);
    });
  });

  describe('drift-ignore-start / drift-ignore-end', () => {
    it('suppresses the lines strictly between them', () => {
      const text = 'a\n<!-- drift-ignore-start -->\nb\n\nc\n<!-- drift-ignore-end -->\nd';
      expect(suppressed(text)).toEqual([3, 4, 5]);
    });

    it('suppresses until the end of the file when unterminated', () => {
      expect(suppressed('a\n<!-- drift-ignore-start -->\nb\nc')).toEqual([3, 4]);
    });

    it('ignores a stray end comment', () => {
      expect(suppressed('a\n<!-- drift-ignore-end -->\nb')).toEqual([]);
    });

    it('supports several blocks', () => {
      const text = '<!-- drift-ignore-start -->\na\n<!-- drift-ignore-end -->\nb\n<!-- drift-ignore-start -->\nc\n<!-- drift-ignore-end -->';
      expect(suppressed(text)).toEqual([2, 6]);
    });

    it('accepts the comments inside lines with other content', () => {
      expect(suppressed('x <!-- drift-ignore-start --> y\nb\nz <!-- drift-ignore-end --> w\nc')).toEqual([2]);
    });

    it('a next-line comment inside a block changes nothing', () => {
      const text = '<!-- drift-ignore-start -->\n<!-- drift-ignore-next-line -->\nb\nc\n<!-- drift-ignore-end -->\nd';
      expect(suppressed(text)).toEqual([2, 3, 4]);
    });
  });

  it('matches case-insensitively with flexible whitespace', () => {
    expect(suppressed('<!--drift-ignore-next-line-->\na')).toEqual([2]);
    expect(suppressed('<!--   DRIFT-IGNORE-NEXT-LINE\t-->\na')).toEqual([2]);
    expect(suppressed('<!-- Drift-Ignore-Start -->\na\n<!--drift-ignore-END  -->\nb')).toEqual([2]);
  });

  it.each([
    '<!-- drift-ignore -->',
    '<!-- drift-ignore-nextline -->',
    '<!-- drift-ignore-next-line extra -->',
    '<!- drift-ignore-next-line ->',
    'drift-ignore-next-line',
  ])('does not treat %j as a directive', (comment) => {
    expect(suppressed(`${comment}\na`)).toEqual([]);
  });
});

describe('hasHistoricalContext', () => {
  it.each([
    'This was renamed from `old.ts`.',
    'Renamed   from the old name',
    'Formerly `src/old.ts`',
    'The flag is DEPRECATED, use --new',
    '`OLD_VAR` was removed in v2',
    'Previously `make old`',
    'a deprecated: thing',
    '(formerly known as x)',
    'it moved from `src/old.ts` in v2',
    'This MOVED to lib/',
    'renamed to `new.ts`',
    '`scripts/deploy.sh` was removed; use make',
    'these were deleted',
    'it has been renamed',
    'it was renamed',
    'they have been moved away',
    '`a.ts` was replaced by `b.ts`',
    '`a.ts` has been replaced with `b.ts`',
    'there is no longer a `make old`',
    'it used to be `src/old.ts`',
    'the file now lives in lib/',
    'the target is now called build',
    'now named `build`',
    'the helper was named `lib/util/semver.js`',
    'they were called `old-*`',
  ])('is true for %j', (line) => {
    expect(hasHistoricalContext(line)).toBe(true);
  });

  it.each([
    '',
    'Run `src/old.ts`.',
    'The pre-viously split word',
    'undeprecated',
    'deprecations are listed elsewhere',
    'removed',
    'the movement from here to there',
    'nolonger',
    'now live',
    'unused to being',
    'informally',
    'removed inside the loop',
  ])('is false for %j', (line) => {
    expect(hasHistoricalContext(line)).toBe(false);
  });
});
