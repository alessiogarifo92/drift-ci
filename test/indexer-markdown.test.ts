import { describe, expect, it } from 'vitest';
import { indexMarkdown } from '../src/core/indexer.ts';
import { FENCE, brief, colOf, doc, index } from './indexer-support.ts';

const repo = { owner: 'acme', name: 'widget' };

describe('links, images and definitions', () => {
  it('indexes an inline link at the URL, stripping anchor and query', () => {
    expect(brief(index('See [guide](docs/guide.md#install "Title") now'))).toEqual([
      'path:docs/guide.md@1:13/link',
    ]);
  });

  it('indexes an image and strips the leading ./ and the query', () => {
    expect(brief(index('![logo](./img/logo.png?raw=1)'))).toEqual(['path:img/logo.png@1:9/image']);
  });

  it('indexes a reference definition at its URL', () => {
    expect(brief(index('[ref]: ./docs/a.md "T"'))).toEqual(['path:docs/a.md@1:8/definition']);
  });

  it('finds a definition URL placed on the next line', () => {
    expect(brief(index(doc('[ref]:', '  docs/a.md')))).toEqual(['path:docs/a.md@2:3/definition']);
  });

  it('percent-decodes the path and keeps malformed escapes as written', () => {
    expect(brief(index('[x](my%20file.md)'))).toEqual(['path:my file.md@1:5/link']);
    expect(brief(index('[x](100%.md)'))).toEqual(['path:100%.md@1:5/link']);
  });

  it('keeps a root-anchored link and strips query before anchor', () => {
    expect(brief(index('[x](/docs/a.md)'))).toEqual(['path:/docs/a.md@1:5/link']);
    expect(brief(index('[x](a.md?plain=1#L3)'))).toEqual(['path:a.md@1:5/link']);
  });

  it('reads a URL wrapped in angle brackets', () => {
    expect(brief(index('[x](<my file.md>)'))).toEqual(['path:my file.md@1:6/link']);
  });

  it('points at the link text when the URL cannot be located in the source', () => {
    expect(brief(index('[x](a&amp;b.md)'))).toEqual(['path:a&b.md@1:2/link']);
  });

  it('falls back to the image start or the definition start when the URL cannot be located', () => {
    expect(brief(index('![x](a&amp;b.png)'))).toEqual(['path:a&b.png@1:3/image']);
    expect(brief(index('[ref]: <a&amp;b.md>'))).toEqual(['path:a&b.md@1:1/definition']);
  });

  it('locates the URL on the last line of a link split across lines', () => {
    expect(brief(index(doc('[a long', 'label](docs/a.md)')))).toEqual(['path:docs/a.md@2:8/link']);
  });

  it.each([
    '[x](https://example.com/a.md)',
    '[x](http://example.com)',
    '[x](mailto:a@b.co)',
    '[x](tel:+3912345)',
    '[x](#anchor)',
    '[x](?tab=readme)',
    '[x](//cdn.example.com/x.js)',
    '[x](.)',
    '[x](./)',
    '[x]()',
    '[x]({{ site.url }}/a.md)',
    '[x]({{site}}/a.md)',
    '<https://example.com/a.md>',
    'https://example.com/a/b.md',
  ])('ignores %s', (src) => {
    expect(index(src)).toEqual([]);
  });

  it('records a glob URL as shadow', () => {
    expect(brief(index('[x](docs/*.md)'))).toEqual(['~path:docs/*.md@1:5/link']);
  });

  it('does not index a label that duplicates the link URL', () => {
    expect(brief(index('[`src/a.ts`](src/a.ts)'))).toEqual(['path:src/a.ts@1:14/link']);
  });

  it('keeps inline code in a label that differs from the URL', () => {
    expect(brief(index('[`src/b.ts`](src/a.ts)'))).toEqual([
      'path:src/b.ts@1:3/inline-code',
      'path:src/a.ts@1:14/link',
    ]);
  });

  it('does not extract plain text from a link label', () => {
    expect(index('[see src/foo.ts](https://example.com)')).toEqual([]);
  });

  describe('same-repo github.com URLs', () => {
    it('maps a blob URL to a root-anchored path, case-insensitively, without anchor', () => {
      const src = '[x](https://github.com/Acme/Widget/blob/main/src/a.ts#L10-L20)';
      expect(brief(index(src, { repo }))).toEqual(['path:/src/a.ts@1:5/link']);
    });

    it('maps a tree URL and percent-decodes the path', () => {
      expect(brief(index('[x](https://github.com/acme/widget/tree/v1.0/my%20docs/)', { repo }))).toEqual([
        'path:/my docs/@1:5/link',
      ]);
    });

    it('handles a bare autolink literal', () => {
      const src = 'see https://github.com/acme/widget/blob/main/a.md here';
      expect(brief(index(src, { repo }))).toEqual(['path:/a.md@1:5/link']);
    });

    it('also works for images', () => {
      const src = '![x](https://github.com/acme/widget/blob/main/img/a.png?raw=true)';
      expect(brief(index(src, { repo }))).toEqual(['path:/img/a.png@1:6/image']);
    });

    it.each([
      '[x](https://github.com/other/widget/blob/main/a.md)',
      '[x](https://github.com/acme/other/blob/main/a.md)',
      '[x](https://github.com/acme/widget)',
      '[x](https://github.com/acme/widget/issues/1)',
      '[x](https://github.com/acme/widget/blob/main)',
      '[x](https://github.com/acme/widget/tree/main/)',
      '[x](https://gitlab.com/acme/widget/blob/main/a.md)',
    ])('ignores %s', (src) => {
      expect(index(src, { repo })).toEqual([]);
    });

    it('treats the URL as external when no repo is known', () => {
      expect(index('[x](https://github.com/acme/widget/blob/main/a.md)')).toEqual([]);
    });
  });
});

