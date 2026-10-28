// Helpers for building finding messages. Messages quote names chosen by whoever wrote the files under
// check (a script, a target, a file name), and the action renders text between backticks as a code span.
// A name must therefore never carry a backtick of its own into a message.

/** MODIFIER LETTER GRAVE ACCENT: looks like a backtick, is not one. */
const LOOKALIKE_BACKTICK = 'ˋ';

/** `value` as an inline code span of a message; backticks inside the value become look-alikes. */
export function codeName(value: string): string {
  return `\`${value.replace(/`/g, LOOKALIKE_BACKTICK)}\``;
}
