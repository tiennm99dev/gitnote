/**
 * What a change looks like for the commit panel: lines kept, removed and added,
 * with long unchanged runs folded. Lines reach the page as text, never as HTML.
 */

import { diffLines } from 'diff';
import { decodeText, MAX_TEXT_BYTES } from '../notes/text.js';

/** Unchanged lines kept on each side of a change. */
const CONTEXT_LINES = 3;

/** A diff of two note-sized files finishes well inside this; a pathological one gives up. */
const DIFF_TIMEOUT_MS = 2000;

/**
 * @typedef {{ type: 'same' | 'added' | 'removed', text: string } | { type: 'folded', count: number }} DiffLine
 */

/**
 * @typedef {{ kind: 'text', lines: DiffLine[] } | { kind: 'binary' | 'large' | 'too_different', before: number, after: number }} FileDiff
 */

/**
 * @param {Uint8Array | null} before the committed file; null when there is none
 * @param {Uint8Array | null} after the file now; null when it is gone
 * @returns {FileDiff}
 */
export function diffFile(before, after) {
	const sizes = { before: before?.byteLength ?? 0, after: after?.byteLength ?? 0 };
	if (sizes.before > MAX_TEXT_BYTES || sizes.after > MAX_TEXT_BYTES) return { kind: 'large', ...sizes };
	const beforeText = before ? decodeText(before) : '';
	const afterText = after ? decodeText(after) : '';
	if (beforeText === null || afterText === null) return { kind: 'binary', ...sizes };
	const parts = diffLines(beforeText, afterText, { timeout: DIFF_TIMEOUT_MS });
	if (!parts) return { kind: 'too_different', ...sizes };
	/** @type {{ type: 'same' | 'added' | 'removed', text: string }[]} */
	const lines = [];
	for (const part of parts) {
		const type = part.added ? 'added' : part.removed ? 'removed' : 'same';
		for (const text of splitLines(part.value)) lines.push({ type, text });
	}
	return { kind: 'text', lines: foldUnchanged(lines) };
}

/**
 * @param {string} value
 * @returns {string[]} its lines, without their line endings
 */
function splitLines(value) {
	const lines = value.split('\n').map((line) => line.replace(/\r$/, ''));
	if (lines.at(-1) === '') lines.pop();
	return lines;
}

/**
 * @param {{ type: 'same' | 'added' | 'removed', text: string }[]} lines
 * @returns {DiffLine[]} the lines, with unchanged lines far from any change folded
 */
function foldUnchanged(lines) {
	const keep = lines.map(() => false);
	lines.forEach((line, index) => {
		if (line.type === 'same') return;
		const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
		for (let near = Math.max(0, index - CONTEXT_LINES); near <= end; near += 1) keep[near] = true;
	});
	/** @type {DiffLine[]} */
	const folded = [];
	let skipped = 0;
	lines.forEach((line, index) => {
		if (!keep[index]) {
			skipped += 1;
			return;
		}
		if (skipped > 0) folded.push({ type: 'folded', count: skipped });
		skipped = 0;
		folded.push(line);
	});
	if (skipped > 0) folded.push({ type: 'folded', count: skipped });
	return folded;
}
