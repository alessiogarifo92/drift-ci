import { describe, expect, it } from 'vitest';
import { ActionError } from '../src/action/errors.ts';
import { resolveBase } from '../src/action/base.ts';
import { BASE_SHA, HEAD_SHA, fakeGit } from './helpers/action-fakes.ts';

const MERGE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PARENT_1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MERGE_BASE = 'cccccccccccccccccccccccccccccccccccccccc';
const REV_LIST = 'rev-list --parents -n1 HEAD';
const FETCH = `fetch --no-tags origin ${BASE_SHA}`;
const DEEPEN = `fetch --no-tags --deepen=100 origin ${BASE_SHA} ${HEAD_SHA}`;
const MERGE_BASE_CALL = `merge-base ${BASE_SHA} HEAD`;

describe('resolveBase', () => {
  it('uses the first parent of the merge commit the pull_request checkout lands on', async () => {
    const git = fakeGit({ [REV_LIST]: `${MERGE} ${PARENT_1} ${HEAD_SHA}\n` });
    await expect(resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA })).resolves.toEqual({
      base: PARENT_1,
      head: MERGE,
    });
    expect(git.calls).toEqual([REV_LIST]);
  });

  it('fetches the base and uses the merge-base when HEAD is the PR head commit', async () => {
    const git = fakeGit({
      [REV_LIST]: `${HEAD_SHA} ${PARENT_1}`,
      [FETCH]: '',
      [MERGE_BASE_CALL]: `${MERGE_BASE}\n`,
    });
    await expect(resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA })).resolves.toEqual({
      base: MERGE_BASE,
      head: HEAD_SHA,
    });
    expect(git.calls).toEqual([REV_LIST, FETCH, MERGE_BASE_CALL]);
  });

  it('does not take a PR head that is itself a merge commit for the merge ref', async () => {
    // A feature branch that merged main: HEAD is head.sha and has two parents.
    const git = fakeGit({
      [REV_LIST]: `${HEAD_SHA} ${PARENT_1} ${MERGE}`,
      [FETCH]: '',
      [MERGE_BASE_CALL]: MERGE_BASE,
    });
    const result = await resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA });
    expect(result).toEqual({ base: MERGE_BASE, head: HEAD_SHA });
  });

  it('fetches the base for a root commit too', async () => {
    const git = fakeGit({ [REV_LIST]: HEAD_SHA, [FETCH]: '', [MERGE_BASE_CALL]: MERGE_BASE });
    await expect(resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA })).resolves.toMatchObject({
      base: MERGE_BASE,
    });
  });

  it('deepens the history once when the first merge-base finds nothing', async () => {
    let attempts = 0;
    const git = fakeGit({
      [REV_LIST]: `${HEAD_SHA} ${PARENT_1}`,
      [FETCH]: '',
      [DEEPEN]: '',
      [MERGE_BASE_CALL]: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('exit code 1');
        return MERGE_BASE;
      },
    });
    await expect(resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA })).resolves.toEqual({
      base: MERGE_BASE,
      head: HEAD_SHA,
    });
    expect(git.calls).toEqual([REV_LIST, FETCH, MERGE_BASE_CALL, DEEPEN, MERGE_BASE_CALL]);
  });

  it('keeps going when deepening is refused (a complete clone has nothing to deepen)', async () => {
    let attempts = 0;
    const git = fakeGit({
      [REV_LIST]: `${HEAD_SHA} ${PARENT_1}`,
      [FETCH]: '',
      [DEEPEN]: new Error('not a shallow repository'),
      [MERGE_BASE_CALL]: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('exit code 1');
        return MERGE_BASE;
      },
    });
    await expect(resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA })).resolves.toMatchObject({
      base: MERGE_BASE,
    });
  });

  it('fails loudly, naming fetch-depth: 0, when no merge-base is found after deepening', async () => {
    const git = fakeGit({
      [REV_LIST]: `${HEAD_SHA} ${PARENT_1}`,
      [FETCH]: '',
      [DEEPEN]: '',
      [MERGE_BASE_CALL]: new Error('exit code 1'),
    });
    const failure = resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA });
    await expect(failure).rejects.toBeInstanceOf(ActionError);
    await expect(failure).rejects.toThrow(/fetch-depth: 0/);
    await expect(failure).rejects.toThrow(new RegExp(BASE_SHA));
  });

  it('treats an empty merge-base answer as a failure', async () => {
    const git = fakeGit({
      [REV_LIST]: `${HEAD_SHA} ${PARENT_1}`,
      [FETCH]: '',
      [DEEPEN]: '',
      [MERGE_BASE_CALL]: '\n',
    });
    await expect(resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA })).rejects.toThrow(/fetch-depth: 0/);
  });

  it('fails with the base SHA and the git error when the base cannot be fetched', async () => {
    const git = fakeGit({
      [REV_LIST]: `${HEAD_SHA} ${PARENT_1}`,
      [FETCH]: new Error('fatal: could not read from remote'),
    });
    const failure = resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA });
    await expect(failure).rejects.toBeInstanceOf(ActionError);
    await expect(failure).rejects.toThrow(/could not fetch the base commit 2222222/);
    await expect(failure).rejects.toThrow(/could not read from remote/);
  });

  it('fails when HEAD cannot be read', async () => {
    const git = fakeGit({ [REV_LIST]: new Error('not a git repository') });
    await expect(resolveBase(git, { headSha: HEAD_SHA, baseSha: BASE_SHA })).rejects.toThrow(
      /not a git repository/,
    );
  });
});
