// A name chosen by whoever wrote the files under check (a script, a target, a bin, a file) is quoted in a
// finding message. The comment renderer treats backtick pairs in a message as code spans, so a backtick in the
// name must never reach the message, and nothing the name holds may turn into a link outside a code span.
import { describe, expect, it } from 'vitest';
import { renderComment, renderSummary, type RenderContext } from '../src/action/render.ts';
import { codeName } from '../src/core/message.ts';
import { binRule } from '../src/core/rules/bin.ts';
import { makeTargetRule } from '../src/core/rules/make.ts';
import { pathRule } from '../src/core/rules/path.ts';
import { npmScriptRule } from '../src/core/rules/scripts.ts';
import type { Rule } from '../src/core/rules.ts';
import { HEAD_SHA, checkResult } from './helpers/action-fakes.ts';
import { findingsOf, pkg, type Scenario } from './helpers/run-rule.ts';

const ctx: RenderContext = { serverUrl: 'https://github.com', owner: 'acme', repo: 'widgets', headSha: HEAD_SHA };
const NASTY = 'x`https://evil.example `octo/other#1`';
const NASTY_NO_HASH = 'x`https://evil.example`octo/other';

/** The comment text of a finding line with every code span removed. */
function outsideCodeSpans(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('- ['))
    .map((line) => line.slice(line.indexOf('): ') + 3))
    .join('\n')
    .replace(/(`+)[^`]*?\1/g, '');
}

function expectInert(text: string): void {
  expect(text).not.toMatch(/https?:\/\//);
  expect(text).not.toMatch(/[\w/]#\d/);
  expect(text).not.toMatch(/(?<!\u200B)@\w/);
}

async function rendered(rule: Rule, scenario: Scenario): Promise<{ message: string; comment: string; summary: string }> {
  const findings = await findingsOf(rule, scenario);
  expect(findings).toHaveLength(1);
  const result = checkResult(findings);
  return {
    message: findings[0]?.message ?? '',
    comment: renderComment(result, ctx),
    summary: renderSummary(result, ctx, []),
  };
}

describe('codeName', () => {
  it('wraps a value in a code span', () => {
    expect(codeName('build')).toBe('`build`');
    expect(codeName('src/a b.ts')).toBe('`src/a b.ts`');
  });

  it('replaces every backtick of the value with a look-alike', () => {
    expect(codeName('a`b``c')).toBe('`aˋbˋˋc`');
    expect(codeName('`')).toBe('`ˋ`');
    expect(codeName('a`b').match(/`/g)).toHaveLength(2);
  });
});

describe('messages never carry a backtick from data', () => {
  const pairs = (message: string) => (message.match(/`/g) ?? []).length;

  it('npm-script: a renamed script and a package named with backticks', async () => {
    const out = await rendered(npmScriptRule(), {
      base: { 'package.json': pkg({ name: NASTY, scripts: { build: 'tsc' } }), 'README.md': '`npm run build`' },
      head: { 'package.json': pkg({ name: NASTY, scripts: { [NASTY]: 'tsc' } }), 'README.md': '`npm run build`' },
    });
    expect(out.message).toContain(NASTY.replaceAll('`', 'ˋ'));
    expect(pairs(out.message)).toBe(6); // `build`, `<package>`, `<new name>`
    for (const markdown of [out.comment, out.summary]) expectInert(outsideCodeSpans(markdown));
  });

  it('bin: a bin renamed to a name with backticks', async () => {
    const out = await rendered(binRule(), {
      base: { 'package.json': pkg({ name: 'p', bin: { mytool: './cli.js' } }), 'README.md': '```sh\nmytool init\n```' },
      head: { 'package.json': pkg({ name: 'p', bin: { [NASTY]: './cli.js' } }), 'README.md': '```sh\nmytool init\n```' },
    });
    expect(pairs(out.message)).toBe(4);
    for (const markdown of [out.comment, out.summary]) expectInert(outsideCodeSpans(markdown));
  });

  it('make: a target renamed to a name with backticks', async () => {
    const out = await rendered(makeTargetRule(), {
      base: { Makefile: 'build:\n\ttsc\n', 'README.md': '```sh\nmake build\n```' },
      head: { Makefile: `${NASTY_NO_HASH}:\n\ttsc\n`, 'README.md': '```sh\nmake build\n```' },
    });
    expect(pairs(out.message)).toBe(4);
    for (const markdown of [out.comment, out.summary]) expectInert(outsideCodeSpans(markdown));
  });

  it('path: a file renamed to a name with backticks', async () => {
    const out = await rendered(pathRule(), {
      base: { 'README.md': 'See `src/old.ts`.', 'src/old.ts': 'x' },
      head: { 'README.md': 'See `src/old.ts`.', [`src/${NASTY}.ts`]: 'x' },
      changes: { renamed: [{ from: 'src/old.ts', to: `src/${NASTY}.ts` }] },
    });
    expect(pairs(out.message)).toBe(4);
    for (const markdown of [out.comment, out.summary]) expectInert(outsideCodeSpans(markdown));
  });

  it('path: a removed file named with backticks', async () => {
    const out = await rendered(pathRule(), {
      base: { 'README.md': 'See `src/a.b.ts`.', 'src/a.b.ts': 'x' },
      head: { 'README.md': 'See `src/a.b.ts`.' },
    });
    expect(pairs(out.message)).toBe(2);
  });
});
