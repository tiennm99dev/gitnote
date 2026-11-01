/**
 * The state behind the notes screen for one repository: the file list, the open
 * note, and its unsaved buffer. Three places can hold a note's text, and only
 * the user moves it between them:
 *
 * - the editor buffer, copied to a draft in IndexedDB on every change, so a
 *   reload loses nothing;
 * - the working tree, after Save;
 * - git, after a commit, which is not this store's business.
 *
 * A draft remembers the file it started from. If the file then changes
 * underneath it (a pull, another tab), the store says so and lets the user pick,
 * rather than overwriting either side.
 *
 * Tabs share one draft per path, and each keeps its own buffer. A tab removes a
 * draft only while it still holds the text that tab stored, and a tab coming back
 * into view stores its buffer again if the draft no longer matches. So the last
 * tab to write or come back holds the draft; closing a tab with a dirty buffer
 * that had lost the draft, without returning to it, loses that buffer.
 *
 * When storage refuses a draft, the text stays in this store's memory instead,
 * by path, so moving between notes loses nothing. Only leaving the repository or
 * the page can then lose it, and `unkeptPaths` tells the screen to ask first.
 */

import { writable } from 'svelte/store';
import { ErrorCode, GitEngineError } from '../git/errors.js';
import { checkFileSize } from '../git/limits.js';
import { normalizePath } from '../git/repo.js';
import { baseName, imagePathFor, imageTypeFor, isMarkdownPath, relativeUrlFrom } from '../notes/paths.js';
import { decodeText, MAX_TEXT_BYTES } from '../notes/text.js';

/** @typedef {import('./drafts.js').Draft} Draft */
/** @typedef {import('./drafts.js').DraftStore} DraftStore */
/** @typedef {import('../git/repo.js').TreeEntry} TreeEntry */

/**
 * - `markdown`, `text`: `text` holds the buffer.
 * - `image`: shown from the file; `text` is empty.
 * - `binary`, `large`: only `size` is known.
 * - `symlink`: a symbolic link, which is neither followed nor edited here.
 * - `missing`: no file there.
 * @typedef {'markdown' | 'text' | 'image' | 'binary' | 'large' | 'symlink' | 'missing'} NoteKind
 */

/**
 * @typedef {object} OpenNote
 * @property {string} path
 * @property {NoteKind} kind
 * @property {number} size bytes on disk
 * @property {number} version a new number each time the buffer is loaded from storage
 * @property {string} text the buffer
 * @property {string | null} savedText the file this buffer is compared with; null when there is none
 * @property {boolean} dirty the buffer differs from `savedText`
 * @property {boolean} restored the buffer came from a draft
 * @property {boolean} diskChanged the file no longer matches `savedText`, and the user has to choose
 * @property {boolean} draftStored the draft on the device matches the buffer
 * @property {boolean} draftFailed the last draft write failed
 */

/**
 * @typedef {object} NotesState
 * @property {TreeEntry[]} entries
 * @property {string[]} draftPaths paths with an unsaved draft
 * @property {string[]} unkeptPaths paths whose unsaved text storage refused, so only this store holds it
 * @property {boolean} treeLoaded
 * @property {string | null} treeError
 * @property {OpenNote | null} note
 */

/**
 * @typedef {object} SearchHit
 * @property {string} path
 * @property {number} line 1-based
 * @property {string} snippet
 */

/** Stops a scan's output from growing past what anyone would read. */
const MAX_SEARCH_HITS = 200;
const MAX_HITS_PER_FILE = 3;
const SNIPPET_LENGTH = 160;

/**
 * @param {string} text
 * @returns {string} comparable text: same accents however they were typed, ignoring case
 */
const fold = (text) => text.normalize('NFC').toLocaleLowerCase();

/**
 * @param {string} path
 * @param {string} folder
 * @returns {boolean} the path is the folder or inside it
 */
export const isWithin = (path, folder) => path === folder || path.startsWith(`${folder}/`);

/**
 * @param {string} path
 * @param {string} from
 * @param {string} to
 * @returns {string} where the path is once `from` moved to `to`
 */
export const movedPath = (path, from, to) => `${to}${path.slice(from.length)}`;

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isNotFound = (error) => error instanceof GitEngineError && error.code === ErrorCode.PATH_NOT_FOUND;

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} one path is the other, or lies inside it
 */
