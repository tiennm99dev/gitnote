import { describe, expect, it } from 'vitest';
import { accountAuthor, isSettingsChange, loadSettings, resolveAuthor, saveSettings } from './settings.js';

/**
 * @param {Record<string, string>} [entries]
 * @returns {Storage}
 */
function memoryStorage(entries = {}) {
	const items = new Map(Object.entries(entries));
	return /** @type {Storage} */ (
		/** @type {unknown} */ ({
			getItem: (/** @type {string} */ key) => items.get(key) ?? null,
			setItem: (/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, value)
		})
	);
}

describe('loadSettings', () => {
	it('starts with autosave off at five minutes', () => {
		expect(loadSettings(memoryStorage())).toEqual({ authorName: '', authorEmail: '', autosave: false, intervalMinutes: 5 });
	});

	it('reads back what was saved', () => {
		const storage = memoryStorage();
		const settings = { authorName: 'Me', authorEmail: 'me@example.com', autosave: true, intervalMinutes: 30 };
		saveSettings(settings, storage);
		expect(loadSettings(storage)).toEqual(settings);
	});

	it('takes defaults for anything unreadable or out of range', () => {
		expect(loadSettings(memoryStorage({ 'gitnote.settings': 'not json' })).intervalMinutes).toBe(5);
		const odd = JSON.stringify({ authorName: 3, autosave: 'yes', intervalMinutes: 7 });
		expect(loadSettings(memoryStorage({ 'gitnote.settings': odd }))).toEqual({ authorName: '', authorEmail: '', autosave: false, intervalMinutes: 5 });
	});
});

describe('the commit author', () => {
	const user = { login: 'octo', name: 'Octo', email: null };

	it("falls back to GitHub's no-reply address when the profile hides the email", () => {
		expect(accountAuthor('github', user)).toEqual({ name: 'Octo', email: 'octo@users.noreply.github.com' });
	});

	it('uses the login without a name, and has no address to invent on GitLab', () => {
		expect(accountAuthor('gitlab', { ...user, name: null })).toEqual({ name: 'octo', email: '' });
		expect(accountAuthor('gitlab', { ...user, email: 'o@example.com' })).toEqual({ name: 'Octo', email: 'o@example.com' });
	});

	it('knows nothing without an account', () => {
		expect(accountAuthor('github', null)).toEqual({ name: '', email: '' });
	});

	it('prefers the settings field by field, and needs both parts', () => {
		const settings = { authorName: 'Me', authorEmail: '', autosave: false, intervalMinutes: 5 };
		expect(resolveAuthor(settings, { name: 'Octo', email: 'o@example.com' })).toEqual({ name: 'Me', email: 'o@example.com' });
		expect(resolveAuthor(settings, { name: 'Octo', email: '' })).toBeNull();
	});
});

describe('isSettingsChange', () => {
	it('notices its own key and a cleared storage', () => {
		expect(isSettingsChange(/** @type {StorageEvent} */ ({ key: 'gitnote.settings' }))).toBe(true);
		expect(isSettingsChange(/** @type {StorageEvent} */ ({ key: null }))).toBe(true);
		expect(isSettingsChange(/** @type {StorageEvent} */ ({ key: 'other' }))).toBe(false);
	});
});
