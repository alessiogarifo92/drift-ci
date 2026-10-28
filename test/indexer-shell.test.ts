import { describe, expect, it } from 'vitest';
import {
  NPM_IMPLICIT_SCRIPTS,
  PNPM_BUILTINS,
  SHELL_COMMAND_EXCLUDE,
  YARN_BUILTINS,
} from '../src/core/shell.ts';
import { WELL_KNOWN_ENV_PREFIXES, WELL_KNOWN_ENV_VARS } from '../src/core/shapes.ts';
import { FENCE, brief, doc, index, ofKind } from './indexer-support.ts';

function fence(lang: string, ...lines: string[]): string {
  return doc(`${FENCE}${lang}`, ...lines, FENCE);
}

describe('inline code: npm scripts', () => {
  it.each([
    ['`npm run build`', 'build', 10],
    ['`npm run-script build`', 'build', 17],
    ['`npm test`', 'test', 6],
    ['`npm t`', 'test', 6],
    ['`npm start`', 'start', 6],
    ['`npm stop`', 'stop', 6],
    ['`npm restart`', 'restart', 6],
    ['`npm run build:prod`', 'build:prod', 10],
    ['`npm run build -- --watch`', 'build', 10],
    ['`npm run build --silent`', 'build', 10],
    ['`npm --silent run build`', 'build', 19],
    ['`npm run --if-present build`', 'build', 23],
  ])('%s', (src, name, col) => {
    expect(brief(index(src))).toEqual([`npm-script:${name}@1:${col}/inline-code`]);
    expect(index(src)[0]?.context).toEqual({ packageManager: 'npm' });
  });

  it.each([
    ['`pnpm lint`', 'pnpm', 'lint', 7],
    ['`pnpm run lint`', 'pnpm', 'lint', 11],
    ['`pnpm test`', 'pnpm', 'test', 7],
    ['`yarn dev`', 'yarn', 'dev', 7],
    ['`yarn run dev`', 'yarn', 'dev', 11],
    ['`bun run dev`', 'bun', 'dev', 10],
  ])('%s', (src, pm, name, col) => {
    expect(brief(index(src))).toEqual([`npm-script:${name}@1:${col}/inline-code`]);
    expect(index(src)[0]?.context).toEqual({ packageManager: pm });
  });

  it.each([
    '`npm install`',
    '`npm i left-pad`',
    '`npm ci`',
    '`npm publish`',
    '`npm run`',
    '`npm --silent`',
    '`npm run $SCRIPT_NAME`',
    '`npm run <script>`',
    '`npm run build:*`',
    '`pnpm install`',
    '`pnpm add x`',
    '`pnpm exec tsc`',
    '`pnpm dlx create-x`',
    '`pnpm`',
    '`yarn`',
    '`yarn add x`',
    '`yarn install --frozen-lockfile`',
    '`yarn dlx x`',
    '`yarn workspaces foreach run build`',
    '`yarn ./x.js`',
    '`bun test`',
    '`bun install`',
    '`bun run ./x.ts`',
    '`bun run x.ts`',
    '`npx tsc --noEmit`',
  ])('finds no script in %s', (src) => {
    expect(ofKind(index(src), 'npm-script')).toEqual([]);
  });

  it.each([
    ['`npm -w pkg-a run build`', { packageManager: 'npm', workspace: 'pkg-a' }],
    ['`npm run build --workspace=pkg-a`', { packageManager: 'npm', workspace: 'pkg-a' }],
    ['`npm run build --workspace pkg-a`', { packageManager: 'npm', workspace: 'pkg-a' }],
    ['`npm run build -w pkg-a -- --watch`', { packageManager: 'npm', workspace: 'pkg-a' }],
    ['`pnpm --filter web build`', { packageManager: 'pnpm', workspace: 'web' }],
    ['`pnpm --filter=web build`', { packageManager: 'pnpm', workspace: 'web' }],
    ['`pnpm -F web run build`', { packageManager: 'pnpm', workspace: 'web' }],
    ['`pnpm -r run build`', { packageManager: 'pnpm', allWorkspaces: true }],
    ['`yarn workspace web build`', { packageManager: 'yarn', workspace: 'web' }],
    ['`yarn workspace web run build`', { packageManager: 'yarn', workspace: 'web' }],
    ['`bun --filter web run build`', { packageManager: 'bun', workspace: 'web' }],
    ['`npm --prefix web run build`', { packageManager: 'npm', cwd: 'web' }],
    ['`npm --loglevel verbose run build`', { packageManager: 'npm' }],
    ['`pnpm -C packages/a run build`', { packageManager: 'pnpm', cwd: 'packages/a' }],
    ['`pnpm --dir=packages/a build`', { packageManager: 'pnpm', cwd: 'packages/a' }],
    ['`yarn --cwd web build`', { packageManager: 'yarn', cwd: 'web' }],
    ['`cd web && npm run build`', { packageManager: 'npm', cwd: 'web' }],
  ])('context of %s', (src, context) => {
    const scripts = ofKind(index(src), 'npm-script');
    expect(scripts.map((r) => r.normalized)).toEqual(['build']);
    expect(scripts[0]?.context).toEqual(context);
  });

  it.each([
    ['`pnpm -r build`', { packageManager: 'pnpm', allWorkspaces: true }],
    ['`pnpm --recursive run build`', { packageManager: 'pnpm', allWorkspaces: true }],
    ['`npm run build --workspaces`', { packageManager: 'npm', allWorkspaces: true }],
    ['`npm run build --workspaces --if-present`', { packageManager: 'npm', allWorkspaces: true }],
    ['`npm run build -ws`', { packageManager: 'npm', allWorkspaces: true }],
    ['`pnpm --filter "*" build`', { packageManager: 'pnpm', workspace: '*', allWorkspaces: true }],
    ['`pnpm --filter ./packages/* run build`', { packageManager: 'pnpm', workspace: './packages/*', allWorkspaces: true }],
    ['`pnpm -F @acme/* build`', { packageManager: 'pnpm', workspace: '@acme/*', allWorkspaces: true }],
    ['`bun run --filter "*" build`', { packageManager: 'bun', workspace: '*', allWorkspaces: true }],
  ])('context of %s: every workspace', (src, context) => {
    const scripts = ofKind(index(src), 'npm-script');
    expect(scripts.map((r) => r.normalized)).toEqual(['build']);
    expect(scripts[0]?.context).toEqual(context);
  });

  it('does not take a flag after `--` for the package manager\'s', () => {
    const scripts = ofKind(index('`npm run build -- -r --workspaces`'), 'npm-script');
    expect(scripts[0]?.context).toEqual({ packageManager: 'npm' });
  });

  it.each(['`turbo run build`', '`npx turbo run build`', '`nx run-many -t build`', '`nx run-many --target=build --all`'])(
    'turbo and nx runs are no npm scripts: %s',
    (src) => {
      expect(ofKind(index(src), 'npm-script')).toEqual([]);
    },
  );

  it('ignores a workspace flag that is missing its value at the end of the line', () => {
    const scripts = ofKind(index('`npm run build -w`'), 'npm-script');
    expect(scripts.map((r) => r.normalized)).toEqual(['build']);
    expect(scripts[0]?.context).toEqual({ packageManager: 'npm' });
  });
});

