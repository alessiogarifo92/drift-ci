// ReferenceIndexer: extracts, from the text of a Markdown-ish doc, the things it
// says about the repository (paths, npm scripts, Make targets, env vars, bins).
// Strings in, references out: it never reads files (src/core stays pure).
// Resolution against repo contents belongs to the Matcher (docs/decisions.md, phase 3).
import type { Code, Definition, Image, InlineCode, Link, Nodes, Root, Text } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Reference, ReferenceContext, ReferenceKind, ReferenceSource } from './reference.ts';
import { envVarsIn, scanShellLine, type ShellHit, type ShellState } from './shell.ts';
import { isAssignedEnvName, isBareEnvName, pathFromCode, pathFromText, pathFromUrl } from './shapes.ts';

export interface IndexOptions {
  /** The repository the doc lives in: lets same-repo github.com URLs count as paths. */
  repo?: { owner: string; name: string };
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

const README = /^readme(?:\.[\w-]+)?\.(?:md|markdown|mdx|txt)$|^readme$/i;

/**
 * Whether a repo-relative POSIX path is a doc worth indexing: `README*` at any
 * depth (monorepo packages), `*.md` under a `docs/` directory at any depth,
 * `AGENTS.md` / `CLAUDE.md` / `.cursorrules` at any depth (nested ones are read
 * by the tools too), `.cursor/rules/*.mdc` and `.github/copilot-instructions.md`.
 * Vendored or generated docs are excluded by the config layer, not here.
 */
export function isIndexedDoc(path: string): boolean {
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';
  const dirs = segments.slice(0, -1);
  if (name === '') return false;
  if (README.test(name)) return true;
  if (name === 'AGENTS.md' || name === 'CLAUDE.md' || name === '.cursorrules') return true;
  if (/\.md$/i.test(name) && dirs.includes('docs')) return true;
  if (name.endsWith('.mdc') && dirs.length >= 2 && dirs.slice(-2).join('/') === '.cursor/rules') return true;
  return path === '.github/copilot-instructions.md';
}

/** A run of source text on one line, with the 1-indexed column of its first character. */
interface Segment {
  text: string;
  line: number;
  col: number;
}

interface Walk {
  /** Inside a link label: plain text there is the label, not a reference. */
  inLink: boolean;
  /** Paths the enclosing link already reports: inline code repeating one is skipped. */
  linkPaths: ReadonlySet<string> | undefined;
}

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'console', 'zsh', '']);

