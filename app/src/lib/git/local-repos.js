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
 * Deletes copies one by one. One that fails does not stop the others, and stays
 * recorded so that the deletion can be tried again.
 * @param {LocalRepo[]} repos
 * @param {(id: string) => Promise<void>} remove
 * @returns {Promise<LocalRepo[]>} the copies that could not be deleted
 */
export async function removeLocalCopies(repos, remove) {
	/** @type {LocalRepo[]} */
	const failed = [];
	for (const repo of repos) {
		try {
			await remove(repo.id);
		} catch {
			failed.push(repo);
		}
	}
	return failed;
}

/**
 * Counts the unpushed work in local copies. A copy that cannot be read reports
 * nulls rather than zero, so a warning never understates what is at risk.
 * @param {LocalRepo[]} repos
 * @param {(repo: LocalRepo) => Pick<import('./repo.js').Repo, 'isCloned' | 'aheadBehind' | 'status'>} open
 * @returns {Promise<LocalWork[]>}
 */
export async function describeLocalWork(repos, open) {
	/** @type {LocalWork[]} */
	const work = [];
	for (const repo of repos) {
		try {
			const handle = open(repo);
			if (!(await handle.isCloned())) {
				work.push({ repo, unpushed: 0, drafts: 0 });
				continue;
			}
			const [{ ahead }, { files }] = [await handle.aheadBehind(), await handle.status()];
			work.push({ repo, unpushed: ahead, drafts: files.length });
		} catch {
			work.push({ repo, unpushed: null, drafts: null });
		}
	}
	return work;
}
