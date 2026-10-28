// Make-target rule: a target reference in a head doc has drifted when a makefile in its scope defined the target
// in base and none does in head (docs/decisions.md, phase 3). Makefiles are only read, never run: `include`s are
// not followed, so the scope is a union of files, which keeps a target moved into an included `.mk` file unflagged.
import { posix } from 'node:path';
import type { Drift, Rule } from '../rules.ts';
import type { RepoSnapshot, SnapshotEntry } from '../snapshot.ts';
import { resolveCwdDir } from './packages.ts';

export interface MakeTarget {
  name: string;
  /** Recipe lines, trimmed and joined with `\n`; empty for a rule without recipe. */
  recipe: string;
}

const DIRECTIVE = /^(?:-?include|sinclude|ifn?eq|ifn?def|else|endif|export|unexport|vpath|undefine|override|private)\b/;
const DEFINE = /^(?:override\s+)?define\b/;
const ENDEF = /^endef\b/;

/** Physical lines joined across backslash continuations. */
function logicalLines(text: string): string[] {
  const physical = text.split(/\r?\n/);
  const result: string[] = [];
  for (let i = 0; i < physical.length; i++) {
    let line = physical[i] as string;
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < physical.length) {
      i++;
      line = `${line.slice(0, -1).trimEnd()} ${(physical[i] as string).replace(/^\s+/, '')}`;
    }
    result.push(line);
  }
  return result;
}

/** The line without its `#` comment (an escaped `\#` stays). */
function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '#') return line.slice(0, i);
  }
  return line;
}

/** Index of the `:` of a rule line, or -1 when the line is an assignment or has no rule colon. */
function ruleColon(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if ((c === '$' && (line[i + 1] === '(' || line[i + 1] === '{')) || (depth > 0 && (c === '(' || c === '{'))) {
      depth++;
      if (c === '$') i++;
    } else if (depth > 0 && (c === ')' || c === '}')) {
      depth--;
    } else if (depth === 0 && c === '=') {
      return -1; // `X = a:b`, `X ?= ..`, `X += ..`: an assignment, whatever follows
    } else if (depth === 0 && c === ':') {
      return /^::?:?=/.test(line.slice(i)) ? -1 : i;
    }
  }
  return -1;
}

function isTargetName(name: string): boolean {
  return name !== '' && !name.startsWith('.') && !name.includes('%') && !name.includes('$(') && !name.includes('${');
}

/**
 * The targets a makefile defines. Recipe lines, comments, directives, assignments, `define` blocks, special
 * targets (`.PHONY`...), pattern rules and targets built from variables are skipped; `a b:` yields both.
 */
export function parseMakefile(text: string): MakeTarget[] {
  const targets: MakeTarget[] = [];
  let current: { names: string[]; recipe: string[] } | undefined;
  const finish = () => {
    if (current !== undefined) {
      const recipe = current.recipe.join('\n');
      for (const name of current.names) targets.push({ name, recipe });
    }
    current = undefined;
  };

  let defineDepth = 0;
  for (const line of logicalLines(text)) {
    const trimmed = line.trim();
    if (defineDepth > 0) {
      if (ENDEF.test(trimmed)) defineDepth--;
      else if (DEFINE.test(trimmed)) defineDepth++;
      continue;
    }
    if (line.startsWith('\t')) {
      if (current !== undefined && trimmed !== '') current.recipe.push(trimmed);
      continue;
    }
    const code = stripComment(line).trim();
    if (code === '') continue; // blank and comment lines do not end a recipe
    finish();
    if (DEFINE.test(code)) {
      defineDepth = 1;
      continue;
    }
    if (DIRECTIVE.test(code)) continue;
    const colon = ruleColon(code);
    if (colon < 0) continue;
    const names = code
      .slice(0, colon)
      .replace(/&$/, '') // a grouped target: `a b &: c`
      .split(/\s+/)
      .filter(isTargetName);
    if (names.length > 0) current = { names, recipe: [] };
  }
  finish();
  return targets;
}

interface MakeFile {
  path: string;
  targets: ReadonlyMap<string, string>;
  /** Files named by `include`, `-include` and `sinclude` lines, as written. */
  includes: readonly string[];
}

const INCLUDE = /^(?:-?include|sinclude)\s+(.*)$/;

/** The files the makefile includes, as written: `include a.mk b.mk` names two. */
function includedFiles(text: string): string[] {
  return logicalLines(text).flatMap((line) => {
    const match = INCLUDE.exec(stripComment(line).trim());
    return match?.[1] === undefined ? [] : match[1].split(/\s+/).filter((name) => name !== '');
  });
}

function isMakefile(entry: SnapshotEntry): boolean {
  if (entry.kind !== 'file') return false;
  const base = posix.basename(entry.path);
  return base === 'Makefile' || base === 'GNUmakefile' || base === 'makefile' || base.endsWith('.mk');
}

