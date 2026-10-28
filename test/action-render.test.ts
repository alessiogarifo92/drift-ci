import { describe, expect, it } from 'vitest';
import {
  COMMENT_MARKER,
  CONFIG_NOTE,
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
      `https://github.com/acme/widgets/blob/${HEAD_SHA}/README.md?plain=1#L3`,
    );
  });

  it('encodes each path segment (spaces, unicode, #, ?, %, parentheses) but keeps the slashes', () => {
    const url = permalink(ctx, 'docs/guía rápida/read me (v2)#1?.md', 12);
    expect(url).toBe(
      `https://github.com/acme/widgets/blob/${HEAD_SHA}/docs/gu%C3%ADa%20r%C3%A1pida/read%20me%20%28v2%29%231%3F.md?plain=1#L12`,
    );
  });

  it.each(['README.md', 'docs/guide.MD', 'a/b.mdx', 'notes.markdown', '.cursor/rules/style.mdc'])(
    'shows %s as source (?plain=1) so the line anchor works on rendered Markdown',
    (file) => {
      const url = permalink(ctx, file, 7);
      expect(url).toMatch(/\?plain=1#L7$/);
      expect(url).not.toMatch(/#L7\?/);
    },
  );

  it.each(['src/a.ts', '.cursorrules', 'docs/readme.txt', 'Makefile', 'md', 'a.md.bak'])('keeps %s as a plain blob link', (file) => {
    expect(permalink(ctx, file, 7)).not.toContain('plain=1');
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
      '\\[x\\](http://\u200Bevil) \\| \\`tick\\` \\*b\\* \\_i\\_ \\~s\\~ \\\\',
    );
  });

  it.each([
    ['https://evil.example/x', 'https://\u200Bevil.example/x'],
    ['see http://a.b and ftp://c.d', 'see http://\u200Ba.b and ftp://\u200Bc.d'],
    ['www.evil.example', 'www.\u200Bevil.example'],
    ['octo/other#1', 'octo/other\u200B#1'],
    ['fixes #12 and org/repo#3', 'fixes \u200B#12 and org/repo\u200B#3'],
    ['issue abc#7', 'issue abc\u200B#7'],
    ['GH-1 and gh-22', 'GH\u200B-1 and gh\u200B-22'],
  ])('defuses autolinks and cross-references: %j', (text, expected) => {
    expect(neutralizeText(text)).toBe(expected);
  });

  it('leaves a `#` alone when it cannot start a reference', () => {
    expect(neutralizeText('# heading and a #tag')).toBe('# heading and a #tag');
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
    expect(body).toContain(`[\`README.md:3\`](https://github.com/acme/widgets/blob/${HEAD_SHA}/README.md?plain=1#L3)`);
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

      - [\`README.md:3\`](https://github.com/acme/widgets/blob/1111111111111111111111111111111111111111/README.md?plain=1#L3): path \`src/old.ts\` was renamed to \`lib/new.ts\` in this change
        Suggestion: \`lib/new.ts\`
      - [\`docs/setup guide.md:14\`](https://github.com/acme/widgets/blob/1111111111111111111111111111111111111111/docs/setup%20guide.md?plain=1#L14): npm script \`build:all\` was removed in this change

      <sub>Updated on every push by [drift-ci](https://github.com/alessiogarifo92/drift-ci).</sub>
      "
    `);
  });
});

describe('config-changed note', () => {
  it('opens the sticky comment and the summary when the PR changes .drift-ci.yml', () => {
    const changed = checkResult([finding()], { configChanged: true });
    const comment = renderComment(changed, ctx);
    const lines = comment.split('\n');
    expect(lines[0]).toBe(COMMENT_MARKER);
    expect(lines[1]).toContain('This pull request changes .drift-ci.yml; the check used the base branch configuration, so the change applies once this is merged.');
    expect(CONFIG_NOTE).toBe('This pull request changes .drift-ci.yml; the check used the base branch configuration, so the change applies once this is merged.');
    expect(renderSummary(changed, ctx, []).startsWith(`> ${CONFIG_NOTE}`)).toBe(true);
    expect(renderNoDriftComment(ctx, checkResult([], { configChanged: true }))).toContain(CONFIG_NOTE);
    expect(renderSummary(checkResult([], { configChanged: true }), ctx, [])).toContain(CONFIG_NOTE);
  });

  it('is absent otherwise', () => {
    expect(renderComment(checkResult([finding()]), ctx)).not.toContain('.drift-ci.yml');
    expect(renderSummary(checkResult([finding()]), ctx, [])).not.toContain('.drift-ci.yml');
    expect(renderNoDriftComment(ctx)).not.toContain('.drift-ci.yml');
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
