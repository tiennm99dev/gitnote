/**
 * Merge support for pull: a merge driver that never writes diff3 markers into
 * binary files, and the merge state kept on disk while a conflict is open.
 * isomorphic-git writes no MERGE_HEAD, so without this state a reload would
 * forget which commit is being merged.
 */

import diff3Merge from 'diff3';

/** Git's own binary heuristic: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_LENGTH = 8000;

const MARKER_SIZE = 7;
const LINES = /^.*(\r?\n|$)/gm;

/** File name of the merge state, inside the git directory. */
const MERGE_STATE_FILE = 'gitnote-merge.json';

const OID = /^[0-9a-f]{40}$/;

/**
 * Merge drivers receive files already decoded as UTF-8, so bytes that are not
 * valid UTF-8 arrive as U+FFFD and a line merge would write them back damaged.
 * Such a file counts as binary too: wrongly asking for an ours/theirs choice
 * is safe, and silently corrupting it is not.
 * @param {string} content a decoded file
 * @returns {boolean} whether a line merge could damage the file
 */
export function isBinary(content) {
	return content.slice(0, BINARY_SNIFF_LENGTH).includes('\0') || content.includes('\uFFFD');
}

/**
 * Builds a merge driver for one merge. Text files merge line by line with
 * diff3 conflict markers, like isomorphic-git's default driver. A binary file
 * changed on both sides is always a conflict and its paths land in
 * `binaryPaths`, so the caller can restore our bytes and offer an ours/theirs
 * choice instead of markers.
 * @param {Set<string>} binaryPaths filled with the paths of binary conflicts
 * @returns {import('isomorphic-git').MergeDriverCallback}
 */
export function createMergeDriver(binaryPaths) {
	return ({ branches, contents, path }) => {
		const [, ourName, theirName] = branches;
		const [baseContent, ourContent, theirContent] = contents;
		if (contents.some((content) => isBinary(content))) {
			binaryPaths.add(path);
			return { cleanMerge: false, mergedText: ourContent };
		}

		const result = /** @type {Array<{ ok?: string[], conflict?: { a: string[], b: string[] } }>} */ (
			diff3Merge(ourContent.match(LINES) ?? [], baseContent.match(LINES) ?? [], theirContent.match(LINES) ?? [])
		);
		let mergedText = '';
		let cleanMerge = true;
		for (const item of result) {
			if (item.ok) mergedText += item.ok.join('');
			if (item.conflict) {
				cleanMerge = false;
				mergedText += `${'<'.repeat(MARKER_SIZE)} ${ourName}\n`;
				mergedText += item.conflict.a.join('');
				mergedText += `${'='.repeat(MARKER_SIZE)}\n`;
				mergedText += item.conflict.b.join('');
				mergedText += `${'>'.repeat(MARKER_SIZE)} ${theirName}\n`;
			}
		}
		return { cleanMerge, mergedText };
	};
}

/**
 * @typedef {object} MergeState an open merge, waiting for its merge commit
 * @property {string} branch the local branch being merged into
 * @property {string} oursOid HEAD when the merge started
 * @property {string} theirsOid the fetched remote commit being merged
 * @property {string[]} conflictedPaths every path with unmerged index entries
 * @property {string[]} binaryPaths conflicted binary files: pick ours or theirs, never markers
 * @property {string} startedAt ISO timestamp
 */

/**
 * @param {string} gitdir
 * @returns {string}
 */
function statePath(gitdir) {
	return `${gitdir}/${MERGE_STATE_FILE}`;
}

/**
 * @param {import('isomorphic-git').PromiseFsClient} fs
 * @param {string} gitdir
 * @returns {Promise<MergeState | null>} the open merge, or null
 */
export async function readMergeState(fs, gitdir) {
	/** @type {string} */
	let text;
	try {
		text = await fs.promises.readFile(statePath(gitdir), { encoding: 'utf8' });
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return null;
		throw error;
	}
	const state = JSON.parse(text);
	if (!isMergeState(state)) throw new Error('The stored merge state is damaged.');
	return state;
}

/**
 * @param {import('isomorphic-git').PromiseFsClient} fs
 * @param {string} gitdir
 * @param {MergeState} state
 * @returns {Promise<void>}
 */
export async function writeMergeState(fs, gitdir, state) {
	await fs.promises.writeFile(statePath(gitdir), JSON.stringify(state), { encoding: 'utf8' });
}

/**
 * @param {unknown} value
 * @returns {value is MergeState}
 */
function isMergeState(value) {
	if (typeof value !== 'object' || value === null) return false;
	const state = /** @type {Record<string, unknown>} */ (value);
	const isStringList = (/** @type {unknown} */ list) => Array.isArray(list) && list.every((item) => typeof item === 'string');
	return (
		typeof state.branch === 'string' &&
		typeof state.oursOid === 'string' &&
		OID.test(state.oursOid) &&
		typeof state.theirsOid === 'string' &&
		OID.test(state.theirsOid) &&
		isStringList(state.conflictedPaths) &&
		isStringList(state.binaryPaths) &&
		typeof state.startedAt === 'string'
	);
}
