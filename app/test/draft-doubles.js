/**
 * Copies drafts in and out, as IndexedDB would. The real store is covered by the
 * Playwright tests.
 * @returns {import('../src/lib/stores/drafts.js').DraftStore & { records: Map<string, string>, failing: { put: boolean } }}
 */
export function memoryDraftStore() {
	/** @type {Map<string, string>} */
	const records = new Map();
	const failing = { put: false };
	/**
	 * @param {string} repoId
	 * @param {string} path
	 * @returns {string}
	 */
	const key = (repoId, path) => JSON.stringify([repoId, path]);
	return {
		records,
		failing,
		get: async (repoId, path) => {
			const record = records.get(key(repoId, path));
			return record === undefined ? null : JSON.parse(record);
		},
		put: async (draft) => {
			if (failing.put) throw new Error('quota exceeded');
			records.set(key(draft.repoId, draft.path), JSON.stringify(draft));
		},
		remove: async (repoId, path) => void records.delete(key(repoId, path)),
		listPaths: async (repoId) =>
			[...records.values()]
				.map((record) => JSON.parse(record))
				.filter((draft) => draft.repoId === repoId)
				.map((draft) => draft.path),
		clear: async (repoId) => {
			for (const [name, record] of records) if (JSON.parse(record).repoId === repoId) records.delete(name);
		}
	};
}
