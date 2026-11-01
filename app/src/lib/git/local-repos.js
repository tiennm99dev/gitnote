/**
 * Which repositories have a copy on this device, for the repo picker and for
 * sign-out. One localStorage entry per repo, so two tabs never overwrite each
 * other's list. An entry holds no credential: `clone` refuses a URL with one.
 *
 * A repo is recorded before its clone starts, so a clone cut off by a closed tab
 * can still be wiped; `ready` turns true once the clone finishes.
 */

import { isProviderId } from './limits.js';

const PREFIX = 'gitnote.repo.';

/**
 * @typedef {object} LocalRepo
 * @property {string} id the engine's repo id
 * @property {string} url
 * @property {import('./limits.js').ProviderId} provider
 * @property {string} fullName
 * @property {string} branch the branch asked for, or the one cloned
 * @property {boolean} ready the clone finished
 */

/**
 * @param {Storage} [storage]
 * @returns {LocalRepo[]} sorted by name; anything unreadable is left out
 */
export function listLocalRepos(storage = globalThis.localStorage) {
	/** @type {LocalRepo[]} */
	const repos = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (!key?.startsWith(PREFIX)) continue;
		const repo = parseLocalRepo(storage.getItem(key));
		if (repo) repos.push(repo);
	}
	return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * @param {LocalRepo} repo
 * @param {Storage} [storage]
 * @returns {void}
 */
export function saveLocalRepo(repo, storage = globalThis.localStorage) {
	storage.setItem(PREFIX + repo.id, JSON.stringify(repo));
}

/**
 * @param {string} id
 * @param {Storage} [storage]
 * @returns {void}
 */
export function forgetLocalRepo(id, storage = globalThis.localStorage) {
	storage.removeItem(PREFIX + id);
}

/**
 * @param {string | null} text
 * @returns {LocalRepo | null}
 */
function parseLocalRepo(text) {
	/** @type {Partial<LocalRepo> | null} */
	let value;
	try {
		value = JSON.parse(text ?? 'null');
	} catch {
		return null;
	}
	if (
		typeof value?.id !== 'string' ||
		typeof value.url !== 'string' ||
		typeof value.provider !== 'string' ||
		!isProviderId(value.provider) ||
		typeof value.fullName !== 'string' ||
		typeof value.branch !== 'string' ||
		typeof value.ready !== 'boolean'
	) {
		return null;
	}
	return /** @type {LocalRepo} */ (value);
}

/**
 * What would be lost if this copy were deleted now.
 * @typedef {object} LocalWork
 * @property {LocalRepo} repo
 * @property {number | null} unpushed commits only on this device; null when they could not be counted
 * @property {number | null} drafts changed files not yet committed; null likewise
 */

/**
 * @param {Pick<LocalWork, 'unpushed' | 'drafts'>} work
 * @returns {string} what deleting a copy would lose, for people
 */
export function describeWorkCounts({ unpushed, drafts }) {
	if (unpushed === null || drafts === null) return 'could not be read, so it may hold unpushed work';
	return `${unpushed} unpushed ${unpushed === 1 ? 'commit' : 'commits'}, ${drafts} uncommitted ${drafts === 1 ? 'file' : 'files'}`;
}

/**
 * @param {LocalWork[]} shown what the user was shown
 * @param {LocalWork[]} current a fresh count
 * @returns {boolean} whether the user decided on what is there now
 */
export function isSameWork(shown, current) {
	return JSON.stringify(shown) === JSON.stringify(current);
}

/**
 * Deletes copies one by one, each only if it still holds what the user was shown.
 * One that fails or changed does not stop the others, and stays recorded so that
 * the deletion can be tried again.
 * @param {LocalWork[]} shown
 * @param {(work: LocalWork) => Promise<boolean>} remove answers false when the copy changed
 * @returns {Promise<{ failed: LocalRepo[], changed: LocalRepo[] }>} the copies still there
 */
export async function removeLocalCopies(shown, remove) {
	/** @type {LocalRepo[]} */
	const failed = [];
	/** @type {LocalRepo[]} */
	const changed = [];
	for (const work of shown) {
		try {
			if (!(await remove(work))) changed.push(work.repo);
		} catch {
			failed.push(work.repo);
		}
	}
	return { failed, changed };
}

/**
 * Counts the unpushed work in local copies. A copy that cannot be opened reports
 * nulls rather than zero, so a warning never understates what is at risk.
 * @param {LocalRepo[]} repos
 * @param {(repo: LocalRepo) => Pick<import('./repo.js').Repo, 'countWork'>} open
 * @returns {Promise<LocalWork[]>}
 */
export async function describeLocalWork(repos, open) {
	/** @type {LocalWork[]} */
	const work = [];
	for (const repo of repos) {
		try {
			work.push({ repo, ...(await open(repo).countWork()) });
		} catch {
			work.push({ repo, unpushed: null, drafts: null });
		}
	}
	return work;
}

/**
 * Puts the list right after a clone failed, so a copy that is really there is
 * never dropped from it: sign-out counts and deletes copies through this list.
 * @param {object} options
 * @param {LocalRepo} options.entry what this clone recorded
 * @param {LocalRepo | undefined} options.previous what was recorded before it
 * @param {() => Promise<boolean>} options.isCloned
 * @param {Storage} [options.storage]
 * @returns {Promise<void>}
 */
export async function settleFailedClone({ entry, previous, isCloned, storage = globalThis.localStorage }) {
	if (previous) {
		try {
			saveLocalRepo(previous, storage);
		} catch {
			// The entry this clone recorded stays, which still lists the copy.
		}
		return;
	}
	// Not knowing counts as there: a stale entry costs far less than a lost one.
	if (!(await isCloned().catch(() => true))) forgetLocalRepo(entry.id, storage);
}
