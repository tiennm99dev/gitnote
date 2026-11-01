/**
 * Unsaved editor buffers, in IndexedDB. A draft holds what the user typed and
 * the file content it was typed against, so a later open can tell when the file
 * changed underneath it. Nothing here touches the working tree or git.
 */

const DB_NAME = 'gitnote-drafts';
const STORE = 'drafts';

/**
 * @typedef {object} Draft
 * @property {string} repoId
 * @property {string} path
 * @property {string} text what the editor held
 * @property {string | null} base the file the edit started from; null when there was none
 */

/**
 * The store's interface: the web store below, or a double in tests.
 * @typedef {object} DraftStore
 * @property {(repoId: string, path: string) => Promise<Draft | null>} get
 * @property {(draft: Draft) => Promise<void>} put
 * @property {(repoId: string, path: string) => Promise<void>} remove
 * @property {(repoId: string, path: string, text: string) => Promise<void>} removeIfText removes the draft only if it still holds this text
 * @property {(repoId: string) => Promise<string[]>} listPaths
 * @property {(repoId: string) => Promise<void>} clear
 */

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE, { keyPath: ['repoId', 'path'] });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('The drafts database is blocked by another tab.'));
	});
}

/**
 * Runs one request and waits for its transaction to commit, so a resolved write
 * survives the tab closing right after.
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} operation
 * @returns {Promise<T>}
 */
async function run(mode, operation) {
	const db = await openDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE, mode);
			const request = operation(transaction.objectStore(STORE));
			transaction.oncomplete = () => resolve(request.result);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	} finally {
		db.close();
	}
}

/**
 * Array keys sort after strings, so this covers every path of one repository.
 * @param {string} repoId
 * @returns {IDBKeyRange}
 */
const repoRange = (repoId) => IDBKeyRange.bound([repoId], [repoId, []]);

/**
 * @returns {DraftStore} the store for the web build
 */
export function createWebDraftStore() {
	return {
		get: async (repoId, path) => (await run('readonly', (store) => store.get([repoId, path]))) ?? null,
		put: async (draft) => {
			await run('readwrite', (store) => store.put(draft));
		},
		remove: async (repoId, path) => {
			await run('readwrite', (store) => store.delete([repoId, path]));
		},
		removeIfText: async (repoId, path, text) => {
			await run('readwrite', (store) => {
				const read = store.get([repoId, path]);
				read.onsuccess = () => {
					if (read.result?.text === text) store.delete([repoId, path]);
				};
				return read;
			});
		},
		listPaths: async (repoId) => {
			const keys = await run('readonly', (store) => store.getAllKeys(repoRange(repoId)));
			return keys.map((key) => String(/** @type {IDBValidKey[]} */ (key)[1]));
		},
		clear: async (repoId) => {
			await run('readwrite', (store) => store.delete(repoRange(repoId)));
		}
	};
}
