/**
 * One error type for everything the git engine reports, with a stable `code`
 * for the UI and a sentence a user can act on. `toGitEngineError` maps
 * isomorphic-git, relay and git host failures onto it.
 */

import { formatBytes, RELAY_MAX_BODY_BYTES } from './limits.js';

/** @typedef {typeof ErrorCode[keyof typeof ErrorCode]} ErrorCodeValue */

export const ErrorCode = Object.freeze({
	ALREADY_CLONED: 'already_cloned',
	EMPTY_REPO: 'empty_repo',
	NOT_CLONED: 'not_cloned',
	REPO_DAMAGED: 'repo_damaged',
	CANCELLED: 'cancelled',
	INVALID_PATH: 'invalid_path',
	PATH_NOT_FOUND: 'path_not_found',
	PATH_EXISTS: 'path_exists',
	INVALID_ARGUMENT: 'invalid_argument',
	NOTHING_TO_COMMIT: 'nothing_to_commit',
	DIRTY_TREE: 'dirty_tree',
	MERGE_IN_PROGRESS: 'merge_in_progress',
	MERGE_CONFLICT: 'merge_conflict',
	MERGE_NOT_SUPPORTED: 'merge_not_supported',
	NO_OPEN_MERGE: 'no_open_merge',
	CONFLICTS_UNRESOLVED: 'conflicts_unresolved',
	CHECKOUT_CONFLICT: 'checkout_conflict',
	FILE_TOO_LARGE: 'file_too_large',
	PUSH_TOO_LARGE: 'push_too_large',
	HOST_FILE_TOO_LARGE: 'host_file_too_large',
	HOST_REPO_TOO_LARGE: 'host_repo_too_large',
	NON_FAST_FORWARD: 'non_fast_forward',
	PUSH_REJECTED: 'push_rejected',
	AUTH_REQUIRED: 'auth_required',
	FORBIDDEN: 'forbidden',
	REPO_NOT_FOUND: 'repo_not_found',
	REPO_MOVED: 'repo_moved',
	HOST_NOT_ALLOWED: 'host_not_allowed',
	ORIGIN_NOT_ALLOWED: 'origin_not_allowed',
	HOST_UNREACHABLE: 'host_unreachable',
	RATE_LIMITED: 'rate_limited',
	NETWORK: 'network',
	HTTP: 'http',
	UNKNOWN: 'unknown'
});