describe('inline code', () => {
  it.each([
    ['`docs/guide.md`', ['path:docs/guide.md@1:2/inline-code']],
    ['Run `README.md`', ['path:README.md@1:6/inline-code']],
    ['`./src/index.ts:12:3`', ['path:src/index.ts@1:2/inline-code']],
    ['`./src/a.ts#L3`', ['path:src/a.ts@1:2/inline-code']],
    ['`src/`', ['path:src/@1:2/inline-code']],
    ['`../shared/x.json`', ['path:../shared/x.json@1:2/inline-code']],
    ['`/docs/a.md`', ['path:/docs/a.md@1:2/inline-code']],
    ['`Next.js`', ['path:Next.js@1:2/inline-code']],
    ['`src/**/*.ts`', ['~path:src/**/*.ts@1:2/inline-code']],
    ['`docs/{a,b}.md`', ['~path:docs/{a,b}.md@1:2/inline-code']],
    ['`` src/a.ts ``', ['path:src/a.ts@1:4/inline-code']],
    ['`https://example.com/a/b`', []],
    ['`mailto:a@b.co`', []],
    ['`foo/bar baz`', []],
    ['`1/2`', []],
    ['`2026/10/26`', []],
    ['`/`', []],
    ['`<dir>/file.md`', []],
    ['`$DIR/file.md`', ['env:DIR@1:2/inline-code']],
    ['`-rf/x`', []],
    ['`foo`', []],
    ['`and`', []],
    ['``', []],
    ['`  `', []],
  ])('%s', (src, expected) => {
    expect(brief(index(src))).toEqual(expected);
  });

  it('skips inline code that spans several lines', () => {
    expect(index(doc('a `npm', 'run build` b'))).toEqual([]);
  });

  it('indexes inline code inside a GFM table', () => {
    const src = doc('| name | file |', '|---|---|', '| a | `src/a.ts` |', '| b | [d](docs/d.md) |');
    expect(brief(index(src))).toEqual(['path:src/a.ts@3:8/inline-code', 'path:docs/d.md@4:11/link']);
  });
});

describe('plain text', () => {
  it.each([
    ['Edit src/core/foo.ts to fix', ['path:src/core/foo.ts@1:6/text']],
    ['See the docs/ folder.', ['path:docs/@1:9/text']],
    ['Run src/a.ts:12.', ['path:src/a.ts@1:5/text']],
    ['Use "docs/a.md" or (src/b.ts)', ['path:docs/a.md@1:6/text', 'path:src/b.ts@1:21/text']],
    ['**bold src/a.ts**', ['path:src/a.ts@1:8/text']],
    ['# Title src/a.ts', ['path:src/a.ts@1:9/text']],
    ['Look at ./scripts/x.sh', ['path:scripts/x.sh@1:9/text']],
    ['Open README.md please', ['~path:README.md@1:6/text']],
    ['The package.json file', ['~path:package.json@1:5/text']],
    ['Globs like src/*.ts match', ['~path:src/*.ts@1:12/text']],
    ['Use and/or 1/2 on 2026/10/26 w/o it', []],
    ['Coffee w/ milk', []],
    ['Wait ... then ./ go', []],
    ['See ftp://example.com/a/b.md', []],
    ['Visit github.com/acme/widget/README.md now', []],
    ['Read docs/a.md#install', ['path:docs/a.md@1:6/text']],
    ['Edit /docs/a.md', ['path:/docs/a.md@1:6/text']],
    ['A ratio of 1.5/2.0 and TCP/IP', []],
    ['See https://example.com/a/b.md', []],
    ['Mail me at a@b.co or visit example.com', []],
    ['Set (FOO_BAR) first', ['env:FOO_BAR@1:6/text']],
    ['Set FOO_BAR.', ['env:FOO_BAR@1:5/text']],
    ['Set MY_VAR2, then X_1', ['env:MY_VAR2@1:5/text', 'env:X_1@1:19/text']],
    ['Values like API, HOME, PATH or NODE_ENV', []],
    ['Provided by HTTP_PROXY and GITHUB_TOKEN', []],
    ['lowercase_name and Mixed_Case stay text', []],
  ])('%s', (src, expected) => {
    expect(brief(index(src))).toEqual(expected);
  });

  it('indexes the continuation line of a paragraph', () => {
    expect(brief(index(doc('first line', 'see src/a.ts')))).toEqual(['path:src/a.ts@2:5/text']);
  });

  it('skips the blockquote marker on continuation lines', () => {
    expect(brief(index(doc('> a', '> src/a.ts here')))).toEqual(['path:src/a.ts@2:3/text']);
  });

  it('ignores raw HTML', () => {
    expect(index('<img src="docs/a.png"> <a href="docs/b.md">x</a>')).toEqual([]);
  });
});

