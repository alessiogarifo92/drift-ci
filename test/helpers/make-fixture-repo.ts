// Manual helper: materialise a fixture as a real repository to point the CLI at.
//   npm run fixture -- <case> [parent-dir]
import { createFixtureRepo } from './fixture-repo.ts';

const [caseName, parentDir] = process.argv.slice(2);
if (!caseName) {
  console.error('usage: npm run fixture -- <case> [parent-dir]');
  process.exit(2);
}
const repo = createFixtureRepo(caseName, parentDir ? { parentDir } : {});
console.log(repo.dir);
