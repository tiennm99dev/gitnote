/**
 * Keeps sign-ins on this device only. The web store holds each one in IndexedDB,
 * encrypted with an AES-GCM key the browser will not export: code in the page
 * can use the key but cannot copy it out, and a copy of the database on disk is
 * useless without it. This is no defence against a script running in the page
 * while the user is signed in; the CSP and sanitized rendering cover that.
 */

import { AuthError, AuthErrorCode } from './errors.js';

/**
 * The store's interface. Writing one record is atomic, so a rotated access and
 * refresh token pair is replaced whole or not at all.
 * @template T
 * @typedef {object} TokenStore
 * @property {(name: string) => Promise<T | null>} get null when absent or unreadable
 * @property {(name: string, value: T) => Promise<void>} set
 * @property {(name: string) => Promise<void>} remove
 */

/**
 * @typedef {object} SealedRecord
 * @property {Uint8Array<ArrayBuffer>} iv
 * @property {ArrayBuffer} data
 */

const DB_NAME = 'gitnote-auth';
const KEY_STORE = 'keys';
const RECORD_STORE = 'tokens';
const KEY_ID = 'token-key';
const ALGORITHM = 'AES-GCM';

/**
 * @returns {Promise<CryptoKey>} a new key the browser refuses to export
 */
export function generateKey() {
	return crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypts a value. The record's name is authenticated with it, so one record's
 * data cannot be passed off as another's.
 * @param {CryptoKey} key
 * @param {string} name
 * @param {unknown} value
 * @returns {Promise<SealedRecord>}
 */
export async function seal(key, name, value) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt({ name: ALGORITHM, iv, additionalData: new TextEncoder().encode(name) }, key, new TextEncoder().encode(JSON.stringify(value)));
	return { iv, data };
}

/**
 * @param {CryptoKey} key
 * @param {string} name
 * @param {SealedRecord} record
 * @returns {Promise<unknown>} the value, or null when it does not decrypt
 */
export async function unseal(key, name, record) {
	try {
		const plain = await crypto.subtle.decrypt({ name: ALGORITHM, iv: record.iv, additionalData: new TextEncoder().encode(name) }, key, record.data);
		return JSON.parse(new TextDecoder().decode(plain));
	} catch {
		return null;
	}
}

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(KEY_STORE);
			request.result.createObjectStore(RECORD_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('The token database is blocked by another tab.'));
	});
}

/**
 * Runs one request in its own transaction and waits for the commit.
 * @template T
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} operation
 * @returns {Promise<T>}
 */
function run(db, storeName, mode, operation) {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(storeName, mode);
		const request = operation(transaction.objectStore(storeName));
		transaction.oncomplete = () => resolve(request.result);
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

/**
 * Returns the stored key, creating it if needed. Generating a key is async and
 * would end an IndexedDB transaction, so it happens first, and `add` makes the
 * first tab to store one the winner.
 * @param {IDBDatabase} db
 * @returns {Promise<CryptoKey>}
 */
async function loadKey(db) {
	const existing = await run(db, KEY_STORE, 'readonly', (store) => store.get(KEY_ID));
	if (existing) return existing;
	const fresh = await generateKey();
	try {
		await run(db, KEY_STORE, 'readwrite', (store) => store.add(fresh, KEY_ID));
		return fresh;
	} catch (error) {
		const winner = await run(db, KEY_STORE, 'readonly', (store) => store.get(KEY_ID));
		if (winner) return winner;
		throw error;
	}
}

/**
 * @template T
 * @param {(db: IDBDatabase) => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withDatabase(operation) {
	/** @type {IDBDatabase | undefined} */
	let db;
	try {
		db = await openDatabase();
		return await operation(db);
	} catch (cause) {
		throw new AuthError(AuthErrorCode.STORAGE, 'This browser could not use its storage for sign-ins. A private window may block it.', { cause });
	} finally {
		db?.close();
	}
}

/**
 * @template T
 * @returns {TokenStore<T>} the store for the web build
 */
export function createWebTokenStore() {
	return {
		get: (name) =>
			withDatabase(async (db) => {
				const record = await run(db, RECORD_STORE, 'readonly', (store) => store.get(name));
				if (!record) return null;
				return /** @type {Promise<T | null>} */ (unseal(await loadKey(db), name, record));
			}),
		set: (name, value) =>
			withDatabase(async (db) => {
				const record = await seal(await loadKey(db), name, value);
				await run(db, RECORD_STORE, 'readwrite', (store) => store.put(record, name));
			}),
		remove: (name) =>
			withDatabase(async (db) => {
				await run(db, RECORD_STORE, 'readwrite', (store) => store.delete(name));
			})
	};
}
