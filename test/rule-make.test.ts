import { describe, expect, it } from 'vitest';
import { makeTargetRule, parseMakefile } from '../src/core/rules/make.ts';
import { briefOf, findingsOf, type Files } from './helpers/run-rule.ts';

const T = '\t';
const lines = (...l: string[]) => l.join('\n');
const names = (text: string) => parseMakefile(text).map((t) => t.name);

describe('parseMakefile: which lines define targets', () => {
  it.each([
    ['a single target', 'build: deps\n', ['build']],
    ['several targets on one line', 'build test: deps\n', ['build', 'test']],
    ['a double-colon rule', 'clean::\n', ['clean']],
    ['spaces around the colon', 'build : deps\n', ['build']],
    ['no space after the colon', 'build:deps\n', ['build']],
    ['a grouped target', 'a b &: c\n', ['a', 'b']],
    ['a file target with a path', 'dist/app.js: src/app.ts\n', ['dist/app.js']],
    ['a target-specific variable', 'build: CFLAGS = -O2\n', ['build']],
    ['a static pattern rule with plain targets', 'a b: %.o: %.c\n', ['a', 'b']],
    ['a comment after the rule', 'build: # compile\n', ['build']],
    ['CRLF line endings', 'build:\r\n\tcc\r\ntest:\r\n', ['build', 'test']],
    ['a rule after other lines', 'X = 1\n\nbuild:\n', ['build']],
    ['a target on a continued line', 'a \\\n  b: c\n', ['a', 'b']],
    ['prerequisites continued over lines', 'build: a \\\n  b \\\n  c\n\ttrue\n', ['build']],
  ])('%s', (_label, text, expected) => {
    expect(names(text)).toEqual(expected);
  });

  it.each([
    ['simple assignment', 'CC = gcc\n'],
    ['colon assignment', 'CC := gcc\n'],
    ['double-colon assignment', 'CC ::= gcc\n'],
    ['triple-colon assignment', 'CC :::= gcc\n'],
    ['conditional assignment', 'CC ?= gcc\n'],
    ['append assignment', 'CFLAGS += -Wall\n'],
    ['shell assignment', 'V != date\n'],
    ['assignment without spaces', 'CC:=gcc\n'],
    ['assignment with a colon in the value', 'PATHS = a:b:c\n'],
    ['exported assignment', 'export CC := gcc\n'],
    ['.PHONY', '.PHONY: build test\n'],
    ['.DEFAULT_GOAL assignment', '.DEFAULT_GOAL := build\n'],
    ['special targets', '.SUFFIXES:\n.DEFAULT:\n'],
    ['a pattern rule', '%.o: %.c\n'],
    ['a pattern rule with a directory', 'build/%.o: src/%.c\n'],
    ['a target using a variable', '$(BIN): main.c\n'],
    ['a target using a brace variable', '${BIN}: main.c\n'],
    ['a target embedding a variable', 'lib$(NAME).a: x.o\n'],
    ['a variable with a colon inside $()', 'X = $(subst a:b,c,d)\n'],
    ['recipe-looking lines outside a rule', '\techo "a: b"\n\tdone: yes\n'],
    ['include directives', 'include other.mk\n-include dev:cfg.mk\nsinclude x.mk\n'],
    ['conditionals', 'ifeq ($(A),b:c)\nelse ifdef X\nendif\n'],
    ['a comment line', '# build: nothing\n'],
    ['a define block', 'define BLOCK\nfoo: bar\nbaz:\nendef\n'],
    ['an override define block', 'override define BLOCK\nfoo: bar\nendef\n'],
    ['an empty target list', ': deps\n'],
  ])('skips %s', (_label, text) => {
    expect(names(text)).toEqual([]);
  });

  it('does not read recipe lines of a rule as rules', () => {
    expect(names('build:\n\techo "a: b"\n\tdone: yes\n')).toEqual(['build']);
  });

  it('keeps targets after a define block and nested defines', () => {
    expect(names('define A\ndefine B\nx:\nendef\ny:\nendef\nbuild:\n')).toEqual(['build']);
  });

  it('finds a target after skipped lines', () => {
    expect(names(lines('CC := gcc', '.PHONY: all', '%.o: %.c', `${T}$(CC) -c`, 'all: main.o', 'test:'))).toEqual(['all', 'test']);
  });

  it('collects the recipe lines, trimmed, until the next rule', () => {
    const [build, test] = parseMakefile(lines('build: deps', `${T}tsc`, '', '# note', `${T}  echo done  `, 'test:', `${T}vitest`));
    expect(build).toEqual({ name: 'build', recipe: 'tsc\necho done' });
    expect(test).toEqual({ name: 'test', recipe: 'vitest' });
  });

  it('gives every target of a multi-target line the same recipe', () => {
    expect(parseMakefile(lines('a b:', `${T}run`))).toEqual([
      { name: 'a', recipe: 'run' },
      { name: 'b', recipe: 'run' },
    ]);
  });

  it('joins backslash continuations inside a recipe', () => {
    expect(parseMakefile(lines('a:', `${T}echo one \\`, `${T}two`))[0]?.recipe).toBe('echo one two');
  });

  it('has an empty recipe for a rule without recipe lines', () => {
    expect(parseMakefile('all: a b\n')).toEqual([{ name: 'all', recipe: '' }]);
  });

  it('does not take a tab line before any rule for a recipe', () => {
    expect(parseMakefile(`${T}stray: line\nreal:\n`)).toEqual([{ name: 'real', recipe: '' }]);
  });

  it('keeps an escaped # in a rule line', () => {
    expect(names('a\\#b: c\n')).toEqual(['a\\#b']);
  });
});

