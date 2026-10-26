import * as core from '@actions/core';
import { FINDING_SCHEMA_VERSION } from '../core/finding.ts';

export type ActionCore = Pick<typeof core, 'info'>;

/** Action entry point. Rule logic and PR reporting arrive in later tickets. */
export function runAction(actionCore: ActionCore = core): void {
  actionCore.info(
    `drift-ci (finding schema v${FINDING_SCHEMA_VERSION}): no checks are implemented yet.`,
  );
}
