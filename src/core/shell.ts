// A small, forgiving shell-line scanner: it finds the references a documented
// command line makes (package.json scripts, Make targets, env vars, binaries)
// without trying to be a shell. Anything it cannot read confidently is skipped.
import type { ReferenceContext, ReferenceKind } from './reference.ts';
import { isAssignedEnvName, isUsedEnvName, pathFromCode } from './shapes.ts';

/**
 * Shell builtins, shell keywords and very common tools: their first word is
 * never a project `bin`. Wrapper commands such as `sudo` are listed too; the
 * scanner skips them and looks at the next word.
 */
export const SHELL_COMMAND_EXCLUDE: ReadonlySet<string> = new Set([
  // builtins and keywords
  'cd', 'echo', 'export', 'set', 'unset', 'source', 'eval', 'exec', 'exit', 'return', 'read', 'printf',
  'test', 'true', 'false', 'alias', 'unalias', 'type', 'command', 'builtin', 'pwd', 'pushd', 'popd',
  'wait', 'trap', 'ulimit', 'umask', 'shift', 'local', 'readonly', 'declare', 'typeset', 'let',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function',
  // wrappers
  'sudo', 'doas', 'env', 'time', 'nohup', 'nice', 'xargs',
  // shells
  'sh', 'bash', 'zsh', 'fish', 'dash',
  // coreutils and friends
  'ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'head', 'tail', 'sort',
  'uniq', 'wc', 'cut', 'tr', 'tee', 'grep', 'egrep', 'fgrep', 'sed', 'awk', 'find', 'diff', 'patch', 'tar',
  'gzip', 'gunzip', 'zip', 'unzip', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'sleep', 'kill', 'ps', 'df', 'du',
  'date', 'which', 'whoami', 'uname', 'open', 'less', 'more', 'man', 'vi', 'vim', 'nano', 'code', 'clear',
  'history', 'jq', 'openssl', 'systemctl', 'service', 'tree', 'file', 'stat', 'basename', 'dirname',
  // developer tools
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'node', 'deno', 'make', 'gmake', 'cmake',
  'python', 'python3', 'pip', 'pip3', 'pipx', 'ruby', 'gem', 'bundle', 'go', 'cargo', 'rustc', 'rustup',
  'java', 'javac', 'mvn', 'gradle', 'dotnet', 'php', 'composer', 'docker', 'docker-compose', 'podman',
  'kubectl', 'helm', 'terraform', 'brew', 'apt', 'apt-get', 'apk', 'yum', 'dnf', 'pacman',
]);

/** Commands that run another command: skipped, along with their flags. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'env', 'time', 'nohup', 'exec', 'command', 'nice', 'export', 'readonly',
]);

/** `sudo` flags that take a value. */
const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U']);