const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);

// The store's methods are inferred; `Notes` below names them.
// eslint-disable-next-line jsdoc/require-returns
/**
 * @param {object} options
 * @param {string} options.repoId
 * @param {import('../git/limits.js').ProviderId} options.provider
 * @param {Pick<import('../git/repo.js').Repo, 'listTree' | 'readFile' | 'writeFileIfUnchanged' | 'createFile' | 'rename' | 'remove'>} options.repo
 * @param {DraftStore} options.drafts
 */
export function createNotes({ repoId, provider, repo, drafts }) {
	/** @type {NotesState} */
	let state = { entries: [], draftPaths: [], unkeptPaths: [], treeLoaded: false, treeError: null, note: null };
	const store = writable(state);

	/** @param {Partial<NotesState>} change */
	const set = (change) => {
		state = { ...state, ...change };
		store.set(state);
	};

	/** @param {Partial<OpenNote>} change */
	const setNote = (change) => {
		if (state.note) set({ note: { ...state.note, ...change } });
	};

	let versions = 0;
	/** Tells the latest `open` from one overtaken while it waited on storage. */
	let openRequest = 0;

	/**
	 * What each path's draft should become: the draft, or null to remove it.
	 * @type {Map<string, Draft | null>}
	 */
	const pendingDrafts = new Map();
	/** @type {Promise<void> | null} */
	let writing = null;
	/**
	 * The text of the draft this tab last stored or loaded, per path. Anything else
	 * in that record came from another tab, and is not this tab's to remove.
	 * @type {Map<string, string>}
	 */
	const ownDrafts = new Map();
	/**
	 * Drafts storage refused, by path: newer than anything stored for that path.
	 * @type {Map<string, Draft>}
	 */
	const unkeptDrafts = new Map();
	const publishUnkept = () => set({ unkeptPaths: [...unkeptDrafts.keys()] });

	const writePendingDrafts = async () => {
		// Never finish before the caller has recorded this run: removing a draft this
		// tab never stored awaits nothing, and `writing` would then stay set for good.
		await null;
		for (const [path, draft] of pendingDrafts) {
			pendingDrafts.delete(path);
			try {
				if (draft) {
					await drafts.put(draft);
					ownDrafts.set(path, draft.text);
				} else {
					const own = ownDrafts.get(path);
					ownDrafts.delete(path);
					if (own !== undefined) await drafts.removeIfText(repoId, path, own);
				}
				if (state.note?.path === path && !pendingDrafts.has(path)) setNote({ draftStored: true, draftFailed: false });
			} catch {
				if (draft && !pendingDrafts.has(path)) {
					unkeptDrafts.set(path, draft);
					publishUnkept();
				}
				if (state.note?.path === path) setNote({ draftStored: false, draftFailed: true });
			}
		}
		writing = null;
	};

	/**
	 * Keeps only the latest text for each path, so a slow disk never queues up
	 * one write per keystroke.
	 * @param {string} path
	 * @param {Draft | null} draft
	 * @returns {void}
	 */
	const queueDraft = (path, draft) => {
		pendingDrafts.set(path, draft);
		if (unkeptDrafts.delete(path)) publishUnkept();
		const listed = state.draftPaths.includes(path);
		if (draft && !listed) set({ draftPaths: [...state.draftPaths, path] });
		else if (!draft && listed) set({ draftPaths: state.draftPaths.filter((item) => item !== path) });
		writing ??= writePendingDrafts();
	};

	/** @returns {Promise<void>} once every queued draft reached storage */
	const flushDrafts = async () => {
		while (writing) await writing;
	};

	/**
	 * Reads the file list, for callers that must not act on an old one: a failure
	 * rejects, and also sets `treeError`.
	 * @returns {Promise<void>}
	 */
	const readTree = async () => {
		try {
			const [entries, draftPaths] = await Promise.all([repo.listTree(), drafts.listPaths(repoId).catch(() => state.draftPaths)]);
			// A write queued meanwhile is newer than what storage answered.
			const queued = [...pendingDrafts];
			const merged = new Set(draftPaths);
			for (const [path, draft] of queued) {
				if (draft) merged.add(path);
				else merged.delete(path);
			}
			for (const path of unkeptDrafts.keys()) merged.add(path);
			set({ entries, draftPaths: [...merged], treeLoaded: true, treeError: null });
		} catch (error) {
			set({ treeLoaded: true, treeError: error instanceof Error ? error.message : 'The file list could not be read.' });
			throw error;
		}
	};

	/**
	 * Reads the file list for showing; a failure stays in `treeError`.
	 * @returns {Promise<void>}
	 */
	const loadTree = () => readTree().catch(() => undefined);

	/**
	 * Reads what is on disk for a path. After a failed listing the entries say
	 * nothing, so only the file itself can tell whether it is there.
	 * @param {string} path
	 * @returns {Promise<{ kind: NoteKind, size: number, text: string | null }>} `text` is null unless the kind holds text
	 */
	const readDisk = async (path) => {
		if (!state.treeError) {
			const entry = state.entries.find((item) => item.path === path);
			if (!entry) return { kind: 'missing', size: 0, text: null };
			if (entry.symlink) return { kind: 'symlink', size: entry.size, text: null };
			if (imageTypeFor(path)) return { kind: 'image', size: entry.size, text: null };
			if (entry.size > MAX_TEXT_BYTES) return { kind: 'large', size: entry.size, text: null };
		}
		/** @type {Uint8Array} */
		let bytes;
		try {
			bytes = await repo.readFile(path);
		} catch (error) {
			if (isNotFound(error)) return { kind: 'missing', size: 0, text: null };
			throw error;
		}
		if (imageTypeFor(path)) return { kind: 'image', size: bytes.byteLength, text: null };
		if (bytes.byteLength > MAX_TEXT_BYTES) return { kind: 'large', size: bytes.byteLength, text: null };
		const text = decodeText(bytes);
		if (text === null) return { kind: 'binary', size: bytes.byteLength, text: null };
		return { kind: isMarkdownPath(path) ? 'markdown' : 'text', size: bytes.byteLength, text };
	};

	/**
	 * The file's real text, for comparing with a buffer. The display limit does not
	 * apply: an open buffer may have grown past it.
	 * @param {string} path
	 * @returns {Promise<string | null>} the text on disk now; null without a text file there
	 */
	const readDiskText = async (path) => {
		try {
			return decodeText(await repo.readFile(path));
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	};

	/**
	 * Loads a path and any draft kept for it into the open note.
	 * @param {string} path
	 * @param {number} [unlessEditedVersion] leaves the note alone if this version of it became dirty during the load
	 * @returns {Promise<void>}
	 */
	const load = async (path, unlessEditedVersion) => {
		openRequest += 1;
		const request = openRequest;
		await flushDrafts();
		await loadTree();
		let draftFailed = false;
		const [disk, stored] = await Promise.all([
			readDisk(path),
			drafts.get(repoId, path).catch(() => {
				draftFailed = true;
				return null;
			})
		]);
		const kept = unkeptDrafts.get(path);
		const draft = kept ?? stored;
		const diskText = draft && disk.kind === 'large' ? await readDiskText(path) : disk.text;
		if (request !== openRequest) return;
		if (state.note?.version === unlessEditedVersion && state.note?.dirty) return;
		if (stored) ownDrafts.set(path, stored.text);
		else ownDrafts.delete(path);
		versions += 1;
		/** @type {OpenNote} */
		const base = {
			path,
			kind: disk.kind,
			size: disk.size,
			version: versions,
			text: disk.text ?? '',
			savedText: disk.text,
			dirty: false,
			restored: false,
			diskChanged: false,
			draftStored: true,
			draftFailed
		};
		if (!draft) {
			set({ note: base });
		} else if (draft.text === diskText) {
			// Saved in another tab, or a tab that died right before removing it.
			queueDraft(path, null);
			set({ note: base });
		} else {
			set({
				note: {
					...base,
					kind: isMarkdownPath(path) ? 'markdown' : 'text',
					text: draft.text,
					savedText: draft.base,
					dirty: true,
					restored: true,
					diskChanged: diskText !== draft.base,
					draftStored: !kept,
					draftFailed: draftFailed || Boolean(kept)
				}
			});
			// Storage may have room again; a refusal puts it straight back.
			if (kept) queueDraft(path, kept);
		}
	};

	/**
	 * Creates a file, never over one that exists. Nothing is committed.
	 * @param {string} path
	 * @param {string} [text]
	 * @returns {Promise<string>} the validated path
	 */
	const create = async (path, text = '') => {
		const target = normalizePath(path);
		await readTree();
		for (const { path: existing } of state.entries) {
			if (isWithin(existing, target)) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${target} already exists.`);
			if (isWithin(target, existing)) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${existing} is a file, not a folder.`);
		}
		// A draft whose file is gone counts as that file, but may get its file back.
		const blocking = state.draftPaths.find((draft) => draft !== target && overlaps(draft, target));
		if (blocking) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${blocking} has unsaved text. Save or discard it first.`);
		await repo.createFile(target, text);
		await loadTree();
		return target;
	};

	return {
		subscribe: store.subscribe,

		/**
		 * Opens a path, or closes the open note with an empty one.
		 * @param {string} path
		 * @returns {Promise<void>}
		 */
		async open(path) {
			if (path === '') {
				openRequest += 1;
				set({ note: null });
				await loadTree();
				return;
			}
			try {
				normalizePath(path);
			} catch (error) {
				openRequest += 1;
				set({ note: null });
				throw error;
			}
			if (state.note?.path !== path) set({ note: null });
			await load(path);
		},

		/**
		 * Rereads storage after another tab may have written. A clean note follows
		 * the file; a dirty one is only told about it, and stores its buffer again
		 * if the draft no longer holds it.
		 * @returns {Promise<void>}
		 */
		async refresh() {
			await loadTree();
			const note = state.note;
			if (!note) return;
			if (note.kind !== 'markdown' && note.kind !== 'text') {
				const disk = await readDisk(note.path);
				if (state.note?.path === note.path && (disk.kind !== note.kind || disk.size !== note.size)) await load(note.path);
				return;
			}
			if (note.dirty) {
				await flushDrafts();
				const stored = await drafts.get(repoId, note.path).catch(() => undefined);
				const current = state.note;
				if (stored !== undefined && current?.version === note.version && current.dirty && stored?.text !== current.text && !pendingDrafts.has(note.path)) {
					setNote({ draftStored: false });
					queueDraft(note.path, { repoId, path: note.path, text: current.text, base: current.savedText });
				}
			}
			const onDisk = await readDiskText(note.path);
			if (state.note?.version !== note.version || onDisk === state.note.savedText) return;
			if (!state.note.dirty) await load(note.path, note.version);
			// Dirty from the start, or from typing during that load, which then left it alone.
			if (state.note?.version === note.version && state.note.dirty) setNote({ diskChanged: onDisk !== state.note.text });
		},

		/**
		 * Takes the editor's new text.
		 * @param {string} text
		 * @returns {void}
		 */
		edit(text) {
			const note = state.note;
			if (!note || (note.kind !== 'markdown' && note.kind !== 'text') || text === note.text) return;
			const dirty = text !== note.savedText;
			setNote({ text, dirty, draftStored: !dirty, restored: note.restored && dirty });
			queueDraft(note.path, dirty ? { repoId, path: note.path, text, base: note.savedText } : null);
		},

		/**
		 * Writes the buffer to the working tree. Nothing is staged or committed.
		 * @returns {Promise<boolean>} false when the file changed underneath, which
		 *   leaves `diskChanged` set for the user to decide
		 */
		async save() {
			const note = state.note;
			if (!note || (note.kind !== 'markdown' && note.kind !== 'text')) return false;
			const { path, text, version } = note;
			if (!(await repo.writeFileIfUnchanged(path, text, note.savedText))) {
				setNote({ diskChanged: true });
				return false;
			}
			await loadTree();
			if (state.note?.version !== version) return true;
			const stillSame = state.note.text === text;
			setNote({ savedText: text, dirty: !stillSame, diskChanged: false, restored: false, size: new TextEncoder().encode(text).byteLength, draftStored: stillSame });
			queueDraft(path, stillSame ? null : { repoId, path, text: state.note.text, base: text });
			return true;
		},

		/**
		 * Keeps the buffer over a file that changed underneath it. The next save
		 * overwrites that file; until then both remain.
		 * @returns {Promise<void>}
		 */
		async keepMine() {
			const note = state.note;
			if (!note) return;
			const onDisk = await readDiskText(note.path);
			if (state.note?.version !== note.version) return;
			setNote({ savedText: onDisk, diskChanged: false, dirty: state.note.text !== onDisk });
			queueDraft(note.path, state.note.text === onDisk ? null : { repoId, path: note.path, text: state.note.text, base: onDisk });
		},

		/**
		 * Drops the buffer and loads the file again.
		 * @returns {Promise<void>}
		 */
		async discard() {
			const note = state.note;
			if (!note) return;
			queueDraft(note.path, null);
			await load(note.path);
		},

		/**
		 * Saves every note's unsaved text, as Save would. A draft whose file changed
		 * underneath it stays a draft, because only the user can choose between the two.
		 * @returns {Promise<{ saved: string[], skipped: string[] }>} `skipped` holds the paths left as drafts
		 */
		async saveDrafts() {
			await flushDrafts();
			/** @type {string[]} */
			const saved = [];
			/** @type {string[]} */
			const skipped = [];
			const paths = new Set([...(await drafts.listPaths(repoId)), ...unkeptDrafts.keys()]);
			for (const path of paths) {
				const open = state.note?.path === path ? state.note : null;
				const draft = open ? { text: open.text, base: open.savedText } : (unkeptDrafts.get(path) ?? (await drafts.get(repoId, path)));
				if (!draft) continue;
				if (!(await repo.writeFileIfUnchanged(path, draft.text, draft.base))) {
					if (open) setNote({ diskChanged: true });
					skipped.push(path);
					continue;
				}
				saved.push(path);
				if (open && state.note?.version === open.version) {
					const stillSame = state.note.text === draft.text;
					setNote({ savedText: draft.text, dirty: !stillSame, diskChanged: false, restored: false, size: new TextEncoder().encode(draft.text).byteLength, draftStored: stillSame });
					queueDraft(path, stillSame ? null : { repoId, path, text: state.note.text, base: draft.text });
				} else {
					ownDrafts.set(path, draft.text);
					queueDraft(path, null);
				}
			}
			await flushDrafts();
			await loadTree();
			return { saved, skipped };
		},

		create,

		/**
		 * Git keeps no empty folder, so a new one starts with a `.gitkeep` file.
		 * @param {string} path
		 * @returns {Promise<string>} the validated path
		 */
		async createFolder(path) {
			const target = normalizePath(path);
			await readTree();
			if ([...state.entries.map((entry) => entry.path), ...state.draftPaths].some((existing) => isWithin(existing, target))) {
				throw new GitEngineError(ErrorCode.PATH_EXISTS, `${target} already exists.`);
			}
			await create(`${target}/.gitkeep`);
			return target;
		},

		/**
		 * Renames or moves a file or folder, and any drafts along with it. A draft
		 * counts as a file here: nothing moves onto one, and one whose file is gone
		 * moves under the same rules as a file.
		 * @param {string} from
		 * @param {string} to
		 * @returns {Promise<string>} the validated new path
		 */
		async move(from, to) {
			const source = normalizePath(from);
			const target = normalizePath(to);
			if (source === target) return target;
			await flushDrafts();
			await readTree();
			const carried = state.draftPaths.filter((path) => isWithin(path, source));
			if (target.startsWith(`${source}/`)) {
				throw new GitEngineError(ErrorCode.INVALID_PATH, 'A folder cannot move inside itself.');
			}
			if (state.draftPaths.some((path) => !isWithin(path, source) && overlaps(path, target))) {
				throw new GitEngineError(ErrorCode.PATH_EXISTS, `${target} has unsaved text. Save or discard it first.`);
			}
			const hasFile = state.entries.some((entry) => isWithin(entry.path, source));
			if (!hasFile && carried.length > 0 && state.entries.some((entry) => overlaps(entry.path, target))) {
				throw new GitEngineError(ErrorCode.PATH_EXISTS, `${target} already exists.`);
			}
			try {
				await repo.rename(source, target);
			} catch (error) {
				// A draft can outlive its file; it moves on its own then.
				if (!(isNotFound(error) && carried.length > 0)) throw error;
			}
			for (const path of carried) {
				const next = movedPath(path, source, target);
				const kept = unkeptDrafts.get(path);
				if (kept) {
					unkeptDrafts.delete(path);
					unkeptDrafts.set(next, { ...kept, path: next });
					publishUnkept();
				} else {
					const draft = await drafts.get(repoId, path);
					if (draft) await drafts.put({ ...draft, path: next });
				}
				await drafts.remove(repoId, path);
				ownDrafts.delete(path);
			}
			await loadTree();
			return target;
		},

		/**
		 * Deletes a file or folder from the working tree, with any drafts in it.
		 * @param {string} path
		 * @returns {Promise<void>}
		 */
		async remove(path) {
			const target = normalizePath(path);
			await flushDrafts();
			await readTree();
			const carried = state.draftPaths.filter((item) => isWithin(item, target));
			try {
				await repo.remove(target);
			} catch (error) {
				if (!(isNotFound(error) && carried.length > 0)) throw error;
			}
			for (const item of carried) {
				if (unkeptDrafts.delete(item)) publishUnkept();
				await drafts.remove(repoId, item);
				ownDrafts.delete(item);
			}
			if (state.note && isWithin(state.note.path, target)) {
				openRequest += 1;
				set({ note: null });
			}
			await loadTree();
		},

		/**
		 * Stores an image in `assets/` next to a note, after the per-file size check.
		 * @param {string} notePath
		 * @param {File} file
		 * @returns {Promise<{ path: string, markdown: string, warning: string | null }>}
		 *   `markdown` is the link to insert; `warning` is a size warning to show
		 */
		async addImage(notePath, file) {
			await readTree();
			const path = imagePathFor({ notePath, fileName: file.name, mimeType: file.type, taken: new Set(state.entries.map((entry) => entry.path)) });
			if (!path) {
				throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'Only PNG, JPEG, GIF, WebP and SVG images can be added.');
			}
			const finding = checkFileSize(provider, path, file.size);
			if (finding?.level === 'block') {
				throw new GitEngineError(ErrorCode.FILE_TOO_LARGE, finding.message, { detail: { findings: [finding] } });
			}
			await repo.createFile(path, new Uint8Array(await file.arrayBuffer()));
			await loadTree();
			const alt = baseName(path).replace(/\.[^.]*$/, '');
			return { path, markdown: `![${alt}](${relativeUrlFrom(notePath, path)})`, warning: finding?.message ?? null };
		},

		/**
		 * Scans the working tree's markdown files for text, ignoring case.
		 * @param {string} query
		 * @param {AbortSignal} [signal] a newer search makes this one stop
		 * @returns {Promise<{ hits: SearchHit[], truncated: boolean }>}
		 */
		async search(query, signal) {
			const wanted = fold(query.trim());
			if (wanted === '') return { hits: [], truncated: false };
			await readTree();
			/** @type {SearchHit[]} */
			const hits = [];
			for (const { path, size, symlink } of state.entries) {
				if (signal?.aborted) break;
				if (symlink || !isMarkdownPath(path) || size > MAX_TEXT_BYTES) continue;
				/** @type {string | null} */
				let text;
				try {
					text = decodeText(await repo.readFile(path));
				} catch (error) {
					// Git allows names the engine refuses; one must not end the whole scan.
					if (isNotFound(error) || (error instanceof GitEngineError && error.code === ErrorCode.INVALID_PATH)) continue;
					throw error;
				}
				if (text === null) continue;
				let found = 0;
				for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
					if (!fold(line).includes(wanted)) continue;
					found += 1;
					if (hits.length === MAX_SEARCH_HITS) return { hits, truncated: true };
					hits.push({ path, line: index + 1, snippet: snippetOf(line, wanted) });
					if (found === MAX_HITS_PER_FILE) break;
				}
			}
			return { hits, truncated: false };
		},

		flushDrafts
	};
}

/**
 * @param {string} line
 * @param {string} wanted folded query
 * @returns {string} the line, cut to the part around the match
 */
function snippetOf(line, wanted) {
	const trimmed = line.trim();
	if (trimmed.length <= SNIPPET_LENGTH) return trimmed;
	const at = fold(trimmed).indexOf(wanted);
	const start = Math.max(0, Math.min(at - 40, trimmed.length - SNIPPET_LENGTH));
	return `${start > 0 ? '…' : ''}${trimmed.slice(start, start + SNIPPET_LENGTH)}${start + SNIPPET_LENGTH < trimmed.length ? '…' : ''}`;
}

/** @typedef {ReturnType<typeof createNotes>} Notes */
