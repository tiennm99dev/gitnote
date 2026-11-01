/**
 * What the editor accepts from the clipboard.
 */

import { EditorView } from '@codemirror/view';
import { normalizeLineBreaks } from './text.js';

/**
 * An explicit line separator makes the editor split incoming text on that exact
 * string, so a paste with other line endings would bring stray `\r` characters,
 * or `\n` inside one line. A note that mixes endings edits with `\n`, and a paste
 * uses that too, leaving the bytes already there alone. Drops take this path as
 * well.
 */
export const pastedLineBreaks = EditorView.clipboardInputFilter.of((text, state) => normalizeLineBreaks(text, state.lineBreak));

/**
 * Office apps put a picture of the selection next to its text, and the text is
 * what the user meant. Only markdown can link to an image.
 * @param {Pick<DataTransfer, 'files' | 'getData'> | null} clipboard
 * @param {boolean} isMarkdown
 * @returns {File | null} the image to add instead of pasting
 */
export function pastedImage(clipboard, isMarkdown) {
	if (!clipboard || !isMarkdown || clipboard.getData('text/plain').trim() !== '') return null;
	return [...clipboard.files].find((file) => file.type.startsWith('image/')) ?? null;
}
