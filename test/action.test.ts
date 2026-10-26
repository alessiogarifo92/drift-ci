import { describe, expect, it, vi } from 'vitest';
import { runAction } from '../src/action/main.ts';

describe('runAction', () => {
  it('logs that no checks are implemented yet', () => {
    const info = vi.fn();
    runAction({ info });
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/finding schema v1\): no checks are implemented yet/));
  });
});
