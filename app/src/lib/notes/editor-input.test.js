// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pastedImage, pastedLineBreaks } from './editor-input.js';
import { lineSeparatorFor } from './text.js';

/** @type {EditorView | undefined} */
let view;

beforeAll(() => {
	// jsdom lays nothing out, and the editor measures after an update.
	Range.prototype.getClientRects = () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([]));
	Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => view?.destroy());

/**
 * Delivers a paste to a real editor the way the browser does.
 * @param {string} doc
 * @param {string} pasted
 * @returns {EditorView}
 */
function pasteInto(doc, pasted) {
	view = new EditorView({
		state: EditorState.create({ doc, extensions: [EditorState.lineSeparator.of(lineSeparatorFor(doc)), pastedLineBreaks] }),
		parent: document.body
	});
	const event = new Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', { value: { getData: (/** @type {string} */ type) => (type === 'text/plain' ? pasted : ''), types: ['text/plain'], files: [] } });
	view.contentDOM.dispatchEvent(event);
	return view;
}

describe('pasted text', () => {
	it('takes CRLF from the clipboard as LF in an LF note', () => {
		const { state } = pasteInto('a\nb', 'x\r\ny');
		expect(state.sliceDoc()).toBe('x\nya\nb');
		expect(state.doc.lines).toBe(3);
	});

	it('takes LF from the clipboard as CRLF in a CRLF note, as real lines', () => {
		const { state } = pasteInto('a\r\nb', 'x\ny');
		expect(state.sliceDoc()).toBe('x\r\nya\r\nb');
		expect(state.doc.lines).toBe(3);
	});

	it('uses LF in a note that mixes endings, leaving what is already there', () => {
		const { state } = pasteInto('a\r\nb\nc', 'x\r\ny');
		expect(state.sliceDoc()).toBe('x\nya\r\nb\nc');
	});
});

/**
 * @param {string} text
 * @param {File[]} files
 * @returns {Pick<DataTransfer, 'files' | 'getData'>}
 */
const clipboard = (text, files) => ({
	files: /** @type {FileList} */ (/** @type {unknown} */ (files)),
	getData: (type) => (type === 'text/plain' ? text : '')
});

describe('pastedImage', () => {
	const png = new File([new Uint8Array(1)], 'a.png', { type: 'image/png' });

	it('finds a lone image in a markdown note', () => {
		expect(pastedImage(clipboard('', [png]), true)).toBe(png);
	});

	it('lets text win over an image pasted with it', () => {
		expect(pastedImage(clipboard('a table', [png]), true)).toBeNull();
	});

	it('leaves a file that is not markdown alone', () => {
		expect(pastedImage(clipboard('', [png]), false)).toBeNull();
	});

	it('ignores other files and an empty paste', () => {
		expect(pastedImage(clipboard('', [new File([], 'a.txt', { type: 'text/plain' })]), true)).toBeNull();
		expect(pastedImage(null, true)).toBeNull();
	});
});