/** `npm test` & co. run the script of that name: alias -> script. */
export const NPM_IMPLICIT_SCRIPTS: ReadonlyMap<string, string> = new Map([
  ['test', 'test'],
  ['t', 'test'],
  ['tst', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['restart', 'restart'],
]);

/*
 * Built-in subcommands that are NOT package.json scripts. npm and bun need no
 * list: only `npm run`/`npm test`-style forms and `bun run` are scripts there.
 */
export const PNPM_BUILTINS: ReadonlySet<string> = new Set([
  'add', 'install', 'i', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'link', 'ln', 'unlink',
  'import', 'install-test', 'it', 'ci', 'dedupe', 'fetch', 'prune', 'rebuild', 'rb', 'store', 'exec', 'dlx',
  'create', 'init', 'publish', 'pack', 'deploy', 'outdated', 'list', 'ls', 'll', 'la', 'why', 'audit',
  'licenses', 'config', 'c', 'set', 'get', 'root', 'bin', 'env', 'setup', 'self-update', 'patch',
  'patch-commit', 'patch-remove', 'approve-builds', 'doctor', 'server', 'recursive', 'multi', 'm', 'help',
  'version', 'view', 'info', 'show', 'login', 'logout', 'whoami', 'cache', 'sbom', 'catalog',
]);

export const YARN_BUILTINS: ReadonlySet<string> = new Set([
  'add', 'install', 'remove', 'upgrade', 'up', 'upgrade-interactive', 'init', 'publish', 'pack', 'link', 'unlink',
  'global', 'cache', 'config', 'list', 'ls', 'info', 'why', 'audit', 'outdated', 'import', 'check', 'autoclean',
  'licenses', 'login', 'logout', 'owner', 'team', 'tag', 'version', 'versions', 'access', 'exec', 'dlx',
  'create', 'workspaces', 'plugin', 'set', 'node', 'unplug', 'patch', 'rebuild', 'bin', 'constraints',
  'dedupe', 'explain', 'npm', 'help', 'policies', 'search', 'workspace', 'run',
]);

export interface ShellHit {
  kind: ReferenceKind;
  normalized: string;
  /** Offset of the reference token in the scanned text. */
  offset: number;
  shadow: boolean;
  context?: ReferenceContext;
}

export interface ShellState {
  /** Working directory set by `cd`, raw as written. Carried from line to line. */
  cwd: string | undefined;
}

export interface ShellScan {
  hits: ShellHit[];
  /** What the next line is when this one continues: more arguments, or a new command. */
  next: 'none' | 'args' | 'start';
  /** Tag of a heredoc opened on this line: its body is not shell. */
  heredoc: string | undefined;
}

type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface Word {
  value: string;
  /** Offset of the first character inside any opening quote. */
  start: number;
  /** Offset where the word begins, quote included. */
  rawStart: number;
  raw: string;
}

type Token = { type: 'word'; word: Word } | { type: 'op'; op: string };

const OPERATOR_CHARS = new Set([';', '|', '&', '(', ')']);
const SCRIPT_NAME = /^\w[\w:.-]*$/;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|sh|py)$/;
const MAKE_TARGET = /^\w[\w./+-]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9._+-]*$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const DOLLAR_VAR = /\$(?:\{([A-Za-z_]\w*)(?=[}:\-=+?#%/^,@[])|([A-Za-z_]\w*))/g;

const PM_WORKSPACE_FLAGS: Record<Manager, ReadonlySet<string>> = {
  npm: new Set(['-w', '--workspace']),
  pnpm: new Set(['-F', '--filter']),
  yarn: new Set(),
  bun: new Set(['--filter', '-F']),
};
const PM_DIR_FLAGS: Record<Manager, ReadonlySet<string>> = {
  npm: new Set(['--prefix']),
  pnpm: new Set(['-C', '--dir']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd']),
};
const PM_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--loglevel', '--registry', '--userconfig', '--cache', '--tag', '--otp', '--access', '--script-shell',
]);
const MAKE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '--old-file', '-W', '--what-if', '-l',
  '--load-average',
]);

/** Splits a line into words and operators; also reports the ranges `$VAR` must not be read from. */
function lex(text: string): { tokens: Token[]; skip: Array<[number, number]> } {
  const tokens: Token[] = [];
  const skip: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') {
      skip.push([i, n]);
      break;
    }
    if (c === '&' && text.charAt(i + 1) === '&') {
      tokens.push({ type: 'op', op: '&&' });
      i += 2;
      continue;
    }
    if (c === '|' && text.charAt(i + 1) === '|') {
      tokens.push({ type: 'op', op: '||' });
      i += 2;
      continue;
    }
    if (OPERATOR_CHARS.has(c) && !(c === '&' && text.charAt(i + 1) === '>')) {
      tokens.push({ type: 'op', op: c });
      i++;
      continue;
    }
    const rawStart = i;
    const quotedStart = c === '"' || c === "'";
    let value = '';
    let j = i;
    while (j < n) {
      const ch = text.charAt(j);
      if (ch === '\\') {
        skip.push([j + 1, j + 2]);
        value += text.charAt(j + 1);
        j += 2;
      } else if (ch === "'") {
        const close = text.indexOf("'", j + 1);
        const end = close < 0 ? n : close;
        skip.push([j, close < 0 ? n : close + 1]);
        value += text.slice(j + 1, end);
        j = close < 0 ? n : close + 1;
      } else if (ch === '"') {
        j++;
        while (j < n && text.charAt(j) !== '"') {
          if (text.charAt(j) === '\\') {
            skip.push([j + 1, j + 2]);
            j++;
          }
          value += text.charAt(j);
          j++;
        }
        j++;
      } else if (ch === ' ' || ch === '\t' || (OPERATOR_CHARS.has(ch) && !isRedirectAmpersand(text, j))) {
        break;
      } else {
        value += ch;
        j++;
      }
    }
    const end = Math.min(j, n);
    tokens.push({
      type: 'word',
      word: { value, start: quotedStart ? rawStart + 1 : rawStart, rawStart, raw: text.slice(rawStart, end) },
    });
    i = end;
  }
  return { tokens, skip };
}