describe('positions', () => {
  it.each([
    ['emoji before plain text', '😀 see src/a.ts', 'path:src/a.ts@1:8/text'],
    ['CJK before inline code', '日本語 `src/a.ts`', 'path:src/a.ts@1:6/inline-code'],
    ['emoji before inline code', '😀 `src/a.ts`', 'path:src/a.ts@1:5/inline-code'],
    ['emoji before a link', '😀 [x](a.md)', 'path:a.md@1:8/link'],
    ['astral CJK extension before text', '𠮷 a/b.md', 'path:a/b.md@1:4/text'],
  ])('counts UTF-16 code units: %s', (_name, src, expected) => {
    expect(brief(index(src))).toEqual([expected]);
  });

  it('counts UTF-16 code units inside a fence line', () => {
    const src = doc(`${FENCE}sh`, 'echo 😀 && npm run build', FENCE);
    expect(brief(index(src))).toEqual(['npm-script:build@2:20/fence']);
  });

  it('gives the same result for CRLF and LF input, without the carriage return in contextLine', () => {
    const lf = doc(
      '# Title',
      '',
      'Edit src/a.ts or `docs/b.md` and see [c](c.md "t").',
      '',
      `${FENCE}sh`,
      '$ npm run build',
      '$ make test',
      FENCE,
      '',
      '[ref]: ./d.md',
    );
    const crlf = lf.replaceAll('\n', '\r\n');
    const expected = index(lf);
    expect(expected.length).toBeGreaterThanOrEqual(6);
    expect(index(crlf)).toEqual(expected);
    expect(index(crlf).every((r) => !r.contextLine.includes('\r'))).toBe(true);
  });

  it('treats a lone carriage return as a line break', () => {
    expect(brief(index('a\rsee src/a.ts'))).toEqual(['path:src/a.ts@2:5/text']);
  });

  it('ignores a leading byte order mark', () => {
    expect(brief(index('\uFEFF`src/a.ts`'))).toEqual(['path:src/a.ts@1:2/inline-code']);
  });

  it('skips YAML front matter in .mdc files but keeps later line numbers', () => {
    const lines = [
      '---',
      'description: see docs/in-front.md and `npm run fm` and FRONT_VAR',
      'globs: src/**/*.ts',
      '---',
      'Run `npm run build` and see [x](a.md)',
    ];
    const refs = index(doc(...lines), { file: '.cursor/rules/x.mdc' });
    expect(brief(refs)).toEqual([
      `npm-script:build@5:${colOf(lines[4] ?? '', 'build')}/inline-code`,
      `path:a.md@5:${colOf(lines[4] ?? '', 'a.md')}/link`,
    ]);
    expect(refs.every((r) => r.file === '.cursor/rules/x.mdc')).toBe(true);
  });

  it('does not take a thematic break later in the file for front matter', () => {
    expect(brief(index(doc('text', '', '---', '`a/b.ts`')))).toEqual(['path:a/b.ts@4:2/inline-code']);
  });

  it('sorts by line then column, whatever the source order', () => {
    const src = doc('[x](c.md) then `a/b.ts` and src/d.ts', '`z/y.ts`');
    expect(brief(index(src))).toEqual([
      'path:c.md@1:5/link',
      'path:a/b.ts@1:17/inline-code',
      'path:src/d.ts@1:29/text',
      'path:z/y.ts@2:2/inline-code',
    ]);
  });

  it('fills file and contextLine and leaves shadow false for reported references', () => {
    const refs = indexMarkdown('docs/guide.md', doc('intro', 'Use `src/a.ts` here'));
    expect(refs).toEqual([
      {
        kind: 'path',
        normalized: 'src/a.ts',
        file: 'docs/guide.md',
        line: 2,
        col: 6,
        source: 'inline-code',
        contextLine: 'Use `src/a.ts` here',
        shadow: false,
      },
    ]);
  });

  it.each(['', '\n', '   \n\n', '# Just a title', '---\na: b\n---\n'])('returns nothing for %j', (src) => {
    expect(index(src)).toEqual([]);
  });
});