describe('inline code: make targets', () => {
  it('indexes a single target', () => {
    expect(brief(index('`make build`'))).toEqual(['make-target:build@1:7/inline-code']);
    expect(index('`make build`')[0]?.context).toBeUndefined();
  });

  it('indexes every target, skipping variables and flags, and records -C', () => {
    const refs = index('`make -C sub build test VAR=1 -j4`');
    expect(refs.map((r) => r.normalized)).toEqual(['build', 'test']);
    expect(refs.map((r) => r.context)).toEqual([{ cwd: 'sub' }, { cwd: 'sub' }]);
  });

  it.each([
    ['`make --directory=sub x`', { cwd: 'sub' }],
    ['`make --directory sub x`', { cwd: 'sub' }],
    ['`make -f other.mk x`', undefined],
    ['`make -j 4 x`', undefined],
    ['`make -j x`', undefined],
    ['`make -s -k x`', undefined],
    ['`make -Csub x`', { cwd: 'sub' }],
    ['`make --jobs=4 x`', undefined],
    ['`make --jobs 4 x`', undefined],
    ['`gmake x`', undefined],
    ['`cd top && make x`', { cwd: 'top' }],
    ['`cd top && make -C sub x`', { cwd: 'top/sub' }],
  ])('context of %s', (src, context) => {
    const targets = ofKind(index(src), 'make-target');
    expect(targets.map((r) => r.normalized)).toEqual(['x']);
    expect(targets[0]?.context).toEqual(context);
  });

  it.each(['`make`', '`make -j4`', '`make VAR=1`'])('finds no target in %s', (src) => {
    expect(ofKind(index(src), 'make-target')).toEqual([]);
  });
});