/** The `&` of `2>&1` or `&>file` belongs to the redirect, not to a background operator. */
function isRedirectAmpersand(text: string, at: number): boolean {
  if (text.charAt(at) !== '&') return false;
  const prev = text.charAt(at - 1);
  return prev === '>' || prev === '<' || text.charAt(at + 1) === '>';
}

function joinCwd(base: string | undefined, dir: string): string | undefined {
  const trimmed = stripCwd(dir);
  if (trimmed === '') return base;
  if (/^[/~$]/.test(trimmed) || base === undefined) return trimmed;
  return `${base}/${trimmed}`;
}

function stripCwd(dir: string): string {
  let out = dir;
  while (out.startsWith('./')) out = out.slice(2);
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out === '.' ? '' : out;
}

/** Splits a flag written `--name=value`. */
function splitFlag(flag: string): [string, string | undefined] {
  const eq = flag.indexOf('=');
  return eq > 0 ? [flag.slice(0, eq), flag.slice(eq + 1)] : [flag, undefined];
}

function dollarHits(text: string, skip: Array<[number, number]>, from = 0): ShellHit[] {
  const hits: ShellHit[] = [];
  for (const match of text.matchAll(DOLLAR_VAR)) {
    const name = match[1] ?? match[2];
    if (name === undefined || match.index < from || !isUsedEnvName(name)) continue;
    if (skip.some(([a, b]) => match.index >= a && match.index < b)) continue;
    hits.push({ kind: 'env', normalized: name, offset: match.index, shadow: false });
  }
  return hits;
}

/** `$NAME` / `${NAME}` references in a value; used for dotenv lines. */
export function envVarsIn(text: string, from: number): ShellHit[] {
  return dollarHits(text, [], from);
}

