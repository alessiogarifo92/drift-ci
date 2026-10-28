import { indexMarkdown } from '../src/core/indexer.ts';
import type { Reference, ReferenceKind } from '../src/core/reference.ts';

export const FENCE = '```';

/** Joins lines with LF: keeps multi-line fixtures readable. */
export function doc(...lines: string[]): string {
  return lines.join('\n');
}

export function index(
  content: string,
  options: { file?: string; repo?: { owner: string; name: string } } = {},
): Reference[] {
  const { file = 'README.md', repo } = options;
  return indexMarkdown(file, content, repo ? { repo } : undefined);
}

/** `~` marks a shadow reference: kind:normalized@line:col/source. */
export function brief(refs: Reference[]): string[] {
  return refs.map(
    (r) => `${r.shadow ? '~' : ''}${r.kind}:${r.normalized}@${r.line}:${r.col}/${r.source}`,
  );
}

export function ofKind(refs: Reference[], kind: ReferenceKind): Reference[] {
  return refs.filter((r) => r.kind === kind);
}

/** 1-indexed column of the first occurrence of `needle` plus `shift` characters. */
export function colOf(line: string, needle: string, shift = 0): number {
  const at = line.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not in ${line}`);
  return at + shift + 1;
}