describe('inline code: env vars', () => {
  it.each([
    ['`FOO_BAR`', ['env:FOO_BAR@1:2/inline-code']],
    ['`$API`', ['env:API@1:2/inline-code']],
    ['`$api_url`', ['~env:api_url@1:2/inline-code']],
    ['`${API_URL}`', ['env:API_URL@1:2/inline-code']],
    ['`${API_URL:-x}`', ['env:API_URL@1:2/inline-code']],
    ['`FOO_BAR=1`', ['env:FOO_BAR@1:2/inline-code']],
    ['`export FOO_BAR=1`', ['env:FOO_BAR@1:9/inline-code']],
    ['`FOO_BAR=1 npm test`', ['env:FOO_BAR@1:2/inline-code', 'npm-script:test@1:16/inline-code']],
    ['`PATH`', []],
    ['`NODE_ENV`', []],
    ['`NODE_ENV=production`', []],
    ['`$HOME`', []],
    ['`$NODE_ENV`', []],
    ['`GITHUB_TOKEN`', []],
    ['`$npm_package_version`', []],
    ['`API`', []],
    ['`API2`', []],
    ['`_FOO`', []],
    ['`FOO_`', []],
    ['`Foo_Bar`', []],
    ['`$1 $@ $?`', []],
  ])('%s', (src, expected) => {
    expect(brief(index(src))).toEqual(expected);
  });
});

describe('inline code: commands', () => {
  it.each([
    ['`drift-ci --base main`', ['command:drift-ci@1:2/inline-code']],
    ['`sudo drift-ci --help`', ['command:drift-ci@1:7/inline-code']],
    ['`$ drift-ci --help`', ['command:drift-ci@1:4/inline-code']],
    ['`drift-ci run`', ['~command:drift-ci@1:2/inline-code']],
    ['`git status`', []],
    ['`git commit -m x`', []],
    ['`cd src`', []],
    ['`drift-ci`', []],
    ['`Foo --bar`', []],
    ['`./run.sh --x`', ['~path:run.sh@1:2/inline-code']],
  ])('%s', (src, expected) => {
    expect(brief(index(src))).toEqual(expected);
  });
});

