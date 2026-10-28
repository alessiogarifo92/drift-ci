import { describe, expect, it } from 'vitest';
import { FINDING_SCHEMA_VERSION, fingerprint } from '../src/core/finding.ts';
import * as core from '../src/core/index.ts';

describe('FINDING_SCHEMA_VERSION', () => {
  it('is 1 and re-exported from the core index', () => {
    expect(FINDING_SCHEMA_VERSION).toBe(1);
    expect(core.FINDING_SCHEMA_VERSION).toBe(FINDING_SCHEMA_VERSION);
  });
});

describe('fingerprint', () => {
  const base: [string, string, string, string] = ['path', 'src/old.ts', 'README.md', 'See `src/old.ts` for details.'];

  it('is 16 lowercase hex characters', () => {
    expect(fingerprint(...base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(fingerprint(...base)).toBe(fingerprint(...base));
  });

  it('ignores surrounding and repeated whitespace in the line', () => {
    expect(fingerprint('path', 'src/old.ts', 'README.md', '  See   `src/old.ts`\tfor details.  ')).toBe(
      fingerprint(...base),
    );
  });

  it.each([
    ['rule id', ['npm-script', base[1], base[2], base[3]]],
    ['fact', [base[0], 'src/other.ts', base[2], base[3]]],
    ['file', [base[0], base[1], 'docs/a.md', base[3]]],
    ['line text', [base[0], base[1], base[2], 'Read `src/old.ts` first.']],
  ] satisfies [string, [string, string, string, string]][])('changes with the %s', (_name, args) => {
    expect(fingerprint(...args)).not.toBe(fingerprint(...base));
  });

  it('does not confuse field boundaries', () => {
    expect(fingerprint('a', 'bc', 'd', 'e')).not.toBe(fingerprint('ab', 'c', 'd', 'e'));
  });
});
