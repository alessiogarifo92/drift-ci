import { describe, expect, it } from 'vitest';
import { parsePackageJson, resolveCwdDir } from '../src/core/rules/packages.ts';

function parsed(text: string, path = 'package.json') {
  const result = parsePackageJson(path, text);
  if ('error' in result) throw new Error(result.error);
  return result;
}

describe('parsePackageJson', () => {
  it('reads name, scripts and the directory', () => {
    const p = parsed('{"name":"a","scripts":{"build":"tsc","test":"vitest"}}', 'packages/a/package.json');
    expect(p.dir).toBe('packages/a');
    expect(p.name).toBe('a');
    expect([...p.scripts]).toEqual([
      ['build', 'tsc'],
      ['test', 'vitest'],
    ]);
  });

  it('uses the empty string as the directory of the root package.json', () => {
    expect(parsed('{}').dir).toBe('');
  });

  it('ignores a BOM', () => {
    expect(parsed('\uFEFF{"name":"a"}').name).toBe('a');
  });

  it('keeps only string script bodies and treats a non-object scripts field as empty', () => {
    expect([...parsed('{"scripts":{"a":"x","b":1,"c":null}}').scripts]).toEqual([['a', 'x']]);
    expect(parsed('{"scripts":"nope"}').scripts.size).toBe(0);
    expect(parsed('{"scripts":["a"]}').scripts.size).toBe(0);
  });

  it('names the bin of the string form after the package, without its scope', () => {
    expect([...parsed('{"name":"tool","bin":"./cli.js"}').bins]).toEqual([['tool', './cli.js']]);
    expect([...parsed('{"name":"@acme/tool","bin":"cli.js"}').bins]).toEqual([['tool', 'cli.js']]);
  });

  it('reads the keys of the object form', () => {
    const p = parsed('{"name":"@acme/x","bin":{"a":"./a.js","b":"./b.js","c":3}}');
    expect([...p.bins]).toEqual([
      ['a', './a.js'],
      ['b', './b.js'],
    ]);
  });

  it('has no bin for the string form without a package name', () => {
    expect(parsed('{"bin":"./cli.js"}').bins.size).toBe(0);
  });

  it.each([
    ['{"name":', /invalid package\.json|JSON|Unexpected|end/i],
    ['', /JSON|Unexpected|end/i],
  ])('reports invalid JSON %j', (text, reason) => {
    const result = parsePackageJson('x/package.json', text);
    expect(result).toMatchObject({ error: expect.stringMatching(reason) });
  });

  it.each(['[]', '"text"', 'null', '3'])('reports %s as not an object', (text) => {
    expect(parsePackageJson('package.json', text)).toEqual({ error: 'not a JSON object' });
  });
});

describe('resolveCwdDir', () => {
  it.each([
    ['README.md', 'packages/a', 'packages/a'],
    ['docs/guide.md', 'packages/a', 'docs/packages/a'],
    ['docs/guide.md', '..', ''],
    ['docs/guide.md', '../packages/a', 'packages/a'],
    ['a/b/c.md', '../../x/', 'x'],
  ])('%s with cwd %s -> %s', (doc, cwd, expected) => {
    expect(resolveCwdDir(doc, cwd)).toBe(expected);
  });

  it.each(['/abs/dir', '~/dir', '$HOME/dir', '../..', '../../x'])('cannot place %s', (cwd) => {
    expect(resolveCwdDir('README.md', cwd)).toBeUndefined();
  });
});
