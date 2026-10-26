import { afterAll, describe, expect, it } from 'vitest';
import { parseGitHubRemote, readRepoSlug } from '../src/git/remote.ts';
import { createFixtureRepo } from './helpers/fixture-repo.ts';

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/acme/demo.git'],
    ['https://github.com/acme/demo'],
    ['https://github.com/acme/demo/'],
    ['https://x-access-token:abc@github.com/acme/demo.git'],
    ['http://github.com/acme/demo.git'],
    ['git://github.com/acme/demo.git'],
    ['git@github.com:acme/demo.git'],
    ['git@github.com:acme/demo'],
    ['ssh://git@github.com/acme/demo.git'],
    ['ssh://git@github.com:22/acme/demo.git'],
    ['HTTPS://GitHub.com/acme/demo.git'],
  ])('reads owner and name from %s', (url) => {
    expect(parseGitHubRemote(url)).toEqual({ owner: 'acme', name: 'demo' });
  });

  it('keeps dots in the repository name', () => {
    expect(parseGitHubRemote('https://github.com/acme/demo.js.git')).toEqual({ owner: 'acme', name: 'demo.js' });
  });

  it.each([
    [''],
    ['not a url'],
    ['https://gitlab.com/acme/demo.git'],
    ['https://github.com.evil.example/acme/demo.git'],
    ['git@gitlab.com:acme/demo.git'],
    ['https://github.com/acme'],
    ['https://github.com/acme/demo/extra'],
    ['/srv/git/demo.git'],
  ])('returns nothing for %j', (url) => {
    expect(parseGitHubRemote(url)).toBeUndefined();
  });
});

describe('readRepoSlug', () => {
  const repos: { cleanup: () => void }[] = [];
  afterAll(() => repos.forEach((r) => r.cleanup()));

  it('reads the origin remote', async () => {
    const repo = createFixtureRepo('sample');
    repos.push(repo);
    repo.git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    expect(await readRepoSlug(repo.dir)).toEqual({ owner: 'acme', name: 'demo' });
  });

  it('returns nothing, without failing, when there is no origin', async () => {
    const repo = createFixtureRepo('sample');
    repos.push(repo);
    expect(await readRepoSlug(repo.dir)).toBeUndefined();
  });

  it('returns nothing when origin is not on GitHub', async () => {
    const repo = createFixtureRepo('sample');
    repos.push(repo);
    repo.git('remote', 'add', 'origin', 'https://example.com/acme/demo.git');
    expect(await readRepoSlug(repo.dir)).toBeUndefined();
  });

  it('returns nothing when the directory is not a repository', async () => {
    expect(await readRepoSlug('/nonexistent-drift-ci-dir')).toBeUndefined();
  });
});
