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

	it('strips line endings from what it shows, but still sees a change of them', () => {
		const diff = diffFile(encode('a\n'), encode('a\r\n'));
		expect(diff).toEqual({
			kind: 'text',
			lines: [
				{ type: 'removed', text: 'a' },
				{ type: 'added', text: 'a' }
			]
		});
	});

	it('does not read binary or oversized files as lines', () => {
		expect(diffFile(encode('a'), new Uint8Array([0, 1, 2]))).toEqual({ kind: 'binary', before: 1, after: 3 });
		const big = new Uint8Array(MAX_TEXT_BYTES + 1);
		expect(diffFile(big, null)).toEqual({ kind: 'large', before: MAX_TEXT_BYTES + 1, after: 0 });
	});
});
