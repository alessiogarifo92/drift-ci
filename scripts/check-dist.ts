// Rebuilds dist/ and fails if it differs from what is committed, so a source
// change pushed without `npm run build` turns CI red.
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['scripts/build.ts'], { stdio: 'inherit' });
const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'dist'], {
  encoding: 'utf8',
});
if (changes.trim() !== '') {
  const message = "dist/ is stale. Run 'npm run build' and commit the result.";
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message);
  console.error(changes.trimEnd());
  process.exit(1);
}
console.log('dist/ is up to date.');
