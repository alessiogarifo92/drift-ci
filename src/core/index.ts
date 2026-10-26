// Pure analysis core: no filesystem, process or GitHub Actions access here.
// Inputs arrive through adapters (RepoSnapshot, ChangeSet) supplied by the
// CLI or the Action; see docs/decisions.md, phase 3.

export * from './check.ts';
export * from './finding.ts';
export * from './indexer.ts';
export * from './reference.ts';
export * from './rules.ts';
export * from './rules/index.ts';
export * from './rules/path.ts';
export * from './snapshot.ts';
