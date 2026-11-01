import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { decodeText, lineSeparatorFor } from './text.js';

/**
 * @param {string} text
 * @param {(state: EditorState) => EditorState} [edit]
 * @returns {string} what the editor hands back, the way Editor.svelte reads it
 */
function throughEditor(text, edit = (state) => state) {
	const state = EditorState.create({ doc: text, extensions: EditorState.lineSeparator.of(lineSeparatorFor(text)) });
	return edit(state).sliceDoc();
}

describe('text through the editor', () => {
	it.each([
		['LF', 'a\nb\n'],
		['CRLF', 'a\r\nb\r\n'],
		['mixed endings', 'a\r\nb\nc\r'],
		['a lone CR', 'a\rb'],
		['a line separator character', 'a b c\n'],
		['a byte order mark', '﻿# a\n'],
		['no final newline', 'a'],
		['empty', '']
	])('comes back unchanged with %s', (_name, text) => {
		expect(throughEditor(text)).toBe(text);
	});

	it('keeps CRLF on the lines around an edit', () => {
		const edited = throughEditor('a\r\nb\r\n', (state) => state.update({ changes: { from: 1, insert: 'x' } }).state);
		expect(edited).toBe('ax\r\nb\r\n');
	});

	it('uses CRLF for a new line in a CRLF file', () => {
		const edited = throughEditor('a\r\nb', (state) => state.update(state.replaceSelection(state.toText('\n'.replace('\n', state.lineBreak)))).state);
		expect(edited).toBe('\r\na\r\nb');
	});
});

describe('decoding', () => {
	it('keeps a byte order mark, so saving does not drop it', () => {
		expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a');
	});

	it('calls NUL bytes and invalid UTF-8 binary', () => {
		expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull();
		expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]))).toBeNull();
	});

	it('reads ordinary text', () => {
		expect(decodeText(new TextEncoder().encode('Tiếng Việt\n'))).toBe('Tiếng Việt\n');
	});
});
