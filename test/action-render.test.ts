import { describe, expect, it } from 'vitest';
import {
  COMMENT_MARKER,
  MAX_COMMENT_CHARS,
  neutralizeText,
  permalink,
  renderComment,
  renderNoDriftComment,
  renderSummary,
  type RenderContext,
} from '../src/action/render.ts';
import { HEAD_SHA, checkResult, finding } from './helpers/action-fakes.ts';

const ctx: RenderContext = { serverUrl: 'https://github.com', owner: 'acme', repo: 'widgets', headSha: HEAD_SHA };

describe('permalink', () => {
  it('points at the head SHA, file and line', () => {
    expect(permalink(ctx, 'README.md', 3)).toBe(
      `https://github.com/acme/widgets/blob/${HEAD_SHA}/README.md#L3`,
    );
  });

  it('encodes each path segment (spaces, unicode, #, ?, %, parentheses) but keeps the slashes', () => {
    const url = permalink(ctx, 'docs/guía rápida/read me (v2)#1?.md', 12);
    expect(url).toBe(
      `https://github.com/acme/widgets/blob/${HEAD_SHA}/docs/gu%C3%ADa%20r%C3%A1pida/read%20me%20%28v2%29%231%3F.md#L12`,
    );
  });

  it('uses the configured server (GitHub Enterprise Server)', () => {
    expect(permalink({ ...ctx, serverUrl: 'https://ghe.example.com' }, 'a.md', 1)).toMatch(
      /^https:\/\/ghe\.example\.com\/acme\/widgets\/blob\//,
    );
  });
});

describe('neutralizeText', () => {
  it('breaks mentions with a zero-width space after the @', () => {
    expect(neutralizeText('ping @octocat and @acme/team')).toBe('ping @​octocat and @​acme/team');
  });

  it('escapes HTML so doc text cannot inject markup', () => {
    expect(neutralizeText('<img src=x onerror=1> & <!-- hi -->')).toBe(
      '&lt;img src=x onerror=1&gt; &amp; &lt;!-- hi --&gt;',
    );
  });

  it('escapes markdown that could turn doc text into links or tables', () => {
    expect(neutralizeText('[x](http://evil) | `tick` *b* _i_ ~s~ \\')).toBe(
      '\\[x\\](http://evil) \\| \\`tick\\` \\*b\\* \\_i\\_ \\~s\\~ \\\\',
    );
  });

  it('flattens newlines', () => {
    expect(neutralizeText('a\r\nb\nc')).toBe('a b c');
  });
});