export function indexMarkdown(file: string, content: string, options: IndexOptions = {}): Reference[] {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const tree: Root = processor.parse(lines.join('\n'));
  const found = new Map<string, Reference>();

  function add(
    kind: ReferenceKind,
    normalized: string,
    seg: Segment,
    offset: number,
    source: ReferenceSource,
    shadow: boolean,
    context?: ReferenceContext,
  ): void {
    const ref: Reference = {
      kind,
      normalized,
      file,
      line: seg.line,
      col: seg.col + offset,
      source,
      contextLine: lines[seg.line - 1] ?? '',
      shadow,
    };
    if (context) ref.context = context;
    const key = `${kind}\0${normalized}\0${ref.line}\0${ref.col}`;
    // Never two references for the same kind, name and position.
    if (!found.has(key)) found.set(key, ref);
  }

  function addShell(hits: ShellHit[], seg: Segment, shift: number, source: ReferenceSource, forceShadow: boolean) {
    for (const hit of hits) {
      add(hit.kind, hit.normalized, seg, shift + hit.offset, source, hit.shadow || forceShadow, hit.context);
    }
  }

  /** The source of a node, one segment per line. */
  function segmentsOf(node: Nodes): Segment[] {
    const pos = node.position;
    if (!pos) return [];
    const out: Segment[] = [];
    for (let ln = pos.start.line; ln <= pos.end.line; ln++) {
      const line = lines[ln - 1] ?? '';
      const from = ln === pos.start.line ? pos.start.column - 1 : 0;
      const to = ln === pos.end.line ? pos.end.column - 1 : line.length;
      out.push({ text: line.slice(from, to), line: ln, col: from + 1 });
    }
    return out;
  }

  function indexUrl(node: Link | Image | Definition, source: ReferenceSource): string | undefined {
    const shape = pathFromUrl(node.url, options.repo);
    if (!shape) return undefined;
    const segs = segmentsOf(node);
    const where = locateUrl(segs, node.url, node.type === 'definition');
    add('path', shape.normalized, where.seg, where.offset, source, shape.shadow);
    return shape.normalized;
  }

  function indexInlineCode(node: InlineCode, ctx: Walk): void {
    const pos = node.position;
    if (!pos || pos.start.line !== pos.end.line) return;
    const raw = (lines[pos.start.line - 1] ?? '').slice(pos.start.column - 1, pos.end.column - 1);
    const ticks = /^`+/.exec(raw)?.[0].length ?? 0;
    let inner = raw.slice(ticks, raw.length - ticks);
    let shift = ticks;
    if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
      inner = inner.slice(1, -1);
      shift++;
    }
    shift += inner.length - inner.trimStart().length;
    let text = inner.trim();
    if (text.startsWith('$ ')) {
      shift += 2;
      text = text.slice(2).trimStart();
    }
    const seg: Segment = { text, line: pos.start.line, col: pos.start.column + shift };
    if (text === '') return;

    if (!/\s/.test(text)) {
      if (isBareEnvName(text)) {
        add('env', text, seg, 0, 'inline-code', false);
        return;
      }
      if (!/[$=]/.test(text)) {
        const shape = pathFromCode(text);
        if (shape && !ctx.linkPaths?.has(shape.normalized)) {
          add('path', shape.normalized, seg, 0, 'inline-code', shape.shadow);
        }
        return;
      }
    }
    const scan = scanShellLine(text, { cwd: undefined }, { mode: 'command', inline: true });
    const hits = scan.hits.filter((h) => !(h.kind === 'path' && ctx.linkPaths?.has(h.normalized)));
    addShell(hits, seg, 0, 'inline-code', false);
  }

  function indexCode(node: Code): void {
    const pos = node.position;
    if (!pos) return;
    const startLine = pos.start.line;
    const opening = (lines[startLine - 1] ?? '').slice(pos.start.column - 1);
    const fenced = /^(?:`{3,}|~{3,})/.test(opening);
    // Fenced content starts on the line after the fence; indented code on the first line.
    const firstLine = fenced ? startLine + 1 : startLine;
    const lang = fenced ? (node.lang ?? '').toLowerCase() : '';
    const body = node.value.split('\n');
    const segs: Segment[] = body.map((text, i) => {
      const raw = lines[firstLine - 1 + i] ?? '';
      const at = raw.endsWith(text) ? raw.length - text.length : Math.max(raw.indexOf(text), 0);
      return { text, line: firstLine + i, col: at + 1 };
    });

    if (lang === 'dotenv') indexDotenv(segs);
    else if (SHELL_LANGS.has(lang)) indexShell(segs, lang === 'console', !fenced);
    else indexOtherFence(segs);
  }

  function indexShell(segs: Segment[], consoleLang: boolean, forceShadow: boolean): void {
    const promptOnly = consoleLang || segs.some((s) => /^\s*\$ /.test(s.text));
    const state: ShellState = { cwd: undefined };
    let next: 'none' | 'args' | 'start' = 'none';
    let heredoc: string | undefined;
    for (const seg of segs) {
      if (heredoc !== undefined) {
        if (seg.text.trim() === heredoc) heredoc = undefined;
        continue;
      }
      let text = seg.text;
      let shift = 0;
      const prompt = /^(\s*)\$ /.exec(text);
      if (prompt) {
        shift = prompt[0].length;
        text = text.slice(shift);
      } else if (promptOnly && next === 'none') {
        continue;
      }
      const scan = scanShellLine(text, state, { mode: next === 'args' ? 'args' : 'command', inline: false });
      addShell(scan.hits, seg, shift, 'fence', forceShadow);
      next = scan.next;
      heredoc = scan.heredoc;
    }
  }

  function indexDotenv(segs: Segment[]): void {
    for (const seg of segs) {
      const match = /^(\s*(?:export\s+)?)([A-Za-z_]\w*)=/.exec(seg.text);
      if (!match) continue;
      const name = match[2] as string;
      if (isAssignedEnvName(name)) add('env', name, seg, (match[1] as string).length, 'fence', false);
      addShell(envVarsIn(seg.text, match[0].length), seg, 0, 'fence', false);
    }
  }

  /** Code in other languages: path-like tokens are recorded as shadow, nothing else. */
  function indexOtherFence(segs: Segment[]): void {
    for (const seg of segs) {
      for (const match of seg.text.matchAll(/[^\s"'`,;()[\]{}<>=|]+/g)) {
        const shape = pathFromCode(match[0]);
        if (shape) add('path', shape.normalized, seg, match.index, 'fence', true);
      }
    }
  }

  function indexText(node: Text): void {
    for (const seg of segmentsOf(node)) {
      for (const match of seg.text.matchAll(/\S+/g)) {
        const token = trimPunctuation(match[0]);
        if (token.text === '') continue;
        const offset = match.index + token.lead;
        if (isBareEnvName(token.text)) {
          add('env', token.text, seg, offset, 'text', false);
          continue;
        }
        const shape = pathFromText(token.text);
        if (shape) add('path', shape.normalized, seg, offset, 'text', shape.shadow);
      }
    }
  }

  function walk(node: Nodes, ctx: Walk): void {
    switch (node.type) {
      case 'link': {
        const reported = indexUrl(node, 'link');
        const linkPaths = reported === undefined ? ctx.linkPaths : new Set([...(ctx.linkPaths ?? []), reported]);
        for (const child of node.children) walk(child, { inLink: true, linkPaths });
        return;
      }
      case 'image':
        indexUrl(node, 'image');
        return;
      case 'definition':
        indexUrl(node, 'definition');
        return;
      case 'inlineCode':
        indexInlineCode(node, ctx);
        return;
      case 'code':
        indexCode(node);
        return;
      case 'text':
        if (!ctx.inLink) indexText(node);
        return;
      default:
        if ('children' in node) for (const child of node.children) walk(child, ctx);
    }
  }

  walk(tree, { inLink: false, linkPaths: undefined });
  return [...found.values()].sort((a, b) => a.line - b.line || a.col - b.col);
}

/** Where the URL of a link, image or definition sits in its source, or its start if it cannot be found. */
function locateUrl(segs: Segment[], url: string, definition: boolean): { seg: Segment; offset: number } {
  for (let k = segs.length - 1; k >= 0; k--) {
    const seg = segs[k] as Segment;
    const from = definition && k === 0 ? Math.max(seg.text.indexOf(']:') + 2, 0) : 0;
    const at = definition ? seg.text.indexOf(url, from) : seg.text.lastIndexOf(url);
    if (url !== '' && at >= 0) return { seg, offset: at };
  }
  const first = segs[0] ?? { text: '', line: 1, col: 1 };
  const label = first.text.startsWith('![') ? 2 : first.text.startsWith('[') && !definition ? 1 : 0;
  return { seg: first, offset: label };
}

const LEADING_PUNCTUATION = /^[([{"'“‘<]+/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"'”’>…]+$/;

function trimPunctuation(raw: string): { text: string; lead: number } {
  const lead = LEADING_PUNCTUATION.exec(raw)?.[0].length ?? 0;
  return { text: raw.slice(lead).replace(TRAILING_PUNCTUATION, ''), lead };
}