describe('shell fences', () => {
  it('indexes commands, scripts and targets with line = fence line + 1 + i', () => {
    const src = doc('Intro', `${FENCE}sh`, 'npm run build', 'make test lint', FENCE);
    expect(brief(index(src))).toEqual([
      'npm-script:build@3:9/fence',
      'make-target:test@4:6/fence',
      'make-target:lint@4:11/fence',
    ]);
  });

  it('strips $ prompts', () => {
    expect(brief(index(fence('bash', '$ npm run build')))).toEqual(['npm-script:build@2:11/fence']);
  });

  it('treats only prompt lines as commands in a console fence', () => {
    const src = fence('console', '$ drift-ci --help', 'Usage: drift-ci [options]', 'npm run fake');
    expect(brief(index(src))).toEqual(['command:drift-ci@2:3/fence']);
  });

  it('treats a console fence without prompts as output', () => {
    expect(index(fence('console', 'npm run fake', 'make fake'))).toEqual([]);
  });

  it('indexes every line of a fence without a language', () => {
    expect(brief(index(fence('', 'npm test')))).toEqual(['npm-script:test@2:5/fence']);
  });

  it('switches to prompt-only mode when a fence without language has prompts', () => {
    expect(brief(index(fence('', '$ npm test', 'npm run fake')))).toEqual(['npm-script:test@2:7/fence']);
  });

  it('keeps prompt-only mode for a bash fence that mixes commands and output', () => {
    expect(brief(index(fence('bash', '$ npm run a', 'output npm run b')))).toEqual([
      'npm-script:a@2:11/fence',
    ]);
  });

  it('reads the language case-insensitively and ignores info-string attributes', () => {
    expect(brief(index(fence('bash title="x"', 'npm test')))).toEqual(['npm-script:test@2:5/fence']);
    expect(brief(index(fence('SH', 'npm test')))).toEqual(['npm-script:test@2:5/fence']);
    expect(brief(index(fence('zsh', 'npm test')))).toEqual(['npm-script:test@2:5/fence']);
    expect(brief(index(fence('shell', 'npm test')))).toEqual(['npm-script:test@2:5/fence']);
  });

  it('supports tilde and unclosed fences', () => {
    expect(brief(index(doc('~~~sh', 'make x', '~~~')))).toEqual(['make-target:x@2:6/fence']);
    expect(brief(index(doc(`${FENCE}sh`, 'npm run build')))).toEqual(['npm-script:build@2:9/fence']);
  });

  it('handles an empty fence', () => {
    expect(index(doc(FENCE, FENCE))).toEqual([]);
  });

  it('skips comments, whole-line and trailing', () => {
    const src = fence('sh', '# npm run nope', 'npm run yes # npm run nope2');
    expect(brief(index(src))).toEqual(['npm-script:yes@3:9/fence']);
  });

  it('does not parse quoted strings as commands', () => {
    expect(ofKind(index(fence('sh', 'echo "npm run quoted"; make "x y"')), 'npm-script')).toEqual([]);
    expect(ofKind(index(fence('sh', 'echo "npm run quoted"; make "x y"')), 'make-target')).toEqual([]);
  });

  it('indexes both commands of a chain', () => {
    expect(brief(index(fence('sh', 'npm run build && npm test')))).toEqual([
      'npm-script:build@2:9/fence',
      'npm-script:test@2:22/fence',
    ]);
  });

  it('finds a command after a pipe, a semicolon and a subshell opener', () => {
    const src = fence('sh', 'echo hi | drift-ci --stdin', 'true; drift-ci a', 'x=$(drift-ci b)');
    expect(brief(ofKind(index(src), 'command'))).toEqual([
      'command:drift-ci@2:11/fence',
      'command:drift-ci@3:7/fence',
      'command:drift-ci@4:5/fence',
    ]);
  });

  it('skips sudo and other wrappers, with their flags', () => {
    const src = fence(
      'sh',
      'sudo drift-ci install',
      'sudo -u bob drift-ci run',
      'git status',
      'env FOO_BAR=1 drift-ci',
      'curl -s https://x.io | bash',
      'nohup time drift-ci &',
    );
    expect(brief(ofKind(index(src), 'command'))).toEqual([
      'command:drift-ci@2:6/fence',
      'command:drift-ci@3:13/fence',
      'command:drift-ci@5:15/fence',
      'command:drift-ci@7:12/fence',
    ]);
    expect(brief(ofKind(index(src), 'env'))).toEqual(['env:FOO_BAR@5:5/fence']);
  });

  it('handles || chains, redirects and stray parentheses', () => {
    const src = fence(
      'sh',
      'npm run a || npm run b',
      'npm run c 2>&1 | tee out.log',
      'npm run d &> out.log',
      'npm run e > out.log 2> err.log',
      'echo a) && npm run f',
      'cat << EOF',
      'npm run inside',
      'EOF',
    );
    expect(ofKind(index(src), 'npm-script').map((r) => r.normalized)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(ofKind(index(src), 'path')).toEqual([]);
  });

  it('skips wrapper flags without values', () => {
    expect(brief(ofKind(index(fence('sh', 'env -i drift-ci')), 'command'))).toEqual(['command:drift-ci@2:8/fence']);
  });

  it('ignores a line that holds only a wrapper', () => {
    expect(index(fence('sh', 'sudo', 'sudo -u'))).toEqual([]);
  });

  it('does not take paths, flags or uppercase words for commands', () => {
    const src = fence('', './scripts/run.sh', '--silent', 'Done!', 'Error: x');
    expect(ofKind(index(src), 'command')).toEqual([]);
  });

  it('skips heredoc bodies', () => {
    const src = fence('sh', 'cat <<EOF > a.txt', 'npm run inside', 'EOF', 'npm run after');
    expect(brief(ofKind(index(src), 'npm-script'))).toEqual(['npm-script:after@5:9/fence']);
  });

  it('skips quoted heredoc tags and tab-stripped heredocs', () => {
    const src = fence('sh', "cat <<-'EOT'", 'npm run inside', 'EOT', 'npm run after');
    expect(brief(ofKind(index(src), 'npm-script'))).toEqual(['npm-script:after@5:9/fence']);
  });

  it('follows backslash continuations', () => {
    const src = fence('sh', 'npm run build \\', '  --silent $KEEP_ME', 'cd x && \\', 'npm test');
    const refs = index(src);
    expect(brief(ofKind(refs, 'npm-script'))).toEqual([
      'npm-script:build@2:9/fence',
      'npm-script:test@5:5/fence',
    ]);
    expect(ofKind(refs, 'npm-script')[1]?.context).toEqual({ packageManager: 'npm', cwd: 'x' });
    expect(brief(ofKind(refs, 'env'))).toEqual(['env:KEEP_ME@3:12/fence']);
    expect(ofKind(refs, 'command')).toEqual([]);
  });

  it('keeps prompt-only mode across continuation lines', () => {
    const src = fence('console', '$ npm run build \\', '  --silent', 'output');
    expect(brief(index(src))).toEqual(['npm-script:build@2:11/fence']);
  });

  it('accounts for blockquote and list prefixes in columns', () => {
    expect(brief(index(doc('> ```sh', '> npm run a', '> ```')))).toEqual(['npm-script:a@2:11/fence']);
    expect(brief(index(doc('- item', '  ```bash', '  make x', '  ```')))).toEqual([
      'make-target:x@3:8/fence',
    ]);
  });

  it('works inside a numbered list with deeper indentation', () => {
    expect(brief(index(doc('1. step', '', '   ```sh', '   npm test', '   ```')))).toEqual([
      'npm-script:test@4:8/fence',
    ]);
  });

  describe('cd context', () => {
    it('applies a preceding cd to the following lines', () => {
      const scripts = ofKind(index(fence('sh', 'cd web', 'npm run dev')), 'npm-script');
      expect(scripts[0]?.context).toEqual({ packageManager: 'npm', cwd: 'web' });
    });

    it('applies cd dir && command on the same line', () => {
      const makes = ofKind(index(fence('sh', 'cd web && make x')), 'make-target');
      expect(makes[0]?.context).toEqual({ cwd: 'web' });
    });

    it('limits a subshell cd to the subshell', () => {
      const scripts = ofKind(index(fence('sh', '(cd sub && npm test)', 'npm run top')), 'npm-script');
      expect(scripts.map((r) => [r.normalized, r.context?.cwd])).toEqual([
        ['test', 'sub'],
        ['top', undefined],
      ]);
    });

    it('chains relative cds, replaces on absolute ones and resets on a bare cd', () => {
      const src = fence(
        'sh',
        'cd a',
        'cd b',
        'npm test',
        'cd /abs',
        'npm run x',
        'cd ~/proj',
        'npm run h',
        'cd',
        'npm run y',
      );
      const scripts = ofKind(index(src), 'npm-script');
      expect(scripts.map((r) => [r.normalized, r.context?.cwd])).toEqual([
        ['test', 'a/b'],
        ['x', '/abs'],
        ['h', '~/proj'],
        ['y', undefined],
      ]);
    });

    it('normalises ./ and trailing slashes of a cd target', () => {
      const scripts = ofKind(index(fence('sh', 'cd ./web/', 'cd ./app/', 'npm test')), 'npm-script');
      expect(scripts[0]?.context?.cwd).toBe('web/app');
    });

    it('forgets the directory on cd - and keeps a variable as written', () => {
      const src = fence('sh', 'cd a', 'cd -', 'npm test', 'cd $DIR', 'npm run y');
      const scripts = ofKind(index(src), 'npm-script');
      expect(scripts.map((r) => r.context?.cwd)).toEqual([undefined, '$DIR']);
    });

    it('ignores cd . and normalizes ..', () => {
      const src = fence('sh', 'cd a', 'cd .', 'npm test', 'cd ..', 'npm run up');
      const scripts = ofKind(index(src), 'npm-script');
      expect(scripts.map((r) => r.context?.cwd)).toEqual(['a', undefined]);
    });

    it('does not carry the directory into the next fence', () => {
      const src = doc(fence('sh', 'cd web'), '', fence('sh', 'npm test'));
      expect(ofKind(index(src), 'npm-script')[0]?.context).toEqual({ packageManager: 'npm' });
    });
  });

  describe('env vars', () => {
    it('finds assignments, $X, ${X} and skips quoted, special and well-known ones', () => {
      const src = fence(
        'sh',
        'export FOO_BAR=1',
        'FOO_BAR=1 npm start',
        'echo "$FOO_BAR"',
        "echo '$NOPE_X'",
        'echo $HOME ${BAZ_QUX:-x} $1 $@',
        'foo=1',
      );
      expect(brief(index(src))).toEqual([
        'env:FOO_BAR@2:8/fence',
        'env:FOO_BAR@3:1/fence',
        'npm-script:start@3:15/fence',
        'env:FOO_BAR@4:7/fence',
        'env:BAZ_QUX@6:12/fence',
      ]);
    });

    it('does not read $ inside a comment', () => {
      expect(index(fence('sh', 'true # $COMMENTED_OUT'))).toEqual([]);
    });

    it('handles escaped dollars and escaped quotes', () => {
      expect(brief(index(fence('sh', 'echo \\$ESCAPED_X "a\\"$SEEN_X"')))).toEqual([
        'env:SEEN_X@2:22/fence',
      ]);
    });

    it('stays quiet about unterminated quotes', () => {
      expect(index(fence('sh', "echo 'unterminated $X_Y"))).toEqual([]);
    });
  });

  describe('dotenv fences', () => {
    it('indexes assignments and variables used in values', () => {
      const src = fence(
        'dotenv',
        '# comment',
        'FOO_BAR=1',
        'export BAZ_QUX="x"',
        'lower=1',
        'API_KEY=$OTHER_VAR',
        'not an assignment',
      );
      expect(brief(index(src))).toEqual([
        'env:FOO_BAR@3:1/fence',
        'env:BAZ_QUX@4:8/fence',
        'env:API_KEY@6:1/fence',
        'env:OTHER_VAR@6:9/fence',
      ]);
    });

    it('does not report well-known variables', () => {
      expect(index(fence('dotenv', 'NODE_ENV=production', 'CI=true'))).toEqual([]);
    });

    it('does not treat dotenv values as commands', () => {
      expect(brief(index(fence('dotenv', 'CMD_X=npm run build')))).toEqual(['env:CMD_X@2:1/fence']);
    });
  });

  describe('shadow references', () => {
    it('records path-like arguments of shell commands as shadow', () => {
      const src = fence(
        'sh',
        'cat src/a.ts',
        'node ./scripts/build.js --out dist/',
        './scripts/run.sh',
        'curl https://x.io/a/b.md',
        'cp -r a/ b > out.txt',
      );
      expect(brief(ofKind(index(src), 'path'))).toEqual([
        '~path:src/a.ts@2:5/fence',
        '~path:scripts/build.js@3:6/fence',
        '~path:dist/@3:31/fence',
        '~path:scripts/run.sh@4:1/fence',
        '~path:a/@6:7/fence',
      ]);
    });

    it('records paths of non-shell fences as shadow only', () => {
      const src = fence('js', "import x from './src/a.ts';", 'const p = "docs/a.md";', 'npm run nope', 'FOO_BAR=1');
      expect(brief(index(src))).toEqual(['~path:src/a.ts@2:16/fence', '~path:docs/a.md@3:12/fence']);
    });

    it('records paths in JSON and YAML fences as shadow', () => {
      expect(brief(index(fence('json', '{ "main": "dist/cli.js" }')))).toEqual([
        '~path:dist/cli.js@2:12/fence',
      ]);
      expect(brief(index(fence('yaml', 'run: scripts/ci.sh')))).toEqual(['~path:scripts/ci.sh@2:6/fence']);
    });

    it('marks everything from an indented code block as shadow', () => {
      const refs = index(doc('Text', '', '    npm run build', '    FOO_BAR=1 make x'));
      expect(brief(refs)).toEqual([
        '~npm-script:build@3:13/fence',
        '~env:FOO_BAR@4:5/fence',
        '~make-target:x@4:20/fence',
      ]);
      expect(refs.every((r) => r.shadow)).toBe(true);
    });
  });
});

describe('exported lists', () => {
  it('keeps the shell exclude list in one place', () => {
    const names = ['cd', 'echo', 'export', 'sudo', 'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node'];
    for (const name of [...names, 'make', 'curl', 'docker', 'ls', 'cat']) {
      expect(SHELL_COMMAND_EXCLUDE.has(name)).toBe(true);
    }
  });

  it('lists the built-in subcommands that are not scripts', () => {
    for (const name of ['install', 'add', 'remove', 'exec', 'dlx', 'create', 'init', 'publish']) {
      expect(PNPM_BUILTINS.has(name)).toBe(true);
      expect(YARN_BUILTINS.has(name)).toBe(true);
    }
    expect([...NPM_IMPLICIT_SCRIPTS.keys()].sort()).toEqual(['restart', 'start', 'stop', 't', 'test', 'tst']);
  });

  it('lists well-known environment variables', () => {
    for (const name of ['PATH', 'HOME', 'USER', 'PWD', 'SHELL', 'CI', 'NODE_ENV']) {
      expect(WELL_KNOWN_ENV_VARS.has(name)).toBe(true);
    }
    expect(WELL_KNOWN_ENV_PREFIXES).toContain('GITHUB_');
  });
});
