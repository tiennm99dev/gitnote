/**
 * Environment variable that carries the token for live end-to-end runs.
 * When it is set, a run may send credentials, so it must not record artifacts
 * that capture requests: a Playwright trace stores every header, including
 * `Authorization`, and CI uploads failure artifacts from a public repository.
 */
export const E2E_TOKEN_ENV = 'GITNOTE_E2E_TOKEN';

/**
 * Picks the Playwright trace and screenshot modes for a run.
 * Credential-free runs keep traces and screenshots of failures for debugging;
 * a run with a token records neither.
 * @param {Record<string, string | undefined>} env Process environment.
 * @returns {{ trace: 'off' | 'retain-on-failure', screenshot: 'off' | 'only-on-failure' }}
 *   The modes to put under Playwright's `use` option.
 */
export function artifactPolicy(env) {
	const hasToken = Boolean(env[E2E_TOKEN_ENV]?.trim());
	return hasToken
		? { trace: 'off', screenshot: 'off' }
		: { trace: 'retain-on-failure', screenshot: 'only-on-failure' };
}