const rule = makeTargetRule;
const doc = (...l: string[]) => ['```sh', ...l, '```'].join('\n');

describe('parseMakefile: hostile input', () => {
  it('joins tens of thousands of continuation lines in linear time', () => {
    const text = `build: ${'dep \\\n'.repeat(60_000)}last\n${T}run\nlint:\n`;
    const started = performance.now();
    expect(names(text)).toEqual(['build', 'lint']);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('counts the backslashes at the end of a very long run of them in linear time', () => {
    const text = `a:\n${T}x ${'\\'.repeat(200_000)}\nb:\n`;
    const started = performance.now();
    expect(names(text)).toEqual(['a', 'b']);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('keeps the odd/even rule: an even run of backslashes does not continue the line', () => {
    expect(names('a: b \\\\\nc:\n')).toEqual(['a', 'c']);
    expect(names('a: b \\\\\\\n  c:\n')).toEqual(['a']); // three: continues
  });
});

describe('makeTargetRule: what is drift', () => {
  it('flags a removed target, without suggestion', async () => {
    const [finding] = await findingsOf(rule(), {
      base: { Makefile: `build:\n${T}tsc\nlint:\n${T}eslint\n`, 'README.md': doc('make build') },
      head: { Makefile: `lint:\n${T}eslint\n`, 'README.md': doc('make build') },
    });
    expect(finding).toMatchObject({
      ruleId: 'make-target',
      kind: 'make-target',
      fact: 'make:build',
      file: 'README.md',
      line: 2,
      col: 6,
      message: 'Make target `build` was removed in this change',
    });
    expect(finding && 'suggestion' in finding).toBe(false);
  });

  it('suggests the new name when one target was renamed in the same makefile with the same recipe', async () => {
    const [finding] = await findingsOf(rule(), {
      base: { Makefile: `build:\n${T}tsc -p .\nlint:\n${T}eslint\n`, 'README.md': doc('make build') },
      head: { Makefile: `compile:\n${T}tsc -p .\nlint:\n${T}eslint\n`, 'README.md': doc('make build') },
    });
    expect(finding?.message).toBe('Make target `build` was renamed to `compile` in this change');
    expect(finding?.suggestion).toBe('compile');
  });

  it.each([
    ['a different recipe', `compile:\n${T}tsc --noEmit\n`],
    ['an empty recipe', 'compile:\n'],
    ['two added targets', `compile:\n${T}tsc\nother:\n${T}tsc\n`],
  ])('does not suggest with %s', async (_label, headMakefile) => {
    const result = await briefOf(rule(), {
      base: { Makefile: `build:\n${T}tsc\n`, 'README.md': doc('make build') },
      head: { Makefile: headMakefile, 'README.md': doc('make build') },
    });
    expect(result).toEqual(['make:build -> none']);
  });

  it('does not suggest an empty-recipe rename', async () => {
    const result = await briefOf(rule(), {
      base: { Makefile: 'build:\n', 'README.md': doc('make build') },
      head: { Makefile: 'compile:\n', 'README.md': doc('make build') },
    });
    expect(result).toEqual(['make:build -> none']);
  });

  it('flags both targets of a `build test:` line', async () => {
    const result = await briefOf(rule(), {
      base: { Makefile: `build test:\n${T}run\n`, 'README.md': doc('make build', 'make test') },
      head: { Makefile: `all:\n${T}run\n`, 'README.md': doc('make build', 'make test') },
    });
    expect(result).toEqual(['make:build -> none', 'make:test -> none']);
  });

  it('never flags a target that did not exist in base', async () => {
    expect(
      await briefOf(rule(), {
        base: { Makefile: 'lint:\n', 'README.md': doc('make build') },
        head: { Makefile: 'lint:\n', 'README.md': doc('make build') },
      }),
    ).toEqual([]);
  });

  it('does not flag a target that still exists', async () => {
    const files = { Makefile: 'build:\n', 'README.md': doc('make build') };
    expect(await briefOf(rule(), { base: files, head: files })).toEqual([]);
  });

  it('does not flag a target moved into an included .mk file', async () => {
    expect(
      await briefOf(rule(), {
        base: { Makefile: `build:\n${T}tsc\n`, 'README.md': doc('make build') },
        head: { Makefile: 'include mk/build.mk\n', 'mk/build.mk': `build:\n${T}tsc\n`, 'README.md': doc('make build') },
      }),
    ).toEqual([]);
  });

  it.each(['Makefile', 'GNUmakefile', 'makefile', 'sub/Makefile', 'rules.mk', 'mk/deep/targets.mk'])(
    'reads targets from %s',
    async (path) => {
      const result = await briefOf(rule(), {
        base: { [path]: 'build:\n', 'README.md': doc('make build') },
        head: { 'README.md': doc('make build') },
      });
      expect(result).toEqual(['make:build -> none']);
    },
  );

  it('ignores files that are not makefiles', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'Makefile.txt': 'build:\n', 'notes.mk.md': 'build:\n', 'README.md': doc('make build') },
        head: { 'README.md': doc('make build') },
      }),
    ).toEqual([]);
  });

  it('is not fooled by assignments and special targets of a removed makefile line', async () => {
    expect(
      await briefOf(rule(), {
        base: { Makefile: '.PHONY: build\nbuild := yes\n', 'README.md': doc('make build') },
        head: { Makefile: '', 'README.md': doc('make build') },
      }),
    ).toEqual([]);
  });
});

