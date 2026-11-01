/**
 * The accounts on this device: signing in, keeping tokens fresh, and handing
 * them to REST calls and git.
 *
 * Both providers rotate refresh tokens, so a used one stops working. Every
 * refresh and every change to a stored sign-in therefore holds a per-provider
 * lock across tabs, and reads the store again inside it: a tab that waited
 * finds the pair the winner stored instead of spending a dead refresh token.
 *
 * Tokens go only to the provider's own API and git host (git through the relay).
 * A failed refresh never touches local clones.
 */

import { ErrorCode, GitEngineError } from '../git/errors.js';
import { withNamedLock } from '../git/lock.js';
import { AuthError, AuthErrorCode } from './errors.js';
import { hasPending, isTokenText, pkceChallenge, randomToken, REQUEST_TIMEOUT_MS, savePending, takePending } from './oauth.js';
import { getProvider, isProviderGitUrl, PROVIDER_IDS, WEB_CALLBACK_PATH } from './providers.js';

/** @typedef {import('../git/limits.js').ProviderId} ProviderId */
/** @typedef {import('./oauth.js').TokenSet} TokenSet */
/** @typedef {import('../git/lock.js').LockManagerLike} LockManagerLike */

/** Refresh this long before a token expires, so one never dies mid-operation. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * @typedef {object} AccountUser
 * @property {string} login
 * @property {string | null} name
 * @property {string | null} email
 */

/**
 * One stored sign-in. `kind` is `oauth` for a provider sign-in and `token` for a
 * pasted token, which cannot refresh.
 * @typedef {TokenSet & { kind: 'oauth' | 'token', user: AccountUser, redirectUri?: string, needsSignIn?: boolean }} Credential
 */

/**
 * What the UI may know about an account. It holds no token.
 * @typedef {object} Account
 * @property {ProviderId} provider
 * @property {'oauth' | 'token'} kind
 * @property {AccountUser} user
 * @property {boolean} needsSignIn the sign-in died; local clones are still here
 */

/**
 * A repository as the provider lists it.
 * @typedef {object} RemoteRepo
 * @property {ProviderId} provider
 * @property {number} id the provider's own id
 * @property {string} fullName `owner/name`, or a GitLab path
 * @property {string} url the clone URL, always on the provider's git host
 * @property {string | null} defaultBranch
 * @property {number | null} sizeBytes null when the provider does not say
 * @property {boolean} isPrivate
 * @property {boolean} empty known to have no commits, so it cannot be cloned
 */

/**
 * @typedef {object} RepoList
 * @property {RemoteRepo[]} repos
 * @property {boolean} truncated more exist than were read
 * @property {string} [installUrl] where to give the sign-in access to more repos
 */

/**
 * A REST call with this account's token, relative to the provider's API root.
 * @typedef {(path: string) => Promise<unknown>} ApiCall
 */

/**
 * What each provider's module supplies.
 * @typedef {object} ProviderAdapter
 * @property {boolean} signInAvailable whether this build has a client ID for it
 * @property {(options: { state: string, challenge: string, redirectUri: string }) => string} authorizeUrl
 * @property {(options: { code: string, verifier: string, redirectUri: string, now: number }) => Promise<TokenSet>} exchangeCode
 * @property {(options: { refreshToken: string, redirectUri?: string, now: number }) => Promise<TokenSet>} refresh
 * @property {(api: ApiCall) => Promise<AccountUser>} fetchUser
 * @property {(api: ApiCall, kind: 'oauth' | 'token') => Promise<RepoList>} listRepos
 * @property {(api: ApiCall, repo: RemoteRepo) => Promise<string[]>} listBranches
 */

/**
 * @typedef {object} SessionOptions
 * @property {import('./token-store.js').TokenStore<Credential>} store
 * @property {Record<ProviderId, ProviderAdapter>} adapters
 * @property {Storage} [pendingStorage] holds sign-ins awaiting their redirect; defaults to localStorage
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now]
 * @property {LockManagerLike | null} [locks] defaults to `navigator.locks`
 */

// The session's operations are inferred; `AuthSession` below names them.
// eslint-disable-next-line jsdoc/require-returns
/**
 * @param {SessionOptions} options
 */