describe('renderComment', () => {
  it('starts with the hidden marker and lists findings with permalinks and suggestions', () => {
    const body = renderComment(checkResult([finding()]), ctx);
    expect(body.split('\n')[0]).toBe(COMMENT_MARKER);
    expect(COMMENT_MARKER).toBe('<!-- drift-ci:sticky-comment -->');
    expect(body).toContain('1 doc reference may be out of date');
    expect(body).toContain(`[\`README.md:3\`](https://github.com/acme/widgets/blob/${HEAD_SHA}/README.md#L3)`);
    expect(body).toContain('path `src/old.ts` was renamed to `lib/new.ts` in this change');
    expect(body).toContain('Suggestion: `lib/new.ts`');
  });

  it('pluralises the heading and omits the suggestion line when there is none', () => {
    const body = renderComment(checkResult([finding(), finding({ line: 9, suggestion: null })]), ctx);
    expect(body).toContain('2 doc references may be out of date');
    expect(body.match(/Suggestion:/g)).toHaveLength(1);
  });

  it('keeps code-span message text readable but neutralises text outside code spans', () => {
    const body = renderComment(
      checkResult([finding({ message: 'bin `a`@evil`b` <b>x</b> was removed' })]),
      ctx,
    );
    expect(body).toContain('bin `a`@​evil`b` &lt;b&gt;x&lt;/b&gt; was removed');
    expect(body).not.toMatch(/@evil/);
    expect(body).not.toContain('<b>');
  });

  it('neutralises a mention hidden in an unbalanced backtick', () => {
    const body = renderComment(checkResult([finding({ message: 'name `@octocat is gone' })]), ctx);
    expect(body).not.toMatch(/@octocat/);
  });

  it('cannot be broken out of via backticks in the file or the suggestion', () => {
    const body = renderComment(
      checkResult([finding({ file: 'a`b.md', suggestion: 'x``y @z <i>' })]),
      ctx,
    );
    expect(body).toContain('[``a`b.md:3``](');
    expect(body).toContain('Suggestion: ```x``y @z <i>```');
  });

  it('caps the body and points to the job summary for the rest', () => {
    const findings = Array.from({ length: 800 }, (_, i) => finding({ line: i + 1, message: 'm'.repeat(150) }));
    const body = renderComment(checkResult(findings), ctx);
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    const shown = (body.match(/^- \[/gm) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(800);
    expect(body).toContain(`… ${800 - shown} more findings, see the job summary`);
  });

  it('does not add the overflow line when everything fits', () => {
    expect(renderComment(checkResult([finding()]), ctx)).not.toContain('more finding');
  });

  it('says "1 more finding" in the singular', () => {
    const one = renderComment(checkResult([finding()]), ctx);
    const body = renderComment(checkResult([finding(), finding({ line: 4 })]), ctx, {
      maxChars: one.length + 60,
    });
    expect(body).toContain('… 1 more finding, see the job summary');
    expect(body).not.toContain('findings, see');
  });

  it('prints a sample comment', () => {
    const body = renderComment(
      checkResult([
        finding(),
        finding({
          file: 'docs/setup guide.md',
          line: 14,
          message: 'npm script `build:all` was removed in this change',
          suggestion: null,
        }),
      ]),
      ctx,
    );
    expect(body).toMatchInlineSnapshot(`
      "<!-- drift-ci:sticky-comment -->
      ### Drift CI: 2 doc references may be out of date

      This pull request renamed or removed things that docs still mention (checked against \`1111111\`):

      - [\`README.md:3\`](https://github.com/acme/widgets/blob/1111111111111111111111111111111111111111/README.md#L3): path \`src/old.ts\` was renamed to \`lib/new.ts\` in this change
        Suggestion: \`lib/new.ts\`
      - [\`docs/setup guide.md:14\`](https://github.com/acme/widgets/blob/1111111111111111111111111111111111111111/docs/setup%20guide.md#L14): npm script \`build:all\` was removed in this change

      <sub>Updated on every push by [drift-ci](https://github.com/alessiogarifo92/drift-ci).</sub>
      "
    `);
  });
});

describe('renderNoDriftComment', () => {
  it('keeps the marker so the next run can find it', () => {
    const body = renderNoDriftComment(ctx);
    expect(body.split('\n')[0]).toBe(COMMENT_MARKER);
    expect(body).toContain('No drift found in `1111111`');
  });
});

describe('renderSummary', () => {
  it('lists every finding without a cap, plus warnings and notes', () => {
    const findings = Array.from({ length: 60 }, (_, i) => finding({ line: i + 1 }));
    const md = renderSummary(checkResult(findings, { warnings: ['could not read x'] }), ctx, ['A note.']);
    expect(md).not.toContain(COMMENT_MARKER);
    expect((md.match(/^- \[/gm) ?? []).length).toBe(60);
    expect(md).toContain('60 doc references may be out of date');
    expect(md).toContain('A note.');
    expect(md).toContain('could not read x');
  });

  it('says so when nothing drifted', () => {
    const md = renderSummary(checkResult([]), ctx, []);
    expect(md).toContain('No drift found');
    expect(md).toContain('1111111');
  });

  it('neutralises warnings as well', () => {
    const md = renderSummary(checkResult([], { warnings: ['bad <config> by @someone'] }), ctx, []);
    expect(md).toContain('bad &lt;config&gt; by @​someone');
  });
});
