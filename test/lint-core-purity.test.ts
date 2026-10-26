import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });

async function restrictedImports(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('src/core purity lint rule', () => {
  it.each([
    "import { readFileSync } from 'node:fs';",
    "import { readFileSync } from 'fs';",
    "import { readFile } from 'node:fs/promises';",
    "import { execFileSync } from 'node:child_process';",
    "import { spawn } from 'child_process';",
    "export { readFileSync } from 'node:fs';",
  ])('rejects %s in src/core', async (code) => {
    const messages = await restrictedImports(code, 'src/core/example.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/core must stay pure/);
  });

  it('rejects @actions/* in src/core', async () => {
    const messages = await restrictedImports("import * as core from '@actions/core';", 'src/core/deep/x.ts');
    expect(messages).toEqual([expect.stringMatching(/must not depend on GitHub Actions/)]);
  });

  it('allows pure imports in src/core', async () => {
    expect(await restrictedImports("import { join } from 'node:path/posix';", 'src/core/example.ts')).toEqual([]);
  });

  it.each(['src/cli/example.ts', 'src/action/example.ts'])('allows I/O imports in %s', async (filePath) => {
    const code = "import { readFileSync } from 'node:fs';\nimport * as core from '@actions/core';";
    expect(await restrictedImports(code, filePath)).toEqual([]);
  });
});