export function createAuthSession({ store, adapters, pendingStorage, fetch: fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, locks }) {
	/**
	 * @template T
	 * @param {ProviderId} provider
	 * @param {() => Promise<T>} operation
	 * @returns {Promise<T>}
	 */
	const withLock = (provider, operation) => withNamedLock(`gitnote:auth:${provider}`, operation, locks === undefined ? undefined : { locks });

	/** @returns {Storage} */
	const pending = () => pendingStorage ?? globalThis.localStorage;

	/**
	 * @param {ProviderId} provider
	 * @returns {AuthError}
	 */
	const signInRequired = (provider) =>
		new AuthError(AuthErrorCode.SIGN_IN_REQUIRED, `Your ${getProvider(provider).label} sign-in has ended. Sign in again; your notes on this device are safe.`);

	/**
	 * Flags a dead sign-in so every page can ask for a new one. Holds the lock.
	 * @param {ProviderId} provider
	 * @param {Credential} credential
	 * @returns {Promise<void>}
	 */
	const markNeedsSignIn = (provider, credential) => store.set(provider, { ...credential, needsSignIn: true });

	/**
	 * Spends the refresh token and stores the new pair. Holds the lock.
	 * @param {ProviderId} provider
	 * @param {Credential} credential
	 * @returns {Promise<Credential>}
	 */
	const refreshLocked = async (provider, credential) => {
		const { refreshToken, refreshExpiresAt } = credential;
		if (!refreshToken || (refreshExpiresAt !== undefined && refreshExpiresAt <= now())) {
			await markNeedsSignIn(provider, credential);
			throw signInRequired(provider);
		}
		/** @type {TokenSet} */
		let tokens;
		try {
			tokens = await adapters[provider].refresh({ refreshToken, redirectUri: credential.redirectUri, now: now() });
		} catch (error) {
			if (error instanceof AuthError && error.code === AuthErrorCode.SIGN_IN_REQUIRED) await markNeedsSignIn(provider, credential);
			throw error;
		}
		// The answer replaces the stored pair in one write. Expiries come only from
		// the answer; a provider that sends no new refresh token keeps the old one.
		/** @type {Credential} */
		const next = { kind: credential.kind, user: credential.user, redirectUri: credential.redirectUri, refreshToken, refreshExpiresAt, ...tokens };
		await store.set(provider, next);
		return next;
	};

	/**
	 * @param {ProviderId} provider
	 * @returns {Promise<Credential>} the stored credential, unless there is none or it died
	 */
	const readUsable = async (provider) => {
		const stored = await store.get(provider);
		if (!stored) throw new AuthError(AuthErrorCode.NOT_CONNECTED, `No ${getProvider(provider).label} account is connected.`);
		if (stored.needsSignIn) throw signInRequired(provider);
		return stored;
	};

	/**
	 * @param {Credential} credential
	 * @returns {boolean} no refresh is due
	 */
	const isFresh = ({ expiresAt }) => expiresAt === undefined || expiresAt - now() > REFRESH_MARGIN_MS;

	/**
	 * The stored credential, refreshed if it is about to expire. If that refresh
	 * cannot reach the provider, a token still in date goes on being used.
	 * @param {ProviderId} provider
	 * @returns {Promise<Credential>}
	 */
	const liveCredential = async (provider) => {
		const stored = await readUsable(provider);
		if (isFresh(stored)) return stored;
		return withLock(provider, async () => {
			const current = await readUsable(provider);
			if (isFresh(current) || current.expiresAt === undefined) return current;
			try {
				return await refreshLocked(provider, current);
			} catch (error) {
				const stillValid = current.expiresAt > now();
				if (stillValid && error instanceof AuthError && error.code === AuthErrorCode.UNAVAILABLE) return current;
				throw error;
			}
		});
	};

	/**
	 * After a host refused `refusedToken`: the token another tab already stored,
	 * or a refreshed one, or an end to the sign-in.
	 * @param {ProviderId} provider
	 * @param {string} refusedToken
	 * @returns {Promise<Credential>}
	 */
	const replaceRefused = (provider, refusedToken) =>
		withLock(provider, async () => {
			const current = await readUsable(provider);
			if (current.accessToken !== refusedToken) return current;
			if (current.kind === 'oauth') return refreshLocked(provider, current);
			await markNeedsSignIn(provider, current);
			throw signInRequired(provider);
		});

	/**
	 * Calls the provider's REST API once with a token.
	 * @param {ProviderId} provider
	 * @param {string} path
	 * @param {string} token
	 * @returns {Promise<Response>}
	 */
	const sendApi = async (provider, path, token) => {
		const { apiBase, apiHeaders, label } = getProvider(provider);
		try {
			return await fetchImpl(`${apiBase}${path}`, {
				headers: { ...apiHeaders, Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				redirect: 'error',
				credentials: 'omit'
			});
		} catch (cause) {
			throw new AuthError(AuthErrorCode.UNAVAILABLE, `Could not reach ${label}. Check the connection and try again.`, { cause });
		}
	};

	/**
	 * @param {ProviderId} provider
	 * @param {Response} response
	 * @returns {Promise<unknown>} the JSON of a 2xx answer
	 */
	const readApi = async (provider, response) => {
		const { label } = getProvider(provider);
		if (response.status === 403) throw new AuthError(AuthErrorCode.FORBIDDEN, `${label} refused this request. The sign-in may lack access, or the API rate limit may be used up.`);
		if (response.status === 404) throw new AuthError(AuthErrorCode.NOT_FOUND, `${label} could not find that, or this sign-in cannot see it.`);
		if (!response.ok) throw new AuthError(AuthErrorCode.UNAVAILABLE, `${label} answered with status ${response.status}. Try again later.`);
		try {
			return await response.json();
		} catch (cause) {
			throw new AuthError(AuthErrorCode.UNAVAILABLE, `${label} answered with something unreadable.`, { cause });
		}
	};

	/**
	 * @param {ProviderId} provider
	 * @returns {ApiCall} REST calls that refresh and retry once on a 401
	 */
	const apiFor = (provider) => async (path) => {
		const credential = await liveCredential(provider);
		let response = await sendApi(provider, path, credential.accessToken);
		if (response.status === 401) {
			const replaced = await replaceRefused(provider, credential.accessToken);
			response = await sendApi(provider, path, replaced.accessToken);
			if (response.status === 401) {
				await withLock(provider, async () => {
					const current = await store.get(provider);
					if (current?.accessToken === replaced.accessToken) await markNeedsSignIn(provider, current);
				});
				throw signInRequired(provider);
			}
		}
		return readApi(provider, response);
	};

	/**
	 * @param {ProviderId} provider
	 * @param {string} token
	 * @returns {Promise<AccountUser>} the account behind a token not yet stored
	 */
	const fetchUserWith = (provider, token) =>
		adapters[provider].fetchUser(async (path) => {
			const response = await sendApi(provider, path, token);
			if (response.status === 401) {
				throw new AuthError(AuthErrorCode.TOKEN_REJECTED, `${getProvider(provider).label} did not accept this token. Check that it is complete and has not expired.`);
			}
			return readApi(provider, response);
		});

	/**
	 * Asks the REST API about a token a git host refused. Only a refusal here ends
	 * the sign-in, which the API call records; any other failure says nothing.
	 * @param {ProviderId} provider
	 * @returns {Promise<void>}
	 */
	const confirmTokenAlive = async (provider) => {
		try {
			await apiFor(provider)('/user');
		} catch (error) {
			if (error instanceof AuthError && error.code === AuthErrorCode.SIGN_IN_REQUIRED) throw error;
		}
	};

	return {
		/**
		 * @param {ProviderId} provider
		 * @returns {boolean} whether this build can offer the provider's sign-in button
		 */
		signInAvailable: (provider) => adapters[provider].signInAvailable,

		/** @returns {Promise<Account[]>} the connected accounts */
		async listAccounts() {
			/** @type {Account[]} */
			const accounts = [];
			for (const provider of PROVIDER_IDS) {
				const credential = await store.get(provider);
				if (credential) accounts.push({ provider, kind: credential.kind, user: credential.user, needsSignIn: credential.needsSignIn === true });
			}
			return accounts;
		},

		/**
		 * Starts a provider sign-in.
		 * @param {ProviderId} provider
		 * @param {{ redirectUri?: string }} [options] defaults to this site's callback page
		 * @returns {Promise<string>} the URL to send the user to
		 */
		async beginSignIn(provider, { redirectUri = `${globalThis.location?.origin}${WEB_CALLBACK_PATH}` } = {}) {
			const adapter = adapters[provider];
			if (!adapter.signInAvailable) throw new AuthError(AuthErrorCode.SIGN_IN_FAILED, `${getProvider(provider).label} sign-in is not set up in this build. Paste a token instead.`);
			const state = randomToken();
			const verifier = randomToken();
			savePending(pending(), state, { provider, verifier, redirectUri, createdAt: now() }, now());
			return adapter.authorizeUrl({ state, challenge: await pkceChallenge(verifier), redirectUri });
		},

		/**
		 * @param {string} callbackUrl
		 * @returns {boolean} whether `completeSignIn` would find the sign-in this URL belongs to
		 */
		isAwaitedCallback(callbackUrl) {
			return hasPending(pending(), new URL(callbackUrl).searchParams.get('state') ?? '', now());
		},

		/**
		 * Finishes a sign-in from the URL the provider redirected to. The `state`
		 * must match a sign-in this device started, before anything else in the
		 * URL counts.
		 * @param {string} callbackUrl
		 * @returns {Promise<Account>}
		 */
		async completeSignIn(callbackUrl) {
			const { searchParams } = new URL(callbackUrl);
			const entry = takePending(pending(), searchParams.get('state') ?? '', now());
			if (!entry) {
				throw new AuthError(AuthErrorCode.BAD_STATE, 'This sign-in did not start on this device, or it took too long. Start it again.');
			}
			const { provider, verifier, redirectUri } = entry;
			const { label } = getProvider(provider);
			if (searchParams.has('error')) {
				const reason = searchParams.get('error') === 'access_denied' ? 'You declined access.' : (searchParams.get('error_description') ?? 'The provider reported an error.');
				throw new AuthError(AuthErrorCode.SIGN_IN_FAILED, `${label} sign-in did not finish. ${reason}`);
			}
			const code = searchParams.get('code');
			if (!code) throw new AuthError(AuthErrorCode.SIGN_IN_FAILED, `${label} sent no sign-in code. Start it again.`);
			const tokens = await adapters[provider].exchangeCode({ code, verifier, redirectUri, now: now() });
			const user = await fetchUserWith(provider, tokens.accessToken);
			/** @type {Credential} */
			const credential = { kind: 'oauth', user, redirectUri, ...tokens };
			await withLock(provider, () => store.set(provider, credential));
			return { provider, kind: 'oauth', user, needsSignIn: false };
		},

		/**
		 * Checks a pasted token against the provider, then stores it. Nothing is
		 * stored unless the provider accepts it.
		 * @param {ProviderId} provider
		 * @param {string} input
		 * @returns {Promise<Account>}
		 */
		async connectWithToken(provider, input) {
			const token = input.trim();
			if (!isTokenText(token)) throw new AuthError(AuthErrorCode.TOKEN_REJECTED, 'That does not look like a token: it must be one line with no spaces.');
			const user = await fetchUserWith(provider, token);
			await withLock(provider, () => store.set(provider, { kind: 'token', accessToken: token, user }));
			return { provider, kind: 'token', user, needsSignIn: false };
		},

		/**
		 * Forgets the sign-in. Holds the lock, so a refresh in progress cannot
		 * store a token back afterwards. Local clones are the caller's choice.
		 * @param {ProviderId} provider
		 * @returns {Promise<void>}
		 */
		signOut: (provider) => withLock(provider, () => store.remove(provider)),

		/**
		 * @param {ProviderId} provider
		 * @returns {Promise<RepoList>}
		 */
		async listRepos(provider) {
			const { kind } = await liveCredential(provider);
			return adapters[provider].listRepos(apiFor(provider), kind);
		},

		/**
		 * @param {RemoteRepo} repo
		 * @returns {Promise<string[]>}
		 */
		listBranches: (repo) => adapters[repo.provider].listBranches(apiFor(repo.provider), repo),

		/**
		 * The credential source for one repository's git operations. A token goes
		 * out only for that provider's own host. A host's refusal gets one refreshed
		 * token, as the engine asks only once per operation.
		 *
		 * A git 401 on a pasted token may be about this repo alone, so it ends the
		 * sign-in only if the provider's API refuses the token too.
		 * @param {ProviderId} provider
		 * @returns {import('../git/http.js').CredentialSource}
		 */
		gitCredentials(provider) {
			const { gitUsername, label } = getProvider(provider);
			/** @type {string | undefined} */
			let lastToken;
			return async ({ url, failed }) => {
				if (!isProviderGitUrl(provider, url)) throw new GitEngineError(ErrorCode.HOST_NOT_ALLOWED, `This repository is not on ${label}, so its sign-in was not sent.`);
				try {
					if (failed && lastToken !== undefined) {
						const stored = await readUsable(provider);
						if (stored.kind === 'token' && stored.accessToken === lastToken) {
							await confirmTokenAlive(provider);
							return null;
						}
					}
					const credential = failed && lastToken !== undefined ? await replaceRefused(provider, lastToken) : await liveCredential(provider);
					lastToken = credential.accessToken;
					return { username: gitUsername, password: credential.accessToken };
				} catch (error) {
					throw toGitError(error);
				}
			};
		}
	};
}

/**
 * Git operations report GitEngineErrors, whose codes the UI already handles.
 * @param {unknown} error
 * @returns {unknown}
 */
function toGitError(error) {
	if (!(error instanceof AuthError)) return error;
	const code = error.code === AuthErrorCode.UNAVAILABLE ? ErrorCode.NETWORK : ErrorCode.AUTH_REQUIRED;
	return new GitEngineError(code, error.message, { cause: error });
}

/** @typedef {ReturnType<typeof createAuthSession>} AuthSession */
