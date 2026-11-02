/**
 * Repo ids hold slashes (`github.com/owner/repo`), but an id is one URL segment.
 * Percent-encoding is not enough: Cloudflare Static Assets redirects a path holding
 * `%2F` to its decoded form, so a reload would land on a different route. `~` is
 * not allowed in a GitHub or GitLab path, so the swap is reversible.
 */

/**
 * @param {string} id repo id
 * @returns {string} the id as one URL segment
 */
export function repoRouteId(id) {
	return encodeURIComponent(id.replaceAll('/', '~'));
}

/**
 * @param {string} param the already-decoded `[id]` route param
 * @returns {string} the repo id
 */
export function repoIdFromRoute(param) {
	return param.replaceAll('~', '/');
}