async function readMakefiles(snapshot: RepoSnapshot, files: readonly SnapshotEntry[]): Promise<MakeFile[]> {
  const paths = files.filter(isMakefile).map((e) => e.path);
  const contents = await snapshot.readFiles(paths);
  return paths.map((path) => ({
    path,
    targets: new Map(parseMakefile(contents.get(path) ?? '').map((t) => [t.name, t.recipe])),
    includes: includedFiles(contents.get(path) ?? ''),
  }));
}

/** The makefiles a reference may be about: everything under its cwd, else every makefile of the commit. */
function inScope(files: readonly MakeFile[], dir: string): MakeFile[] {
  return dir === '' ? [...files] : files.filter((f) => f.path.startsWith(`${dir}/`));
}

/** Whether the makefile includes a file this rule does not read (anything but another makefile it has). */
function hasUnreadInclude(file: MakeFile, makefiles: readonly MakeFile[]): boolean {
  return file.includes.some((name) => {
    const wanted = posix.normalize(name).replace(/^(?:\.\/)+/, '');
    return !makefiles.some((m) => m.path === wanted || m.path.endsWith(`/${wanted}`));
  });
}

/** Whether `make <name>` could build a file: `<dir>/<name>` exists, or a source such as `<name>.c` does (implicit rules). */
function buildableFile(paths: ReadonlySet<string>, dir: string, name: string): boolean {
  const prefix = dir === '' ? name : `${dir}/${name}`;
  if (paths.has(prefix)) return true;
  for (const path of paths) if (path.startsWith(`${prefix}.`) && !path.slice(prefix.length + 1).includes('/')) return true;
  return false;
}

/** The new name when the makefile that defined `name` lost exactly it and gained exactly one target with the same recipe. */
function renamedTo(before: MakeFile, after: MakeFile | undefined, name: string): string | undefined {
  if (after === undefined) return undefined;
  const removed = [...before.targets.keys()].filter((key) => !after.targets.has(key));
  const added = [...after.targets.keys()].filter((key) => !before.targets.has(key));
  if (removed.length !== 1 || removed[0] !== name || added.length !== 1) return undefined;
  const [newName] = added as [string];
  const recipe = before.targets.get(name) ?? '';
  return recipe !== '' && recipe === after.targets.get(newName) ? newName : undefined;
}

/**
 * Flags a make-target reference whose target is defined by a makefile of its scope in base and by none in head.
 * Scope: with a relative `cwd` (`make -C dir`, `cd dir`) every makefile under that directory, otherwise every
 * `Makefile`, `GNUmakefile` and `*.mk` of the commit. In scan mode a plain target name is flagged when the
 * scope has a makefile, none defines it, none includes a file this rule cannot read and no file of that name (or
 * `name.*` source) exists. A factory: the rule keeps its inventories for one run.
 */
export function makeTargetRule(): Rule {
  let state: { base: MakeFile[]; head: MakeFile[]; headPaths: ReadonlySet<string> } | undefined;

  return {
    id: 'make-target',
    kinds: ['make-target'],

    async prepare(ctx) {
      const [base, head] = await Promise.all([
        readMakefiles(ctx.base, ctx.baseFiles),
        readMakefiles(ctx.head, ctx.headFiles),
      ]);
      state = { base, head, headPaths: new Set(ctx.headFiles.map((e) => e.path)) };
    },

    check(ref, doc): Drift | undefined {
      if (state === undefined) throw new Error('makeTargetRule: prepare() must run before check()');

      const cwd = ref.context?.cwd;
      const dir = cwd === undefined ? '' : resolveCwdDir(doc.path, cwd);
      if (dir === undefined) return undefined; // a directory that cannot be placed in the repository

      const name = ref.normalized;
      const defined = inScope(state.base, dir).find((f) => f.targets.has(name));
      if (defined === undefined) return undefined; // never existed: not drift
      if (inScope(state.head, dir).some((f) => f.targets.has(name))) return undefined;

      const drift: Drift = { fact: `make:${name}`, message: `Make target \`${name}\` was removed in this change` };
      const newName = renamedTo(defined, state.head.find((f) => f.path === defined.path), name);
      if (newName !== undefined) {
        drift.message = `Make target \`${name}\` was renamed to \`${newName}\` in this change`;
        drift.suggestion = newName;
      }
      return drift;
    },

    scan(ref, doc): Drift | undefined {
      if (state === undefined) throw new Error('makeTargetRule: prepare() must run before scan()');

      const cwd = ref.context?.cwd;
      const dir = cwd === undefined ? '' : resolveCwdDir(doc.path, cwd);
      if (dir === undefined) return undefined;

      const name = ref.normalized;
      // `make main.o` may be built by a pattern rule (the parser skips those): only plain names are judged.
      if (/[./]/.test(name)) return undefined;
      const { head: makefiles, headPaths } = state;
      const scope = inScope(makefiles, dir);
      if (scope.length === 0 || scope.some((f) => f.targets.has(name))) return undefined;
      if (scope.some((f) => hasUnreadInclude(f, makefiles))) return undefined;
      if (buildableFile(headPaths, dir, name)) return undefined;
      return { fact: `make:${name}`, message: `Make target \`${name}\` does not exist at this commit` };
    },
  };
}
