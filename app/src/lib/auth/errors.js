/**
 * Why a sign-in or an account call failed, with a sentence for the user. A
 * message never holds a token.
 */

export const AuthErrorCode = Object.freeze({
	/** The stored sign-in is dead and a new one fixes it. Local clones stay. */
	SIGN_IN_REQUIRED: 'sign_in_required',
	/** No account is connected for the provider. */
	NOT_CONNECTED: 'not_connected',
	/** The redirect does not match a sign-in this device started. */
	BAD_STATE: 'bad_state',
	/** The provider refused the sign-in or the code. */
	SIGN_IN_FAILED: 'sign_in_failed',
	/** A pasted token was malformed or refused. */
	TOKEN_REJECTED: 'token_rejected',
	/** Valid sign-in, but this resource is off limits. */
	FORBIDDEN: 'forbidden',
	NOT_FOUND: 'not_found',
	/** The network or the provider failed; trying again later may work. */
	UNAVAILABLE: 'unavailable',
	/** The device's token storage failed. */
	STORAGE: 'storage'
});

/** @typedef {typeof AuthErrorCode[keyof typeof AuthErrorCode]} AuthErrorCodeValue */

export class AuthError extends Error {
	/**
	 * @param {AuthErrorCodeValue} code
	 * @param {string} message a sentence for the user
	 * @param {{ cause?: unknown }} [options]
	 */
	constructor(code, message, { cause } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'AuthError';
		this.code = code;
	}
}
