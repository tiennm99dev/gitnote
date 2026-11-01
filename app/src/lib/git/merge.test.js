import { memfs } from 'memfs';
import { describe, expect, it } from 'vitest';
import { createMergeDriver, isBinary, readMergeState, writeMergeState } from './merge.js';

const BRANCHES = ['base', 'main', 'origin/main'];
const OID = 'a'.repeat(40);

/**
 * @param {string[]} contents base, ours and theirs
 * @param {Set<string>} [binaryPaths]
 * @returns {Promise<{ cleanMerge: boolean, mergedText: string }>}
 */
async function merge(contents, binaryPaths = new Set()) {
	return createMergeDriver(binaryPaths)({ branches: BRANCHES, contents, path: 'file' });
}

/** @returns {import('isomorphic-git').PromiseFsClient} */
function emptyFs() {
	const fs = /** @type {import('isomorphic-git').PromiseFsClient} */ (/** @type {unknown} */ (memfs().fs));
	return fs;
}

describe('isBinary', () => {
	it('spots a NUL byte near the start', () => {
		expect(isBinary('abc\0def')).toBe(true);
		expect(isBinary(`${'a'.repeat(8000)}\0`)).toBe(false);
	});

	it('spots bytes that did not survive UTF-8 decoding', () => {
		expect(isBinary(new TextDecoder().decode(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])))).toBe(true);
	});

	it('passes ordinary text', () => {
		expect(isBinary('# Tiêu đề\n\nghi chú 📝\n')).toBe(false);
	});
});

describe('createMergeDriver', () => {
	it('merges edits to different lines', async () => {
		expect(await merge(['a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n'])).toEqual({ cleanMerge: true, mergedText: 'A\nb\nc\nD\n' });
	});

	it('writes markers named after the branches on a conflict', async () => {
		expect(await merge(['x\n', 'ours\n', 'theirs\n'])).toEqual({
			cleanMerge: false,
			mergedText: '<<<<<<< main\nours\n=======\ntheirs\n>>>>>>> origin/main\n'
		});
	});

	it('keeps a file without a final newline intact', async () => {
		expect(await merge(['a\nb', 'A\nb', 'a\nb'])).toEqual({ cleanMerge: true, mergedText: 'A\nb' });
	});

	it('handles an empty base', async () => {
		expect((await merge(['', 'ours\n', 'theirs\n'])).cleanMerge).toBe(false);
	});

	it('always conflicts on a binary file, without markers, and names its path', async () => {
		/** @type {Set<string>} */
		const binaryPaths = new Set();
		const result = await merge(['\0a\nb\nc\n', '\0A\nb\nc\n', '\0a\nb\nC\n'], binaryPaths);
		expect(result.cleanMerge).toBe(false);
		expect(result.mergedText).not.toContain('<<<<<<<');
		expect([...binaryPaths]).toEqual(['file']);
	});
});

describe('merge state', () => {
	const STATE = {
		branch: 'main',
		oursOid: OID,
		theirsOid: OID.replace(/a/g, 'b'),
		conflictedPaths: ['a.md'],
		binaryPaths: [],
		startedAt: '2026-11-01T00:00:00.000Z'
	};

	it('is null when no merge is open', async () => {
		const fs = emptyFs();
		await fs.promises.mkdir('/gitdir');
		expect(await readMergeState(fs, '/gitdir')).toBeNull();
	});

	it('survives being read back', async () => {
		const fs = emptyFs();
		await fs.promises.mkdir('/gitdir');
		await writeMergeState(fs, '/gitdir', STATE);
		expect(await readMergeState(fs, '/gitdir')).toEqual(STATE);
	});

	it.each([
		['bad JSON', 'not json'],
		['a missing field', JSON.stringify({ ...STATE, theirsOid: undefined })],
		['a bad oid', JSON.stringify({ ...STATE, theirsOid: 'HEAD' })],
		['a bad path list', JSON.stringify({ ...STATE, conflictedPaths: 'a.md' })]
	])('refuses a stored state with %s', async (_name, text) => {
		const fs = emptyFs();
		await fs.promises.mkdir('/gitdir');
		await fs.promises.writeFile('/gitdir/gitnote-merge.json', text);
		await expect(readMergeState(fs, '/gitdir')).rejects.toThrow();
	});
});
