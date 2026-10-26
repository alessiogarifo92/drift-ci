// Bundles the CLI and the Action into dist/ and writes dist/licenses.txt.
// The output must be byte-identical for identical sources: CI rebuilds and
// fails when the committed dist/ differs (`npm run check:dist`).
import { build, type Metafile } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const result = await build({
  absWorkingDir: root,
  entryPoints: { cli: 'src/cli/index.ts', action: 'src/action/index.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Bundled CommonJS dependencies may call require() on Node built-ins.
  banner: {
    js: "import { createRequire as __driftCreateRequire } from 'node:module';\nconst require = __driftCreateRequire(import.meta.url);",
  },
  define: { __DRIFT_CI_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// The CLI is the package "bin": it needs a shebang on its first line.
const cliPath = join(dist, 'cli.js');
writeFileSync(cliPath, `#!/usr/bin/env node\n${readFileSync(cliPath, 'utf8')}`);
chmodSync(cliPath, 0o755);

writeFileSync(join(dist, 'licenses.txt'), licenseNotices(result.metafile));

/** Third-party notices for every npm package that ended up in the bundles. */
function licenseNotices(metafile: Metafile): string {
  const packageDirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match?.[1]) packageDirs.add(match[1]);
  }
  const entries = [...packageDirs]
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        license?: string;
      };
      const licenseFile = readdirSync(join(root, dir)).find((file) =>
        /^(licen[cs]e|copying)(\.|$)/i.test(file),
      );
      const text = licenseFile
        ? readFileSync(join(root, dir, licenseFile), 'utf8').trim()
        : '(no license file shipped with the package)';
      return { name: manifest.name, version: manifest.version, license: manifest.license, text };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const header =
    'Third-party software bundled in dist/ by drift-ci.\n' +
    'drift-ci itself is licensed under Apache-2.0 (see LICENSE).\n';
  if (entries.length === 0) return `${header}\nNo third-party packages are bundled.\n`;
  return (
    header +
    entries
      .map((e) => `\n${'='.repeat(72)}\n${e.name}@${e.version} (${e.license ?? 'UNKNOWN'})\n\n${e.text}\n`)
      .join('')
  );
}
