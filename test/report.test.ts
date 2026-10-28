import { describe, expect, it } from 'vitest';
import type { CheckResult, Finding, ScanResult } from '../src/core/finding.ts';
import { formatJson, formatText, formatWarnings } from '../src/cli/report.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function finding(over: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'path',
    kind: 'path',
    fact: 'src/old.ts',
    file: 'README.md',
    line: 3,
    col: 15,
    message: '`src/old.ts` was removed in this change',
    fingerprint: '0123456789abcdef',
    ...over,
  };
}

function diffResult(findings: Finding[], warnings: string[] = [], failOn: CheckResult['failOn'] = 'none'): CheckResult {
  return { schemaVersion: 1, mode: 'diff', base: SHA_A, head: SHA_B, findings, warnings, failOn };
}

function scanResult(findings: Finding[], warnings: string[] = []): ScanResult {
  return { schemaVersion: 1, mode: 'scan', head: SHA_B, findings, warnings, failOn: 'none' };
}

const renamed = finding({
  message: '`src/old.ts` was renamed to `lib/new.ts` in this change',
  suggestion: 'lib/new.ts',
});
const script = finding({
  ruleId: 'npm-script',
  kind: 'npm-script',
  fact: 'package.json#build',
  file: 'docs/dev.md',
  line: 10,
  col: 2,
  message: 'npm script `build` (package `app`) was removed in this change',
});
const scanScript = finding({
  ...script,
  message: 'npm script `build` (package `app`) does not exist at this commit',
});
const secondInReadme = finding({ line: 12, col: 4, fact: 'src/gone.ts', message: '`src/gone.ts` was removed in this change' });

describe('formatText', () => {
  it('prints a bare count when there are no findings', () => {
    expect(formatText(diffResult([]))).toMatchInlineSnapshot(`
      "0 findings
      "
    `);
  });

  it('prints one finding with its suggestion', () => {
    expect(formatText(diffResult([renamed]))).toMatchInlineSnapshot(`
      "README.md
        3:15  \`src/old.ts\` was renamed to \`lib/new.ts\` in this change
          -> lib/new.ts

      1 finding in 1 file
      "
    `);
  });

  it('groups findings by file and aligns positions', () => {
    expect(formatText(diffResult([renamed, secondInReadme, script]))).toMatchInlineSnapshot(`
      "README.md
        3:15  \`src/old.ts\` was renamed to \`lib/new.ts\` in this change
          -> lib/new.ts
        12:4  \`src/gone.ts\` was removed in this change

      docs/dev.md
        10:2  npm script \`build\` (package \`app\`) was removed in this change

      3 findings in 2 files
      "
    `);
  });

  it('prints scan findings the same way, without suggestions', () => {
    expect(
      formatText(
        scanResult([
          finding({ message: '`src/missing.ts` does not exist at this commit', fact: 'src/missing.ts' }),
          scanScript,
        ]),
      ),
    ).toMatchInlineSnapshot(`
      "README.md
        3:15  \`src/missing.ts\` does not exist at this commit

      docs/dev.md
        10:2  npm script \`build\` (package \`app\`) does not exist at this commit

      2 findings in 2 files
      "
    `);
  });

  it('never prints warnings: they go to stderr', () => {
    expect(formatText(diffResult([], ['something odd']))).toBe(formatText(diffResult([])));
  });
});

describe('formatWarnings', () => {
  it('prefixes every warning and ends each with a newline', () => {
    expect(formatWarnings(diffResult([], ['one', 'two']))).toMatchInlineSnapshot(`
      "warning: one
      warning: two
      "
    `);
  });

  it('is empty without warnings', () => {
    expect(formatWarnings(diffResult([]))).toBe('');
  });
});

describe('formatJson', () => {
  it('prints a diff result with no findings', () => {
    expect(formatJson(diffResult([]))).toMatchInlineSnapshot(`
      "{
        "schemaVersion": 1,
        "mode": "diff",
        "base": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "findings": [],
        "warnings": [],
        "failOn": "none"
      }
      "
    `);
  });

  it('prints findings, suggestions, warnings and failOn', () => {
    expect(formatJson(diffResult([renamed, script], ['a warning'], 'warning'))).toMatchInlineSnapshot(`
      "{
        "schemaVersion": 1,
        "mode": "diff",
        "base": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "findings": [
          {
            "ruleId": "path",
            "kind": "path",
            "fact": "src/old.ts",
            "file": "README.md",
            "line": 3,
            "col": 15,
            "message": "\`src/old.ts\` was renamed to \`lib/new.ts\` in this change",
            "fingerprint": "0123456789abcdef",
            "suggestion": "lib/new.ts"
          },
          {
            "ruleId": "npm-script",
            "kind": "npm-script",
            "fact": "package.json#build",
            "file": "docs/dev.md",
            "line": 10,
            "col": 2,
            "message": "npm script \`build\` (package \`app\`) was removed in this change",
            "fingerprint": "0123456789abcdef"
          }
        ],
        "warnings": [
          "a warning"
        ],
        "failOn": "warning"
      }
      "
    `);
  });

  it('prints a scan result with mode scan and no base', () => {
    expect(formatJson(scanResult([scanScript]))).toMatchInlineSnapshot(`
      "{
        "schemaVersion": 1,
        "mode": "scan",
        "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "findings": [
          {
            "ruleId": "npm-script",
            "kind": "npm-script",
            "fact": "package.json#build",
            "file": "docs/dev.md",
            "line": 10,
            "col": 2,
            "message": "npm script \`build\` (package \`app\`) does not exist at this commit",
            "fingerprint": "0123456789abcdef"
          }
        ],
        "warnings": [],
        "failOn": "none"
      }
      "
    `);
  });

  it('is two-space indented and newline-terminated', () => {
    const json = formatJson(diffResult([]));
    expect(json.endsWith('}\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(diffResult([]));
  });
});
