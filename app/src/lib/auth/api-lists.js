/**
 * Reading the list answers of the providers' REST APIs. Both number their pages,
 * so a list can be read without following a URL from a response, and a token is
 * only ever sent to the API root it was meant for.
 */

import { AuthError, AuthErrorCode } from './errors.js';

/** The page size every list asks for. */
export const PER_PAGE = 100;

/** How many pages of one list to read before saying the list was cut short. */
const MAX_PAGES = 10;

/**
 * Reads a page-numbered list until a page comes back short.
 * @param {(page: number) => Promise<unknown>} readPage
 * @returns {Promise<{ items: unknown[], truncated: boolean }>}
 */
export async function readPages(readPage) {
	/** @type {unknown[]} */
	const items = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const batch = await readPage(page);
		if (!Array.isArray(batch)) throw new AuthError(AuthErrorCode.UNAVAILABLE, 'The git host answered with an unexpected list.');
		items.push(...batch);
		if (batch.length < PER_PAGE) return { items, truncated: false };
	}
	return { items, truncated: true };
}

/**
 * @param {unknown[]} items a provider's branch list
 * @returns {string[]} the branch names
 */
export function branchNames(items) {
	return items.flatMap((item) => {
		const name = /** @type {{ name?: unknown } | null} */ (item)?.name;
		return typeof name === 'string' ? [name] : [];
	});
}

/**
 * @param {unknown} path a repository path from an API answer
 * @param {RegExp} shape the provider's own rule for its paths
 * @returns {path is string} safe to build a clone URL from
 */
export function isRepoPath(path, shape) {
	return typeof path === 'string' && shape.test(path) && path.split('/').every((segment) => segment !== '.' && segment !== '..');
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function optionalText(value) {
	return typeof value === 'string' && value !== '' ? value : null;
}
