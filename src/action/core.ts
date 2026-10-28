// The slice of `@actions/core` the Action uses, behind an interface so tests can record it.
import * as core from '@actions/core';

export interface ActionCore {
  info(message: string): void;
  warning(message: string, properties?: core.AnnotationProperties): void;
  notice(message: string, properties?: core.AnnotationProperties): void;
  setFailed(message: string): void;
  getInput(name: string): string;
  /** Appends Markdown to the job summary. Rejects when the runner offers no summary file. */
  writeSummary(markdown: string): Promise<void>;
}

export function createActionCore(): ActionCore {
  return {
    info: (message) => core.info(message),
    warning: (message, properties) => core.warning(message, properties),
    notice: (message, properties) => core.notice(message, properties),
    setFailed: (message) => core.setFailed(message),
    getInput: (name) => core.getInput(name),
    writeSummary: async (markdown) => {
      await core.summary.addRaw(markdown, true).write();
    },
  };
}
