import { describe, expect, it } from 'vitest';
import { isIndexedDoc } from '../src/core/indexer.ts';

describe('isIndexedDoc', () => {
  it.each([
    'README.md',
    'readme.md',
    'README',
    'README.zh-CN.md',
    'README.markdown',
    'packages/a/README.md',
    'docs/a.md',
    'docs/x/y/z.md',
    'docs/README.md',
    'packages/a/docs/guide.md',
    'AGENTS.md',
    'CLAUDE.md',
    'packages/a/AGENTS.md',
    'packages/a/CLAUDE.md',
    '.cursorrules',
    'packages/a/.cursorrules',
    '.cursor/rules/style.mdc',
    '.github/copilot-instructions.md',
    // vendored code is excluded by the config layer, not here
    'node_modules/foo/README.md',
  ])('indexes %s', (path) => {
    expect(isIndexedDoc(path)).toBe(true);
  });

  it.each([
    'README.rst',
    'README.md.bak',
    'src/readme-utils.ts',
    'docs',
    'docs/',
    'docs/a.txt',
    'docs/a.mdx',
    'doc/a.md',
    'src/docs.md',
    'src/a.md',
    'CHANGELOG.md',
    'agents.md',
    'CLAUDE.local.md',
    '.cursor/rules/x.md',
    '.cursor/rules/sub/x.mdc',
    '.cursor/x.mdc',
    '.cursorrules.bak',
    '.github/copilot-instructions.txt',
    'packages/a/.github/copilot-instructions.md',
    '',
  ])('ignores %j', (path) => {
    expect(isIndexedDoc(path)).toBe(false);
  });
});