describe('makeTargetRule: targets this rule cannot see in head', () => {
  const readme = doc('make lint');
  const base = { Makefile: `lint:\n${T}run\nbuild:\n`, 'README.md': readme };
  const flagged = (head: Files) => briefOf(rule(), { base, head: { 'README.md': readme, ...head } });

  it('reads Makefile.common-style files, so a target moved there is not flagged', async () => {
    expect(await flagged({ Makefile: 'include Makefile.common\nbuild:\n', 'Makefile.common': `lint:\n${T}run\n` })).toEqual([]);
    expect(await flagged({ Makefile: 'include Makefile.inc\nbuild:\n', 'Makefile.inc': 'lint:\n' })).toEqual([]);
  });

  it('reads a file named by an include directive whatever its name', async () => {
    expect(await flagged({ Makefile: 'include build/rules.inc\n', 'build/rules.inc': 'lint:\n' })).toEqual([]);
    expect(await flagged({ Makefile: '-include build/rules.inc\n', 'build/rules.inc': 'lint:\n' })).toEqual([]);
    expect(await flagged({ Makefile: 'sinclude rules.inc\n', 'rules.inc': 'lint:\n' })).toEqual([]);
  });

  it('follows includes of included files', async () => {
    expect(
      await flagged({ Makefile: 'include a.inc\n', 'a.inc': 'include sub/b.inc\n', 'sub/b.inc': 'lint:\n' }),
    ).toEqual([]);
  });

  it('still flags when the included file does not define the target', async () => {
    expect(await flagged({ Makefile: 'include Makefile.common\n', 'Makefile.common': 'other:\n' })).toEqual([
      'make:lint -> none',
    ]);
  });

  it.each([
    ['an include it cannot find', 'include missing.mk\n'],
    ['an optional include it cannot find', '-include local.mk\n'],
    ['an include built from a variable', 'include $(DIR)/rules.mk\n'],
    ['an include with a wildcard', 'include mk/*.mk\n'],
  ])('does not flag when a head makefile has %s', async (_label, include) => {
    expect(await flagged({ Makefile: `${include}build:\n` })).toEqual([]);
  });

  it.each([
    ['a target list built from a variable', 'GOCMDS := build lint\n$(GOCMDS):\n\tgo $@\n'],
    ['a brace variable target', '${CMDS}:\n\ttrue\n'],
    ['$(eval ...)', '$(eval $(call mk,lint))\n'],
    ['$(foreach ...)', '$(foreach t,lint build,$(eval $(call rule,$(t))))\n'],
  ])('does not flag when a head makefile defines targets through %s', async (_label, text) => {
    expect(await flagged({ Makefile: text })).toEqual([]);
  });

  it('flags as before when the head makefiles are plain', async () => {
    expect(await flagged({ Makefile: 'build:\n' })).toEqual(['make:lint -> none']);
  });

  it('only looks at makefiles in the reference scope', async () => {
    const scoped = doc('make -C tools lint');
    const result = await briefOf(rule(), {
      base: { 'tools/Makefile': 'lint:\n', Makefile: 'x:\n', 'README.md': scoped },
      head: { 'tools/Makefile': 'x:\n', Makefile: 'include nowhere.mk\n', 'README.md': scoped },
    });
    expect(result).toEqual(['make:lint -> none']);
  });

  it('does not treat doc and backup extensions as makefiles', async () => {
    expect(
      await briefOf(rule(), {
        base: { 'Makefile.md': 'lint:\n', 'Makefile.bak': 'lint:\n', 'README.md': readme },
        head: { 'README.md': readme },
      }),
    ).toEqual([]);
  });

  it('does not suggest a rename when the targets live in another file now', async () => {
    expect(
      await flagged({ Makefile: 'include Makefile.common\n', 'Makefile.common': `lint-all:\n${T}run\n` }),
    ).toEqual(['make:lint -> none']);
  });
});