function dropRedirects(words: Word[]): { words: Word[]; heredoc: string | undefined } {
  const kept: Word[] = [];
  let heredoc: string | undefined;
  for (let k = 0; k < words.length; k++) {
    const word = words[k] as Word;
    if (!/^(?:\d*[<>]|&>)/.test(word.raw)) {
      kept.push(word);
      continue;
    }
    const alone = /^(?:\d*[<>]+&?-?|&>>?)$/.test(word.raw);
    if (word.raw.startsWith('<<') && !word.raw.startsWith('<<<')) {
      const attached = word.raw.slice(2).replace(/^-/, '').replace(/^(["'])(.*)\1$/, '$2');
      heredoc = attached !== '' ? attached : words[k + 1]?.value;
    }
    if (alone) k++;
  }
  return { words: kept, heredoc };
}

function packageManagerHits(manager: Manager, words: Word[], state: ShellState): ShellHit[] {
  const positionals: Word[] = [];
  let workspace: string | undefined;
  let dir: string | undefined;
  for (let k = 0; k < words.length; k++) {
    const word = words[k] as Word;
    if (word.value === '--') break;
    if (!word.value.startsWith('-')) {
      positionals.push(word);
      continue;
    }
    const [flag, inline] = splitFlag(word.value);
    const takesValue =
      PM_WORKSPACE_FLAGS[manager].has(flag) || PM_DIR_FLAGS[manager].has(flag) || PM_VALUE_FLAGS.has(flag);
    if (!takesValue) continue;
    let value = inline;
    if (value === undefined) {
      value = words[k + 1]?.value;
      k++;
    }
    if (value === undefined) continue;
    if (PM_WORKSPACE_FLAGS[manager].has(flag)) workspace = value;
    else if (PM_DIR_FLAGS[manager].has(flag)) dir = value;
  }

  let rest = positionals;
  if (manager === 'yarn' && positionals[0]?.value === 'workspace') {
    workspace = positionals[1]?.value;
    rest = positionals.slice(2);
  }
  const script = pickScript(manager, rest);
  if (!script) return [];

  const context: ReferenceContext = { packageManager: manager };
  if (workspace !== undefined) context.workspace = workspace;
  const cwd = dir !== undefined ? joinCwd(state.cwd, dir) : state.cwd;
  if (cwd !== undefined) context.cwd = cwd;
  return [{ kind: 'npm-script', normalized: script.name, offset: script.start, shadow: false, context }];
}

const RUN_SUBCOMMANDS: Record<Manager, ReadonlySet<string>> = {
  npm: new Set(['run', 'run-script', 'rum', 'urun']),
  pnpm: new Set(['run', 'run-script']),
  yarn: new Set(['run']),
  bun: new Set(['run']),
};

function pickScript(manager: Manager, positionals: Word[]): { name: string; start: number } | undefined {
  const sub = positionals[0];
  if (!sub) return undefined;
  let word: Word | undefined;
  let name: string | undefined;
  if (RUN_SUBCOMMANDS[manager].has(sub.value)) {
    word = positionals[1];
    name = word?.value;
  } else if (manager === 'npm') {
    word = sub;
    name = NPM_IMPLICIT_SCRIPTS.get(sub.value);
  } else if (
    (manager === 'pnpm' && !PNPM_BUILTINS.has(sub.value)) ||
    (manager === 'yarn' && !YARN_BUILTINS.has(sub.value))
  ) {
    word = sub;
    name = sub.value;
  }
  if (!word || name === undefined || !SCRIPT_NAME.test(name) || SCRIPT_FILE.test(name)) return undefined;
  return { name, start: word.start };
}

function makeHits(words: Word[], state: ShellState): ShellHit[] {
  const targets: Word[] = [];
  let dir: string | undefined;
  for (let k = 0; k < words.length; k++) {
    const word = words[k] as Word;
    const value = word.value;
    if (value.startsWith('-')) {
      const [flag, inline] = splitFlag(value);
      if (flag === '-C' || flag === '--directory') {
        dir = inline ?? words[k + 1]?.value;
        if (inline === undefined) k++;
      } else if (value.startsWith('-C') && !value.startsWith('--')) {
        dir = value.slice(2);
      } else if (MAKE_VALUE_FLAGS.has(flag)) {
        if (inline === undefined) k++;
      } else if ((flag === '-j' || flag === '--jobs') && inline === undefined && /^\d+$/.test(words[k + 1]?.value ?? '')) {
        k++;
      }
    } else if (!/^[\w.]+[:+?]?=/.test(value) && MAKE_TARGET.test(value)) {
      targets.push(word);
    }
  }
  const cwd = dir !== undefined ? joinCwd(state.cwd, dir) : state.cwd;
  return targets.map((word) => {
    const hit: ShellHit = { kind: 'make-target', normalized: word.value, offset: word.start, shadow: false };
    if (cwd !== undefined) hit.context = { cwd };
    return hit;
  });
}

function pathHit(word: Word): ShellHit | undefined {
  const shape = pathFromCode(word.value);
  return shape ? { kind: 'path', normalized: shape.normalized, offset: word.start, shadow: true } : undefined;
}

/** Applies one `cd` to the state: relative directories chain, absolute and variable ones replace. */
function applyCd(words: Word[], state: ShellState): void {
  const args = words.filter((w) => w.value === '-' || !w.value.startsWith('-'));
  const dir = args[0]?.value;
  state.cwd = dir === undefined || dir === '-' ? undefined : joinCwd(state.cwd, dir);
}

function segmentHits(words: Word[], state: ShellState, inline: boolean): ShellHit[] {
  const hits: ShellHit[] = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i] as Word;
    const assignment = ASSIGNMENT.exec(word.raw);
    if (assignment) {
      const name = assignment[1] as string;
      if (isAssignedEnvName(name)) hits.push({ kind: 'env', normalized: name, offset: word.rawStart, shadow: false });
      i++;
    } else if (WRAPPERS.has(word.value)) {
      const sudoLike = word.value === 'sudo' || word.value === 'doas';
      i++;
      while (i < words.length && (words[i] as Word).value.startsWith('-')) {
        i += sudoLike && SUDO_VALUE_FLAGS.has((words[i] as Word).value) ? 2 : 1;
      }
    } else {
      break;
    }
  }
  const first = words[i];
  if (!first) return hits;
  const args = words.slice(i + 1);
  const name = first.value;

  if (name === 'cd') {
    applyCd(args, state);
    return hits;
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return [...hits, ...packageManagerHits(name, args, state)];
  }
  if (name === 'make' || name === 'gmake') return [...hits, ...makeHits(args, state)];

  if (/^(?:\.{1,2})?\//.test(name)) {
    // Run by path (`./scripts/run.sh`): a path, never a bin name.
    const own = pathHit(first);
    if (own) hits.push(own);
  } else if (COMMAND_NAME.test(name) && !SHELL_COMMAND_EXCLUDE.has(name)) {
    if (!inline) {
      hits.push({ kind: 'command', normalized: name, offset: first.start, shadow: false });
    } else if (args.length > 0) {
      const flagged = (args[0] as Word).value.startsWith('-');
      hits.push({ kind: 'command', normalized: name, offset: first.start, shadow: !flagged });
    }
  }
  for (const arg of args) {
    const hit = pathHit(arg);
    if (hit) hits.push(hit);
  }
  return hits;
}

/**
 * Scans one line of shell. `mode: 'args'` marks a continuation line (the
 * previous one ended with a backslash): only `$VAR` uses are read from it.
 */
export function scanShellLine(
  text: string,
  state: ShellState,
  options: { mode: 'command' | 'args'; inline: boolean },
): ShellScan {
  const { tokens, skip } = lex(text);
  const hits = dollarHits(text, skip);
  const allWords = tokens.flatMap((t) => (t.type === 'word' ? [t.word] : []));
  const { heredoc } = dropRedirects(allWords);

  if (options.mode === 'command') {
    let segment: Word[] = [];
    const cwdStack: Array<string | undefined> = [];
    const flush = () => {
      hits.push(...segmentHits(dropRedirects(segment).words, state, options.inline));
      segment = [];
    };
    for (const token of tokens) {
      if (token.type === 'word') {
        segment.push(token.word);
        continue;
      }
      flush();
      if (token.op === '(') cwdStack.push(state.cwd);
      else if (token.op === ')' && cwdStack.length > 0) state.cwd = cwdStack.pop();
    }
    flush();
  }

  return { hits, next: continuation(text), heredoc };
}

function continuation(text: string): ShellScan['next'] {
  const trimmed = text.trimEnd();
  const backslashes = trimmed.length - trimmed.replace(/\\+$/, '').length;
  const body = backslashes % 2 === 1 ? trimmed.slice(0, -1).trimEnd() : trimmed;
  const endsWithOperator = /(?:&&|\|\||\|)$/.test(body);
  if (endsWithOperator) return 'start';
  return backslashes % 2 === 1 ? 'args' : 'none';
}
