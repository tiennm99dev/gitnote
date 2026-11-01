/**
 * This device's commit author and autosave choice, in localStorage. Autosave is
 * a beta and stays off until the user turns it on.
 */

const KEY = 'gitnote.settings';

export const AUTOSAVE_INTERVALS = /** @type {const} */ ([1, 5, 10, 30]);

const DEFAULT_INTERVAL = 5;

/**
 * @typedef {object} Settings
 * @property {string} authorName empty means the account's name
 * @property {string} authorEmail empty means the account's email
 * @property {boolean} autosave
 * @property {number} intervalMinutes one of `AUTOSAVE_INTERVALS`
 */

/** @typedef {import('../git/repo.js').Author} Author */

/**
 * @param {Storage} [storage]
 * @returns {Settings} what is stored, with defaults for anything missing or unreadable
 */
export function loadSettings(storage = globalThis.localStorage) {
	/** @type {Partial<Settings> | null} */
	let stored = null;
	try {
		stored = JSON.parse(storage.getItem(KEY) ?? 'null');
	} catch {
		// An unreadable record means the defaults.
	}
	const interval = Number(stored?.intervalMinutes);
	return {
		authorName: typeof stored?.authorName === 'string' ? stored.authorName : '',
		authorEmail: typeof stored?.authorEmail === 'string' ? stored.authorEmail : '',
		autosave: stored?.autosave === true,
		intervalMinutes: AUTOSAVE_INTERVALS.some((minutes) => minutes === interval) ? interval : DEFAULT_INTERVAL
	};
}

/**
 * @param {Settings} settings
 * @param {Storage} [storage]
 * @returns {void}
 */
export function saveSettings(settings, storage = globalThis.localStorage) {
	storage.setItem(KEY, JSON.stringify(settings));
}

/**
 * @param {StorageEvent} event
 * @returns {boolean} whether another tab changed the settings
 */
export function isSettingsChange(event) {
	return event.key === KEY || event.key === null;
}

/**
 * The author a provider account implies. GitHub leaves `email` empty unless the
 * user made one public, and it attributes commits to its own no-reply address.
 * @param {import('../git/limits.js').ProviderId} provider
 * @param {import('../auth/session.js').AccountUser | null | undefined} user
 * @returns {{ name: string, email: string }} empty strings for what the account cannot say
 */
export function accountAuthor(provider, user) {
	if (!user) return { name: '', email: '' };
	return {
		name: user.name ?? user.login,
		email: user.email ?? (provider === 'github' ? `${user.login}@users.noreply.github.com` : '')
	};
}

/**
 * @param {Settings} settings
 * @param {{ name: string, email: string }} fallback from the account
 * @returns {Author | null} null until both a name and an email are known
 */
export function resolveAuthor(settings, fallback) {
	const name = settings.authorName.trim() || fallback.name;
	const email = settings.authorEmail.trim() || fallback.email;
	return name && email ? { name, email } : null;
}
