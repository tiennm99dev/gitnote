/**
 * One exclusive lock per repository around every git operation. Two tabs on
 * the same repo share one IndexedDB store, and isomorphic-git reads, edits and
 * writes the whole index file, so unlocked operations from two tabs can lose
 * each other's index updates.
 */

/**
 * @typedef {object} LockManagerLike the part of the Web Locks API this module uses
 * @property {<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>) => Promise<T>} request
 */

/**
 * Chains of pending operations per lock name, used only where the Web Locks
 * API is missing. They serialise one page; they cannot reach other tabs.
 * @type {Map<string, Promise<unknown>>}
 */
const localQueues = new Map();

/**
 * @param {string} repoId
 * @returns {string} the Web Locks name for a repository
 */
export function repoLockName(repoId) {
	return `gitnote:repo:${repoId}`;
}

/**
 * Runs `operation` while holding the repository's lock. Locks are not
 * re-entrant: an operation must not call another locked operation on the same
 * repo.
 * @template T
 * @param {string} repoId
 * @param {() => Promise<T>} operation
 * @param {{ locks?: LockManagerLike | null }} [options] defaults to `navigator.locks`
 * @returns {Promise<T>}
 */
export function withRepoLock(repoId, operation, { locks = defaultLocks() } = {}) {
	const name = repoLockName(repoId);
	if (locks) return locks.request(name, { mode: 'exclusive' }, operation);

	const previous = localQueues.get(name) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	const tail = result.catch(() => {});
	localQueues.set(name, tail);
	tail.then(() => {
		if (localQueues.get(name) === tail) localQueues.delete(name);
	});
	return result;
}

/**
 * @returns {LockManagerLike | null}
 */
function defaultLocks() {
	const locks = globalThis.navigator?.locks;
	return locks ? /** @type {LockManagerLike} */ (/** @type {unknown} */ (locks)) : null;
}
