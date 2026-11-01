import { StorageError, StorageErrorType } from '@aparajita/capacitor-secure-storage';
import { describe, expect, it } from 'vitest';
import { AuthErrorCode } from './errors.js';
import { createNativeTokenStore, generateKey, seal, unseal } from './token-store.js';

const VALUE = { accessToken: 'ghu_plaintext_secret', refreshToken: 'ghr_plaintext_secret' };

describe('sealed records', () => {
	it('come back as stored', async () => {
		const key = await generateKey();
		expect(await unseal(key, 'github', await seal(key, 'github', VALUE))).toEqual(VALUE);
	});

	it('hold no plaintext', async () => {
		const { data } = await seal(await generateKey(), 'github', VALUE);
		expect(Buffer.from(data).toString('latin1')).not.toContain('plaintext_secret');
	});

	it('use a new IV for every write', async () => {
		const key = await generateKey();
		const [first, second] = [await seal(key, 'github', VALUE), await seal(key, 'github', VALUE)];
		expect(first.iv).not.toEqual(second.iv);
		expect(Buffer.from(first.data).equals(Buffer.from(second.data))).toBe(false);
	});

	it('use a key that cannot be exported', async () => {
		const key = await generateKey();
		expect(key.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
	});

	it('read as null under another key, another name, or after tampering', async () => {
		const key = await generateKey();
		const record = await seal(key, 'github', VALUE);
		expect(await unseal(await generateKey(), 'github', record)).toBeNull();
		expect(await unseal(key, 'gitlab', record)).toBeNull();
		const bytes = new Uint8Array(record.data.slice(0));
		bytes[0] ^= 1;
		expect(await unseal(key, 'github', { iv: record.iv, data: bytes.buffer })).toBeNull();
	});
});

describe('the Android store', () => {
	// The double's parts are inferred.
	// eslint-disable-next-line jsdoc/require-returns
	/**
	 * Secure storage as the plugin presents it: JSON in, JSON out.
	 * @param {unknown} [failure] thrown by every call
	 */
	function secureStorage(failure) {
		/** @type {Map<string, string>} */
		const items = new Map();
		const check = () => {
			if (failure) throw failure;
		};
		const storage = {
			get: async (/** @type {string} */ key) => {
				check();
				const item = items.get(key);
				return item === undefined ? null : JSON.parse(item);
			},
			set: async (/** @type {string} */ key, /** @type {unknown} */ data) => {
				check();
				items.set(key, JSON.stringify(data));
			},
			remove: async (/** @type {string} */ key) => {
				check();
				return items.delete(key);
			}
		};
		return { items, store: createNativeTokenStore(/** @type {import('@aparajita/capacitor-secure-storage').SecureStoragePlugin} */ (/** @type {unknown} */ (storage))) };
	}

	it('keeps a record until it is removed', async () => {
		const { store } = secureStorage();
		expect(await store.get('github')).toBeNull();
		await store.set('github', VALUE);
		expect(await store.get('github')).toEqual(VALUE);
		await store.remove('github');
		expect(await store.get('github')).toBeNull();
	});

	it('replaces a rotated pair whole', async () => {
		const { store, items } = secureStorage();
		await store.set('github', VALUE);
		await store.set('github', { accessToken: 'next' });
		expect(items.size).toBe(1);
		expect(await store.get('github')).toEqual({ accessToken: 'next' });
	});

	it('reads a record that is not an object as absent', async () => {
		const { store, items } = secureStorage();
		items.set('github', '"text"');
		expect(await store.get('github')).toBeNull();
	});

	it.each([StorageErrorType.osError, StorageErrorType.invalidData])('reads a record the Keystore refuses as absent (%s)', async (code) => {
		const { store } = secureStorage(new StorageError('refused', code));
		expect(await store.get('github')).toBeNull();
	});

	it('reports any other failure as a storage error', async () => {
		const { store } = secureStorage(new Error('no bridge'));
		await expect(store.get('github')).rejects.toMatchObject({ code: AuthErrorCode.STORAGE });
		await expect(store.set('github', VALUE)).rejects.toMatchObject({ code: AuthErrorCode.STORAGE });
		await expect(store.remove('github')).rejects.toMatchObject({ code: AuthErrorCode.STORAGE });
	});

	it('reports a failed write even when the Keystore is the cause', async () => {
		const { store } = secureStorage(new StorageError('refused', StorageErrorType.osError));
		await expect(store.set('github', VALUE)).rejects.toMatchObject({ code: AuthErrorCode.STORAGE });
	});
});
