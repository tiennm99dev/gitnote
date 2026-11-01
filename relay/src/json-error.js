/**
 * Builds the relay's JSON error response: `{ error, message }`, where `error`
 * is a stable machine-readable code and `message` is for people.
 * @param {number} status
 * @param {string} error
 * @param {string} message
 * @param {Record<string, unknown>} [extra] additional fields for the body
 * @param {HeadersInit} [headers]
 * @returns {Response}
 */
export function jsonError(status, error, message, extra = {}, headers = {}) {
	const response = Response.json({ ...extra, error, message }, { status, headers });
	response.headers.set('Cache-Control', 'no-store');
	return response;
}
