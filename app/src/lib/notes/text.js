/**
 * How a file's bytes become editor text and back, without changing a byte the
 * user did not touch.
 */

import { isBinary } from '../git/merge.js';

/** Above this, a file shows its size only: rendering or editing it would stall the page. */
export const MAX_TEXT_BYTES = 5_000_000;

/**
 * @param {Uint8Array} bytes
 * @returns {string | null} the text, keeping any byte order mark, or null for a binary file
 */
export function decodeText(bytes) {
	const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
	return isBinary(text) ? null : text;
}

/**
 * The separator to give the editor, which would otherwise turn every line ending
 * into `\n` and so rewrite each line of a CRLF file on save. In a file that mixes
 * them, `\n` splits the lines and each `\r` stays in the text as a character.
 * @param {string} text
 * @returns {'\n' | '\r\n'}
 */
export function lineSeparatorFor(text) {
	return text.includes('\r\n') && !/(^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

/**
 * @param {string} text text arriving from outside the note, such as a paste
 * @param {string} separator the note's line separator
 * @returns {string} the text using only that separator
 */
export function normalizeLineBreaks(text, separator) {
	return text.replace(/\r\n?|\n/g, separator);
}
