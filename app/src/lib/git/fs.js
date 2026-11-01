/**
 * Browser storage for cloned repos: one LightningFS (IndexedDB) instance per
 * repository, plus the persistent-storage request and quota readout.
 */

import LightningFS from '@isomorphic-git/lightning-fs';

/** The working tree inside each repo's file system. */
export const REPO_DIR = '/repo';

/** Warn once the origin uses this share of its storage quota. */
export const STORAGE_WARN_RATIO = 0.7;

/** Repo ids look like `github.com/owner/repo`: host, then path segments. */
const REPO_ID = /^[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9_.-]+)+$/;

/** @type {Map<string, LightningFS>} */
const instances = new Map();

/**
 * @param {string} url a repository URL such as `https://github.com/owner/repo.git`
 * @returns {string} a stable id: lowercase host plus the path without `.git`
 */
export function repoIdForUrl(url) {
	const parsed = new URL(url);
	const path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
	return assertRepoId(`${parsed.host.toLowerCase()}${path}`);
}

/**
 * @param {string} repoId
 * @returns {string} the IndexedDB name for a repository
 */
export function repoFsName(repoId) {
	return `gitnote:${assertRepoId(repoId)}`;
}

/**
 * @param {string} repoId
 * @returns {LightningFS} the one file system instance for this repository
 */
export function openRepoFs(repoId) {
	const name = repoFsName(repoId);
	let fs = instances.get(name);
	if (!fs) {
		fs = new LightningFS(name);
		instances.set(name, fs);
	}
	return fs;
}

/**
 * Deletes everything stored for a repository on this device, including
 * unpushed commits.
 * @param {string} repoId
 * @returns {Promise<void>}
 */
export async function wipeRepoFs(repoId) {
	const fs = openRepoFs(repoId);
	await fs.promises.init(repoFsName(repoId), { wipe: true });
	await fs.promises.flush();
}

/**
 * @typedef {object} StorageManagerLike the part of `navigator.storage` used here
 * @property {() => Promise<boolean>} [persist]
 * @property {() => Promise<boolean>} [persisted]
 * @property {() => Promise<{ usage?: number, quota?: number }>} [estimate]
 */

/**
 * Asks the browser not to evict this origin's data under storage pressure.
 * Only unpushed commits are at risk if it does, but they exist nowhere else.
 * @param {StorageManagerLike | undefined} [storage] defaults to `navigator.storage`
 * @returns {Promise<boolean | null>} whether storage is persistent, or null when the API is missing
 */
export async function requestPersistentStorage(storage = defaultStorage()) {
	if (!storage?.persist) return null;
	if (storage.persisted && (await storage.persisted())) return true;
	return storage.persist();
}

/**
 * @typedef {object} StorageUsage
 * @property {number} usage bytes used by this origin
 * @property {number} quota bytes the origin may use
 * @property {number} ratio usage / quota
 * @property {boolean} nearlyFull at or above {@link STORAGE_WARN_RATIO}
 */

/**
 * @param {StorageManagerLike | undefined} [storage] defaults to `navigator.storage`
 * @returns {Promise<StorageUsage | null>} null when the browser does not report it
 */
export async function getStorageUsage(storage = defaultStorage()) {
	if (!storage?.estimate) return null;
	const { usage, quota } = await storage.estimate();
	if (typeof usage !== 'number' || typeof quota !== 'number' || quota <= 0) return null;
	const ratio = usage / quota;
	return { usage, quota, ratio, nearlyFull: ratio >= STORAGE_WARN_RATIO };
}

/**
 * @returns {StorageManagerLike | undefined}
 */
function defaultStorage() {
	return globalThis.navigator?.storage;
}

/**
 * @param {string} repoId
 * @returns {string}
 */
function assertRepoId(repoId) {
	if (!REPO_ID.test(repoId) || repoId.split('/').some((segment) => segment === '.' || segment === '..')) {
		throw new TypeError(`Not a valid repository id: ${repoId}`);
	}
	return repoId;
}