export class GitEngineError extends Error {
	/**
	 * @param {ErrorCodeValue} code
	 * @param {string} message a sentence for the user
	 * @param {{ cause?: unknown, detail?: Record<string, unknown> }} [options]
	 */
	constructor(code, message, { cause, detail = {} } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'GitEngineError';
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Host rejections that arrive as `remote:` lines or ref errors on a push.
 * GitHub names its large-file check GH001; GitLab rejects pushes that would
 * take a repo past its size limit, and pushes a push rule blocks by file size.
 * @type {ReadonlyArray<{ code: ErrorCodeValue, pattern: RegExp, message: string }>}
 */
const HOST_REJECTIONS = Object.freeze([
	{
		code: ErrorCode.HOST_FILE_TOO_LARGE,
		pattern: /\bGH001\b|exceeds GitHub's file size limit/i,
		message: 'GitHub rejected the push because a file is over its 100 MiB limit. Remove the file from the unpushed commits and push again.'
	},
	{
		code: ErrorCode.HOST_FILE_TOO_LARGE,
		pattern: /larger than the allowed size|exceed the [\d.]+ ?\w+ limit|file .* is too large/i,
		message: 'GitLab rejected the push because a file is over the size its push rules allow. Remove the file from the unpushed commits and push again.'
	},
	{
		code: ErrorCode.HOST_REPO_TOO_LARGE,
		pattern: /exceed(?:ed)? (?:its|the) size limit|pack exceeds maximum allowed size/i,
		message: 'The git host rejected the push because the repository or the push is over its size limit.'
	}
]);

/**
 * What this module reads from a thrown value; every field is checked before use.
 * @typedef {object} ThrownError
 * @property {unknown} [code]
 * @property {unknown} [name]
 * @property {unknown} [message]
 * @property {{ statusCode?: unknown, response?: unknown, reason?: unknown, filepaths?: unknown, result?: { refs?: Record<string, unknown> } }} [data]
 */

/**
 * @param {unknown} value
 * @returns {value is ThrownError}
 */
function isObject(value) {
	return typeof value === 'object' && value !== null;
}

/**
 * Reads the relay's JSON error body (`{ error, message }`) from an HttpError.
 * @param {unknown} response
 * @returns {{ error?: string, message?: string } | null}
 */
function relayErrorBody(response) {
	if (typeof response !== 'string' || !response.startsWith('{')) return null;
	try {
		const body = /** @type {{ error?: unknown, message?: string } | null} */ (JSON.parse(response));
		return typeof body?.error === 'string' ? { error: body.error, message: body.message } : null;
	} catch {
		return null;
	}
}

/**
 * @param {number} status
 * @param {unknown} response the response body text, when isomorphic-git kept it
 * @param {unknown} cause
 * @returns {GitEngineError}
 */
function fromHttpStatus(status, response, cause) {
	const relay = relayErrorBody(response);
	const detail = { status, relayError: relay?.error };
	const make = (/** @type {ErrorCodeValue} */ code, /** @type {string} */ message) =>
		new GitEngineError(code, message, { cause, detail });

	if (status === 401) {
		return make(ErrorCode.AUTH_REQUIRED, 'The git host needs you to sign in again, or the token has expired.');
	}
	if (status === 413) {
		return make(
			ErrorCode.PUSH_TOO_LARGE,
			`The push is over the relay's per-push limit of ${formatBytes(RELAY_MAX_BODY_BYTES)}. Undo the unpushed commits, then make smaller commits and push after each one.`
		);
	}
	if (status === 403 && relay?.error?.startsWith('git_')) {
		return make(ErrorCode.HOST_NOT_ALLOWED, 'The relay only reaches GitHub and GitLab repositories.');
	}
	if (status === 403 && relay?.error === 'origin_not_allowed') {
		return make(ErrorCode.ORIGIN_NOT_ALLOWED, 'The relay does not accept requests from this address. Open gitnote from its own address.');
	}
	if (status === 403) {
		return make(ErrorCode.FORBIDDEN, 'The git host refused access. Check that the token can read and write this repository.');
	}
	if (status === 404) {
		return make(ErrorCode.REPO_NOT_FOUND, 'The repository was not found, or the token cannot see it.');
	}
	if (status === 429) {
		return make(ErrorCode.RATE_LIMITED, 'Too many requests in a short time. Wait a minute and try again.');
	}
	if (status === 502 && relay?.error === 'repo_moved') {
		return make(ErrorCode.REPO_MOVED, 'The git host redirected this repository; it may have been renamed or moved. Update the repository URL.');
	}
	if (status === 502 && relay?.error === 'upstream_unreachable') {
		return make(ErrorCode.HOST_UNREACHABLE, 'The relay could not reach the git host. Try again later.');
	}
	return make(ErrorCode.HTTP, `The git host answered with HTTP ${status}.`);
}

/**
 * @param {string[]} lines remote messages and ref errors from a push
 * @param {unknown} cause
 * @returns {GitEngineError | null}
 */
function fromHostRejection(lines, cause) {
	const text = lines.join('\n');
	for (const rule of HOST_REJECTIONS) {
		if (rule.pattern.test(text)) return new GitEngineError(rule.code, rule.message, { cause, detail: { remote: lines } });
	}
	return null;
}

/**
 * Maps any failure from a git operation onto a GitEngineError.
 * @param {unknown} error
 * @param {{ remoteMessages?: string[] }} [context] `remote:` lines the host sent during a push
 * @returns {GitEngineError}
 */
export function toGitEngineError(error, { remoteMessages = [] } = {}) {
	if (error instanceof GitEngineError) return error;
	if (!isObject(error)) {
		return new GitEngineError(ErrorCode.UNKNOWN, `Git failed: ${String(error)}`, { cause: error });
	}

	const code = typeof error.code === 'string' ? error.code : '';
	const name = typeof error.name === 'string' ? error.name : '';
	const message = typeof error.message === 'string' ? error.message : '';

	if (code === 'UserCanceledError' || name === 'AbortError') {
		return new GitEngineError(ErrorCode.CANCELLED, 'The operation was cancelled.', { cause: error });
	}
	if (code === 'HttpError') {
		return fromHttpStatus(Number(error.data?.statusCode), error.data?.response, error);
	}
	if (code === 'GitPushError' || code === 'PushRejectedError') {
		const refErrors = Object.values(error.data?.result?.refs ?? {})
			.map((ref) => {
				const text = /** @type {{ error?: unknown } | null} */ (ref)?.error;
				return typeof text === 'string' ? text : '';
			})
			.filter(Boolean);
		const rejection = fromHostRejection([...remoteMessages, ...refErrors], error);
		if (rejection) return rejection;
		if (error.data?.reason === 'not-fast-forward' || refErrors.some((text) => /fast-forward|fetch first/i.test(text))) {
			return new GitEngineError(ErrorCode.NON_FAST_FORWARD, 'The remote branch has commits you do not have. Pull first, then push.', {
				cause: error
			});
		}
		return new GitEngineError(ErrorCode.PUSH_REJECTED, `The git host rejected the push: ${[...refErrors, ...remoteMessages].join('; ') || message}`, {
			cause: error,
			detail: { remote: remoteMessages }
		});
	}
	if (code === 'MergeNotSupportedError') {
		return new GitEngineError(
			ErrorCode.MERGE_NOT_SUPPORTED,
			'These changes cannot be merged automatically (for example, a file on one side is a folder on the other). Nothing was changed.',
			{ cause: error }
		);
	}
	if (code === 'NotFoundError' && /refs\/remotes|HEAD/.test(message)) {
		return new GitEngineError(ErrorCode.NOT_CLONED, 'This repository has not been cloned on this device yet.', { cause: error });
	}
	if (code === 'CheckoutConflictError') {
		return new GitEngineError(ErrorCode.CHECKOUT_CONFLICT, 'Pulling would overwrite files on this device that git does not track. Move them, then pull again.', {
			cause: error,
			detail: { files: error.data?.filepaths }
		});
	}
	return new GitEngineError(ErrorCode.UNKNOWN, `Git failed: ${message || name || 'unknown error'}`, { cause: error });
}

/**
 * The failure `fetch` reports when the network or the relay is down. Only the
 * HTTP client can tell it from any other TypeError, so it wraps it here.
 * @param {unknown} cause
 * @returns {GitEngineError}
 */
export function networkError(cause) {
	return new GitEngineError(ErrorCode.NETWORK, 'Could not reach the relay. Check the connection and try again.', { cause });
}