describe('makeTargetRule: fixtures and excluded paths do not count', () => {
  const readme = doc('make lint');

  it.each(['test/fixtures/a/Makefile', 'x/__fixtures__/Makefile', 'testdata/rules.mk', 'vendor/lib/Makefile', 'node_modules/x/Makefile'])(
    'does not read %s',
    async (path) => {
      // Only the fixture defines `lint` in base: it is not a target of this project.
      expect(
        await briefOf(rule(), { base: { [path]: 'lint:\n', 'Makefile': 'build:\n', 'README.md': readme }, head: { Makefile: 'build:\n', 'README.md': readme } }),
      ).toEqual([]);
    },
  );

  it('does not let a fixture makefile keep a target alive in head', async () => {
    expect(
      await briefOf(rule(), {
        base: { Makefile: 'lint:\n', 'README.md': readme },
        head: { Makefile: 'build:\n', 'test/fixtures/a/Makefile': 'lint:\n', 'README.md': readme },
      }),
    ).toEqual(['make:lint -> none']);
  });

  it('is not made unsure by an include inside a fixture', async () => {
    expect(
      await briefOf(rule(), {
        base: { Makefile: 'lint:\n', 'README.md': readme },
        head: { Makefile: 'build:\n', 'test/fixtures/a/Makefile': 'include nowhere.mk\n', 'README.md': readme },
      }),
    ).toEqual(['make:lint -> none']);
  });

  it('ignores the makefiles docs.exclude matches', async () => {
    const result = await briefOf(rule(), {
      base: { 'gen/Makefile': 'lint:\n', Makefile: 'build:\n', 'README.md': readme },
      head: { Makefile: 'build:\n', 'README.md': readme },
      exclude: ['gen/**'],
    });
    expect(result).toEqual([]);
  });
});

