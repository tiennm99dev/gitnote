/**
 * Merge support for pull: a merge driver that never writes diff3 markers into
 * binary files, and the merge state kept on disk while a pull changes the
 * working tree or a conflict is open. isomorphic-git writes no MERGE_HEAD, so
 * without this state a reload would forget which commit is being merged.
 */

import diff3Merge from 'diff3';

/** Git's own binary heuristic: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_LENGTH = 8000;

const MARKER_SIZE = 7;

/**
 * One piece per line, ending at `\n` only, so joining the pieces gives the input
 * back byte for byte: `\r`, U+2028 and U+2029 stay inside their line.
 */
const LINES = /[^\n]*\n|[^\n]+$/g;

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
 * `binaryPaths`, so the caller can offer an ours/theirs choice instead of
 * markers. Each text file's result lands in `mergedTexts`, for a caller that
 * writes the working tree itself.
 * @param {Set<string>} binaryPaths filled with the paths of binary conflicts
 * @param {Map<string, string>} [mergedTexts] filled with each text file's result
 * @returns {import('isomorphic-git').MergeDriverCallback}
 */
export function createMergeDriver(binaryPaths, mergedTexts = new Map()) {
	return ({ branches, contents, path }) => {
		const [, ourName, theirName] = branches;
		// A marker must start its line, even after content with no final newline.
		const endLine = (/** @type {string} */ text) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);
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
				mergedText = endLine(mergedText);
				mergedText += `${'<'.repeat(MARKER_SIZE)} ${ourName}\n`;
				mergedText = endLine(mergedText + item.conflict.a.join(''));
				mergedText += `${'='.repeat(MARKER_SIZE)}\n`;
				mergedText = endLine(mergedText + item.conflict.b.join(''));
				mergedText += `${'>'.repeat(MARKER_SIZE)} ${theirName}\n`;
			}
		}
		mergedTexts.set(path, mergedText);
		return { cleanMerge, mergedText };
	};
}

/**
 * Text with line-anchored conflict markers still in it.
 * @param {string} text
 * @returns {boolean}
 */
export function hasConflictMarkers(text) {
	return /^<{7} /m.test(text) && /^={7}\r?$/m.test(text) && /^>{7} /m.test(text);
}

/**
 * @typedef {'both_modified' | 'deleted_by_us' | 'deleted_by_theirs'} ConflictKind
 */

/**
 * @typedef {object} Conflict
 * @property {string} path
 * @property {ConflictKind} kind what each side did. Only `both_modified` text
 *   has markers; a deleted-by-one-side file holds the other side's content.
 * @property {boolean} binary pick ours or theirs, never markers
 */

/**
 * The record of a pull that is changing the working tree. It is written and
 * flushed before anything moves, so an interrupted pull can always be undone:
 * - `applying`: the pull, or an abort of its merge, is under way. Found by any
 *   later operation, it means the tab died, and the branch and working tree go
 *   back to `oursOid`, apart from `keptDrafts`.
 * - `conflicted`: an open merge, waiting for its merge commit.
 * @typedef {object} MergeState
 * @property {'applying' | 'conflicted'} phase
 * @property {string} branch the local branch being merged into
 * @property {string} oursOid HEAD when the merge started
 * @property {string} theirsOid the fetched remote commit being merged
 * @property {string[]} conflictedPaths every path with unmerged index entries
 * @property {string[]} binaryPaths conflicted binary files: pick ours or theirs, never markers
 * @property {Conflict[]} conflicts the same paths, with what each side did
 * @property {string[]} resolvedPaths conflicts the user picked a side for
 * @property {string[]} keptDrafts edits an abort leaves in the working tree
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
	/** @type {string | null | undefined} */
	let text;
	try {
		text = await fs.promises.readFile(statePath(gitdir), { encoding: 'utf8' });
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return null;
		throw error;
	}
	// LightningFS deletes an unlinked file's data at once but saves its directory
	// later, so a tab that died while closing the record leaves a name with no data.
	if (text === undefined || text === null) return null;
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
 * @param {import('isomorphic-git').PromiseFsClient} fs
 * @param {string} gitdir
 * @returns {Promise<void>}
 */
export async function clearMergeState(fs, gitdir) {
	try {
		await fs.promises.unlink(statePath(gitdir));
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code !== 'ENOENT') throw error;
	}
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isConflict(value) {
	if (typeof value !== 'object' || value === null) return false;
	const conflict = /** @type {Record<string, unknown>} */ (value);
	return (
		typeof conflict.path === 'string' &&
		(conflict.kind === 'both_modified' || conflict.kind === 'deleted_by_us' || conflict.kind === 'deleted_by_theirs') &&
		typeof conflict.binary === 'boolean'
	);
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
		(state.phase === 'applying' || state.phase === 'conflicted') &&
		typeof state.branch === 'string' &&
		typeof state.oursOid === 'string' &&
		OID.test(state.oursOid) &&
		typeof state.theirsOid === 'string' &&
		OID.test(state.theirsOid) &&
		isStringList(state.conflictedPaths) &&
		isStringList(state.binaryPaths) &&
		isStringList(state.resolvedPaths) &&
		isStringList(state.keptDrafts) &&
		Array.isArray(state.conflicts) &&
		state.conflicts.every(isConflict) &&
		typeof state.startedAt === 'string'
	);
}
