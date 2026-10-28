/** A failure the Action can name: the message is shown to the user as the reason the job failed. */
export class ActionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ActionError';
  }
}

/** Message of anything that was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