describe('makeTargetRule: scope', () => {
  const monorepo = (overrides: Files = {}): Files => ({
    'Makefile': 'root:\n',
    'tools/Makefile': 'build:\n',
    'tools/mk/extra.mk': 'extra:\n',
    'other/Makefile': 'build:\n',
    'README.md': 'x',
    ...overrides,
  });

  it('uses the union of every makefile when there is no cwd: another makefile keeping the target is enough', async () => {
    const readme = doc('make build');
    const head = monorepo({ 'tools/Makefile': 'x:\n', 'README.md': readme });
    expect(await briefOf(rule(), { base: monorepo({ 'README.md': readme }), head })).toEqual([]);
  });

  it('limits a `make -C dir` reference to the makefiles under that directory', async () => {
    const readme = doc('make -C tools build');
    const head = monorepo({ 'tools/Makefile': 'x:\n', 'README.md': readme });
    expect(await briefOf(rule(), { base: monorepo({ 'README.md': readme }), head })).toEqual(['make:build -> none']);
  });

  it('limits a `cd dir && make` reference to that directory', async () => {
    const readme = doc('cd tools && make build');
    const head = monorepo({ 'tools/Makefile': 'x:\n', 'README.md': readme });
    expect(await briefOf(rule(), { base: monorepo({ 'README.md': readme }), head })).toEqual(['make:build -> none']);
  });

  it('includes makefiles in subdirectories of the cwd', async () => {
    const readme = doc('make -C tools extra');
    const base = monorepo({ 'README.md': readme });
    expect(await briefOf(rule(), { base, head: monorepo({ 'tools/mk/extra.mk': 'y:\n', 'README.md': readme }) })).toEqual([
      'make:extra -> none',
    ]);
    expect(await briefOf(rule(), { base, head: monorepo({ 'tools/mk/extra.mk': '', 'tools/Makefile': 'extra:\n', 'README.md': readme }) })).toEqual([]);
  });

  it('does not flag a target moved between files under the cwd', async () => {
    const readme = doc('make -C tools build');
    const head = monorepo({ 'tools/Makefile': 'include mk/extra.mk\n', 'tools/mk/extra.mk': 'extra:\nbuild:\n', 'README.md': readme });
    expect(await briefOf(rule(), { base: monorepo({ 'README.md': readme }), head })).toEqual([]);
  });

  it('resolves the cwd against the doc directory', async () => {
    const readme = doc('make -C ../tools build');
    const base = monorepo({ 'docs/guide.md': readme });
    const head = monorepo({ 'tools/Makefile': 'x:\n', 'docs/guide.md': readme });
    expect(await briefOf(rule(), { base, head })).toEqual(['make:build -> none']);
  });

  it('does not match a directory by prefix', async () => {
    const readme = doc('make -C tool build');
    const base = monorepo({ 'README.md': readme });
    const head = monorepo({ 'tools/Makefile': 'x:\n', 'README.md': readme });
    expect(await briefOf(rule(), { base, head })).toEqual([]);
  });

  it.each(['make -C /srv/app build', 'make -C ~/app build', 'make -C $APP build', 'make -C ../.. build'])(
    'ignores a cwd it cannot place: %s',
    async (line) => {
      const base = monorepo({ 'README.md': doc(line) });
      const head = monorepo({ 'tools/Makefile': 'x:\n', 'other/Makefile': 'y:\n', 'README.md': doc(line) });
      expect(await briefOf(rule(), { base, head })).toEqual([]);
    },
  );

  it('suggests a rename only within the makefile that defined the target', async () => {
    const readme = doc('make -C tools build');
    const base = monorepo({ 'tools/Makefile': `build:\n${T}go\n`, 'README.md': readme });
    const head = monorepo({ 'tools/Makefile': `compile:\n${T}go\n`, 'README.md': readme });
    expect(await briefOf(rule(), { base, head })).toEqual(['make:build -> compile']);
  });
});

describe('makeTargetRule: lifecycle', () => {
  it('has its id, kinds and refuses check() before prepare()', () => {
    const r = rule();
    expect(r.id).toBe('make-target');
    expect(r.kinds).toEqual(['make-target']);
    expect(() =>
      r.check(
        { kind: 'make-target', normalized: 'x', file: 'README.md', line: 1, col: 1, source: 'fence', contextLine: '', shadow: false },
        { path: 'README.md' },
      ),
    ).toThrow(/prepare/);
  });
});
