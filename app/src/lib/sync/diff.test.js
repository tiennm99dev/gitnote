import { describe, expect, it } from 'vitest';
import { MAX_TEXT_BYTES } from '../notes/text.js';
import { diffFile } from './diff.js';

const encode = (/** @type {string} */ text) => new TextEncoder().encode(text);

describe('diffFile', () => {
	it('marks changed lines and keeps nearby ones', () => {
		const diff = diffFile(encode('one\ntwo\nthree\n'), encode('one\n2\nthree\n'));
		expect(diff).toEqual({
			kind: 'text',
			lines: [
				{ type: 'same', text: 'one' },
				{ type: 'removed', text: 'two' },
				{ type: 'added', text: '2' },
				{ type: 'same', text: 'three' }
			]
		});
	});

	it('shows a new file as all added and a deleted one as all removed', () => {
		expect(diffFile(null, encode('a\nb\n'))).toMatchObject({ lines: [{ type: 'added', text: 'a' }, { type: 'added', text: 'b' }] });
		expect(diffFile(encode('a\n'), null)).toMatchObject({ lines: [{ type: 'removed', text: 'a' }] });
	});

	it('folds long unchanged runs, counting what it hides', () => {
		const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
		const diff = diffFile(encode(before), encode(before.replace('line 15', 'changed')));
		if (diff.kind !== 'text') throw new Error('expected text');
		expect(diff.lines.filter((line) => line.type === 'folded')).toEqual([
			{ type: 'folded', count: 12 },
			{ type: 'folded', count: 11 }
		]);
		expect(diff.lines.filter((line) => line.type === 'same')).toHaveLength(6);
	});

	it('says so when only the line endings changed, rather than listing identical lines', () => {
		expect(diffFile(encode('a\r\nb\r\n'), encode('a\nb\n'))).toEqual({ kind: 'line_endings' });
		expect(diffFile(encode('a\nb\n'), encode('a\r\nb\r\n'))).toEqual({ kind: 'line_endings' });
	});

	it('counts a final newline, added or removed, as a line ending', () => {
		expect(diffFile(encode('a'), encode('a\n'))).toEqual({ kind: 'line_endings' });
		expect(diffFile(encode('a\nb\n'), encode('a\nb'))).toEqual({ kind: 'line_endings' });
	});

	it('still shows a blank line added at the end, and a real edit among changed line endings', () => {
		expect(diffFile(encode('a\n'), encode('a\n\n'))).toMatchObject({ kind: 'text', lines: [{ type: 'same', text: 'a' }, { type: 'added', text: '' }] });
		expect(diffFile(encode('a\r\n'), encode('b\n'))).toMatchObject({ kind: 'text', lines: [{ type: 'removed', text: 'a' }, { type: 'added', text: 'b' }] });
	});

	it('tells identical text from a new empty file, neither of which is a line ending', () => {
		expect(diffFile(encode('a\n'), encode('a\n'))).toEqual({ kind: 'same_text' });
		expect(diffFile(null, encode(''))).toEqual({ kind: 'text', lines: [] });
		expect(diffFile(null, encode('\n'))).toMatchObject({ kind: 'text' });
	});

	it('does not read binary or oversized files as lines', () => {
		expect(diffFile(encode('a'), new Uint8Array([0, 1, 2]))).toEqual({ kind: 'binary', before: 1, after: 3 });
		const big = new Uint8Array(MAX_TEXT_BYTES + 1);
		expect(diffFile(big, null)).toEqual({ kind: 'large', before: MAX_TEXT_BYTES + 1, after: 0 });
	});
});
