import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { ErrorCode, GitEngineError, networkError, toGitEngineError } from './errors.js';

const { HttpError, GitPushError, PushRejectedError, MergeNotSupportedError, UserCanceledError } = git.Errors;

/**
 * @param {string[]} refErrors
 * @returns {InstanceType<typeof GitPushError>}
 */
function pushError(refErrors) {
	const refs = Object.fromEntries(refErrors.map((error, index) => [`refs/heads/b${index}`, { ok: false, error }]));
	return new GitPushError('rejected', /** @type {import('isomorphic-git').PushResult} */ ({ ok: false, error: null, refs }));
}

describe('toGitEngineError', () => {
	it('passes an engine error through unchanged', () => {
		const error = new GitEngineError(ErrorCode.DIRTY_TREE, 'dirty');
		expect(toGitEngineError(error)).toBe(error);
	});

	it('names the relay cap on a 413', () => {
		const mapped = toGitEngineError(new HttpError(413, 'Payload Too Large', ''));
		expect(mapped.code).toBe(ErrorCode.PUSH_TOO_LARGE);
		expect(mapped.message).toContain('95.0 MB');
	});

	it('maps GH001 from the remote messages', () => {
		const mapped = toGitEngineError(pushError(['pre-receive hook declined']), {
			remoteMessages: [
				"remote: error: File big.bin is 120.00 MB; this exceeds GitHub's file size limit of 100.00 MB",
				'remote: error: GH001: Large files detected.'
			]
		});
		expect(mapped.code).toBe(ErrorCode.HOST_FILE_TOO_LARGE);
		expect(mapped.message).toContain('100 MiB');
		expect(mapped.detail.remote).toContain('remote: error: GH001: Large files detected.');
	});

	it.each([
		'remote: GitLab: Your push to this repository would cause it to exceed the size limit of 9.8 GB',
		'remote: GitLab: Your push has been rejected, because this repository has exceeded its size limit of 10 GB by 1.8 GB',
		'fatal: pack exceeds maximum allowed size'
	])('maps the GitLab rejection %j', (line) => {
		const mapped = toGitEngineError(pushError(['pre-receive hook declined']), { remoteMessages: [line] });
		expect(mapped.code).toBe(ErrorCode.HOST_REPO_TOO_LARGE);
	});

	it.each([
		'remote: GitLab: File "big.bin" is larger than the allowed size of 50 MiB',
		'remote: GitLab: You are attempting to check in one or more files which exceed the 100.0 MiB limit'
	])('maps the GitLab file rule %j', (line) => {
		const mapped = toGitEngineError(pushError(['pre-receive hook declined']), { remoteMessages: [line] });
		expect(mapped.code).toBe(ErrorCode.HOST_FILE_TOO_LARGE);
		expect(mapped.message).toContain('GitLab');
	});

	it('maps a client-side and a server-side non-fast-forward', () => {
		expect(toGitEngineError(new PushRejectedError('not-fast-forward')).code).toBe(ErrorCode.NON_FAST_FORWARD);
		expect(toGitEngineError(pushError(['non-fast-forward'])).code).toBe(ErrorCode.NON_FAST_FORWARD);
	});

	it('reports any other rejection with the host text', () => {
		const mapped = toGitEngineError(pushError(['protected branch hook declined']));
		expect(mapped.code).toBe(ErrorCode.PUSH_REJECTED);
		expect(mapped.message).toContain('protected branch hook declined');
	});

	it.each([
		[401, '', ErrorCode.AUTH_REQUIRED],
		[403, '', ErrorCode.FORBIDDEN],
		[403, '{"error":"git_target_not_allowed","message":"no"}', ErrorCode.HOST_NOT_ALLOWED],
		[403, '{"error":"origin_not_allowed","message":"no"}', ErrorCode.ORIGIN_NOT_ALLOWED],
		[404, '', ErrorCode.REPO_NOT_FOUND],
		[429, '', ErrorCode.RATE_LIMITED],
		[502, '{"error":"repo_moved","message":"moved"}', ErrorCode.REPO_MOVED],
		[502, '{"error":"upstream_unreachable","message":"down"}', ErrorCode.HOST_UNREACHABLE],
		[502, 'not json', ErrorCode.HTTP],
		[500, '', ErrorCode.HTTP]
	])('maps HTTP %i with body %j', (status, body, code) => {
		expect(toGitEngineError(new HttpError(status, '', body)).code).toBe(code);
	});

	it('maps cancellation, however it arrived', () => {
		expect(toGitEngineError(new UserCanceledError()).code).toBe(ErrorCode.CANCELLED);
		expect(toGitEngineError(new DOMException('aborted', 'AbortError')).code).toBe(ErrorCode.CANCELLED);
	});

	it('leaves a TypeError from anything but the HTTP client as a bug, with its message', () => {
		const mapped = toGitEngineError(new TypeError('x is not a function'));
		expect(mapped.code).toBe(ErrorCode.UNKNOWN);
		expect(mapped.message).toContain('x is not a function');
	});

	it('keeps the network error from the HTTP client', () => {
		const error = networkError(new TypeError('Failed to fetch'));
		expect(toGitEngineError(error)).toBe(error);
		expect(error.code).toBe(ErrorCode.NETWORK);
	});

	it('names the files in a checkout conflict', () => {
		const mapped = toGitEngineError(new git.Errors.CheckoutConflictError(['drafts/x.md']));
		expect(mapped.code).toBe(ErrorCode.CHECKOUT_CONFLICT);
		expect(mapped.detail.files).toEqual(['drafts/x.md']);
	});

	it('maps an unsupported merge', () => {
		expect(toGitEngineError(new MergeNotSupportedError()).code).toBe(ErrorCode.MERGE_NOT_SUPPORTED);
	});

	it('keeps the original error as the cause', () => {
		const original = new Error('disk full');
		const mapped = toGitEngineError(original);
		expect(mapped.code).toBe(ErrorCode.UNKNOWN);
		expect(mapped.message).toContain('disk full');
		expect(mapped.cause).toBe(original);
	});

	it('handles a thrown non-error', () => {
		expect(toGitEngineError('boom').code).toBe(ErrorCode.UNKNOWN);
	});
});
