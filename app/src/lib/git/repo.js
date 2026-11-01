/**
 * The git engine: clone, read, write, commit, pull and push one repository on
 * the device, with no UI. The file system is a parameter: LightningFS in the
 * browser (see fs.js), any Node-style `fs` with `promises` elsewhere.
 *
 * Every public operation holds the repository's lock (lock.js), and every
 * operation that changes stored data flushes the file system before it
 * resolves, so a resolved commit survives the tab closing right after.
 */

import { Buffer } from 'buffer';
import git from 'isomorphic-git';
import { ErrorCode, GitEngineError, toGitEngineError } from './errors.js';
import { authCallbacks, withSignal } from './http.js';
import { checkFileSize, checkPushSize } from './limits.js';
import { withRepoLock } from './lock.js';
import { createMergeDriver, readMergeState, writeMergeState } from './merge.js';

// isomorphic-git uses the Node `Buffer` global; browsers have none.
globalThis.Buffer ??= Buffer;

/**
 * A promise-style file system; beyond what isomorphic-git needs, the engine
 * renames files.
 * @typedef {import('isomorphic-git').PromiseFsClient & { promises: { rename: (from: string, to: string) => Promise<unknown> } }} FsClient
 */
/** @typedef {import('isomorphic-git').HttpClient} HttpClient */
/** @typedef {import('isomorphic-git').ProgressCallback} ProgressCallback */
/** @typedef {import('./http.js').CredentialSource} CredentialSource */
/** @typedef {import('./limits.js').ProviderId} ProviderId */
/** @typedef {import('./limits.js').SizeFinding} SizeFinding */
/** @typedef {import('./merge.js').MergeState} MergeState */
/** @typedef {import('./lock.js').LockManagerLike} LockManagerLike */

/**
 * @typedef {object} Author
 * @property {string} name
 * @property {string} email
 */

/**
 * @typedef {object} FileChange
 * @property {string} path
 * @property {'added' | 'modified' | 'deleted'} change compared with HEAD
 */

/**
 * @typedef {object} RepoStatus
 * @property {FileChange[]} files changed files, sorted by path
 * @property {boolean} clean no changed files and no open merge
 * @property {MergeState | null} merge the open merge, if any
 */

/**
 * @typedef {object} TreeEntry
 * @property {string} path
 * @property {number} size bytes
 */

/**
 * A conflict is a normal result: see `pull`.
 * @typedef {{ status: 'up_to_date' | 'fast_forward' | 'merged', oid: string } | { status: 'conflict', oid: string, merge: MergeState }} PullResult
 */

/**
 * @typedef {object} RepoOptions
 * @property {string} id stable repository id, also the lock name (see `repoIdForUrl`)
 * @property {FsClient} fs the repository's own file system
 * @property {HttpClient} http usually `createGitHttp()`
 * @property {ProviderId} provider whose size limits apply
 * @property {CredentialSource} [getCredential] supplies the token for git requests
 * @property {string} [dir] working tree path inside `fs`
 * @property {{ persist?: () => Promise<boolean | null> }} [storage] asked to make storage persistent after the first clone
 * @property {LockManagerLike | null} [locks] defaults to `navigator.locks`
 */

const REMOTE = 'origin';

/** Where `writeFile` prepares new content, out of the working tree. */
const WRITE_TEMP_FILE = 'gitnote-write.tmp';

/** Path segments that would reach git's own data or leave the working tree. */
const FORBIDDEN_SEGMENTS = new Set(['', '.', '..', '.git']);

// The operations' types are inferred; `Repo` below names them.
// eslint-disable-next-line jsdoc/require-returns
/**
 * @param {RepoOptions} options
 */
export function createRepo({ id, fs, http, provider, getCredential, dir = '/repo', storage, locks }) {
	const gitdir = `${dir}/.git`;
	/** isomorphic-git's parsed-object cache, shared by this repo's operations. */
	const cache = {};
	const base = { fs, dir, gitdir, cache };

	/**
	 * @template T
	 * @param {() => Promise<T>} operation
	 * @returns {Promise<T>}
	 */
	const locked = (operation) =>
		withRepoLock(
			id,
			async () => {
				try {
					return await operation();
				} catch (error) {
					throw toGitEngineError(error);
				}
			},
			locks === undefined ? undefined : { locks }
		);

	/** @returns {Promise<void>} */
	const flush = async () => {
		const promises = /** @type {{ flush?: () => Promise<void> }} */ (fs.promises);
		if (typeof promises.flush === 'function') await promises.flush();
	};

	/**
	 * @param {string} path
	 * @returns {string} the absolute path inside `fs`
	 */
	const abs = (path) => `${dir}/${path}`;

	/**
	 * @param {string} path
	 * @returns {Promise<import('node:fs').Stats | null>}
	 */
	const lstatOrNull = async (path) => {
		try {
			return await fs.promises.lstat(path);
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	};

	/** @returns {Promise<boolean>} */
	const isCloned = async () => (await lstatOrNull(gitdir)) !== null;

	/** @returns {Promise<void>} */
	const assertCloned = async () => {
		if (!(await isCloned())) {
			throw new GitEngineError(ErrorCode.NOT_CLONED, 'This repository has not been cloned on this device yet.');
		}
	};

	/** @returns {Promise<string>} */
	const currentBranch = async () => {
		const branch = await git.currentBranch({ fs, dir, gitdir });
		if (!branch) throw new GitEngineError(ErrorCode.NOT_CLONED, 'The repository has no checked-out branch.');
		return branch;
	};

	/**
	 * @param {string} ref
	 * @returns {Promise<string | null>}
	 */
	const resolveOrNull = async (ref) => {
		try {
			return await git.resolveRef({ fs, gitdir, ref });
		} catch (error) {
			if (/** @type {{ code?: string }} */ (error)?.code === 'NotFoundError') return null;
			throw error;
		}
	};

	/** @returns {Promise<void>} */
	const assertNoMerge = async () => {
		const merge = await readMergeState(fs, gitdir);
		if (merge) {
			throw new GitEngineError(
				ErrorCode.MERGE_IN_PROGRESS,
				`A merge is open with conflicts in ${merge.conflictedPaths.join(', ')}. Resolve it first.`,
				{ detail: { merge } }
			);
		}
	};

	/**
	 * @param {string} oid
	 * @returns {Promise<{ tree: string, parents: string[] } | null>} null past a shallow boundary
	 */
	const readCommitOrNull = async (oid) => {
		try {
			const { commit } = await git.readCommit({ fs, gitdir, oid, cache });
			return { tree: commit.tree, parents: commit.parent };
		} catch (error) {
			if (/** @type {{ code?: string }} */ (error)?.code === 'NotFoundError') return null;
			throw error;
		}
	};

	/**
	 * Commits reachable from `start` without passing through `stops`, newest
	 * first. Stops at the shallow boundary, where parents are not on disk.
	 * @param {string} start
	 * @param {Set<string>} stops
	 * @returns {Promise<Array<{ oid: string, tree: string, parents: string[] }>>}
	 */
	const commitsUntil = async (start, stops) => {
		/** @type {Array<{ oid: string, tree: string, parents: string[] }>} */
		const commits = [];
		const seen = new Set(stops);
		const queue = [start];
		while (queue.length > 0) {
			const oid = /** @type {string} */ (queue.shift());
			if (seen.has(oid)) continue;
			seen.add(oid);
			const commit = await readCommitOrNull(oid);
			if (!commit) continue;
			commits.push({ oid, ...commit });
			queue.push(...commit.parents);
		}
		return commits;
	};

	/**
	 * @returns {Promise<{ branch: string, headOid: string, remoteOid: string | null, ahead: number, behind: number, bases: string[] }>}
	 */
	const aheadBehindUnlocked = async () => {
		const branch = await currentBranch();
		const headOid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
		const remoteOid = await resolveOrNull(`refs/remotes/${REMOTE}/${branch}`);
		if (remoteOid === null) {
			return { branch, headOid, remoteOid, ahead: (await commitsUntil(headOid, new Set())).length, behind: 0, bases: [] };
		}
		const bases = await git.findMergeBase({ fs, gitdir, oids: [headOid, remoteOid], cache });
		const stops = new Set(bases);
		const ahead = (await commitsUntil(headOid, stops)).length;
		const behind = (await commitsUntil(remoteOid, stops)).length;
		return { branch, headOid, remoteOid, ahead, behind, bases };
	};

	/**
	 * Sum of the sizes of blobs the unpushed commits add, each counted once.
	 * The pack compresses them, so this is an upper bound for its blob data.
	 * @param {string} headOid
	 * @param {Set<string>} stops commits the remote already has
	 * @returns {Promise<number>}
	 */
	const estimatePushBytesFrom = async (headOid, stops) => {
		const counted = new Set();
		let total = 0;
		for (const commit of await commitsUntil(headOid, stops)) {
			/** @type {string[]} */
			const parentTrees = [];
			for (const parent of commit.parents) {
				const parentCommit = await readCommitOrNull(parent);
				if (parentCommit) parentTrees.push(parentCommit.tree);
			}
			await git.walk({
				fs,
				dir,
				gitdir,
				cache,
				trees: [git.TREE({ ref: commit.tree }), ...parentTrees.map((ref) => git.TREE({ ref }))],
				map: async (_path, [entry, ...parents]) => {
					if (!entry) return null;
					const type = await entry.type();
					if (type === 'tree') {
						const oid = await entry.oid();
						// An unchanged subtree holds no new blobs.
						for (const parent of parents) {
							if (parent && (await parent.oid()) === oid) return null;
						}
						return true;
					}
					if (type !== 'blob') return null;
					const oid = await entry.oid();
					if (counted.has(oid)) return null;
					for (const parent of parents) {
						if (parent && (await parent.oid()) === oid) return null;
					}
					counted.add(oid);
					const content = await entry.content();
					total += content?.byteLength ?? 0;
					return null;
				}
			});
		}
		return total;
	};

	/** @returns {Promise<RepoStatus>} */
	const statusUnlocked = async () => {
		const matrix = await git.statusMatrix({ fs, dir, gitdir, cache });
		/** @type {FileChange[]} */
		const files = [];
		for (const [path, head, workdir] of matrix) {
			if (head === 0 && workdir === 2) files.push({ path, change: 'added' });
			else if (head === 1 && workdir === 2) files.push({ path, change: 'modified' });
			else if (head === 1 && workdir === 0) files.push({ path, change: 'deleted' });
		}
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const merge = await readMergeState(fs, gitdir);
		return { files, clean: files.length === 0 && merge === null, merge };
	};

	/**
	 * @param {string[]} paths validated paths
	 * @returns {Promise<SizeFinding[]>}
	 */
	const checkPaths = async (paths) => {
		/** @type {SizeFinding[]} */
		const findings = [];
		for (const path of paths) {
			const stat = await lstatOrNull(abs(path));
			if (!stat || !stat.isFile()) continue;
			const finding = checkFileSize(provider, path, stat.size);
			if (finding) findings.push(finding);
		}
		return findings;
	};

	/**
	 * @param {string} path
	 * @returns {Promise<void>}
	 */
	const mkdirp = async (path) => {
		let current = '';
		for (const segment of path.split('/').filter(Boolean)) {
			current = `${current}/${segment}`;
			const stat = await lstatOrNull(current);
			if (stat?.isDirectory()) continue;
			if (stat) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${current} is a file, not a folder.`);
			await fs.promises.mkdir(current);
		}
	};

	/**
	 * @param {string} path absolute path
	 * @returns {Promise<void>}
	 */
	const removeRecursive = async (path) => {
		const stat = await lstatOrNull(path);
		if (!stat) return;
		if (!stat.isDirectory()) {
			await fs.promises.unlink(path);
			return;
		}
		for (const name of /** @type {string[]} */ (await fs.promises.readdir(path))) {
			await removeRecursive(`${path}/${name}`);
		}
		await fs.promises.rmdir(path);
	};

	return {
		id,
		dir,

		/** @returns {Promise<boolean>} whether a clone is on this device */
		isCloned: () => locked(isCloned),

		/**
		 * Shallow-clones the default branch. On failure or cancel nothing is
		 * left behind, so the clone can simply be retried.
		 * @param {{ url: string, onProgress?: ProgressCallback, signal?: AbortSignal }} options
		 * @returns {Promise<{ branch: string, oid: string, persisted: boolean | null }>}
		 */
		clone: ({ url, onProgress, signal }) =>
			locked(async () => {
				if (await isCloned()) {
					throw new GitEngineError(ErrorCode.ALREADY_CLONED, 'This repository is already cloned on this device.');
				}
				signal?.throwIfAborted();
				try {
					await mkdirp(dir);
					await git.clone({
						...base,
						http: withSignal(http, signal),
						url,
						remote: REMOTE,
						singleBranch: true,
						noTags: true,
						// Only the clone is shallow; see `pull` for why fetches never pass depth.
						depth: 1,
						onProgress,
						...authCallbacks(getCredential)
					});
					// The signal aborts requests; a clone whose download had already
					// finished still honours it here.
					signal?.throwIfAborted();
					const branch = await currentBranch();
					await git.setConfig({ fs, gitdir, path: 'gitnote.defaultBranch', value: branch });
					const oid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
					await flush();
					const persisted = storage?.persist ? await storage.persist() : null;
					return { branch, oid, persisted };
				} catch (error) {
					await removeRecursive(dir);
					await flush();
					// With no refs on the remote, clone cannot find a branch to check out.
					if (isMissingBranch(error)) {
						throw new GitEngineError(ErrorCode.EMPTY_REPO, 'This repository has no commits yet. Add a first commit on the git host, then clone it.', {
							cause: error
						});
					}
					throw error;
				}
			}),

		/** @returns {Promise<TreeEntry[]>} every file in the working tree, sorted by path */
		listTree: () =>
			locked(async () => {
				await assertCloned();
				/** @type {TreeEntry[]} */
				const entries = [];
				/** @param {string} relative */
				const visit = async (relative) => {
					const names = /** @type {string[]} */ (await fs.promises.readdir(relative ? abs(relative) : dir));
					for (const name of names.sort()) {
						if (!relative && name === '.git') continue;
						const path = relative ? `${relative}/${name}` : name;
						const stat = await fs.promises.lstat(abs(path));
						if (stat.isDirectory()) await visit(path);
						else if (stat.isFile()) entries.push({ path, size: stat.size });
					}
				};
				await visit('');
				return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			}),

		/**
		 * @param {string} path
		 * @returns {Promise<Uint8Array>}
		 */
		readFile: (path) =>
			locked(async () => {
				const filepath = normalizePath(path);
				try {
					return /** @type {Uint8Array} */ (await fs.promises.readFile(abs(filepath)));
				} catch (error) {
					if (isMissing(error)) throw new GitEngineError(ErrorCode.PATH_NOT_FOUND, `${filepath} does not exist.`);
					throw error;
				}
			}),

		/**
		 * @param {string} path
		 * @returns {Promise<string>} the file as UTF-8 text
		 */
		readText: (path) =>
			locked(async () => {
				const filepath = normalizePath(path);
				try {
					return /** @type {string} */ (await fs.promises.readFile(abs(filepath), { encoding: 'utf8' }));
				} catch (error) {
					if (isMissing(error)) throw new GitEngineError(ErrorCode.PATH_NOT_FOUND, `${filepath} does not exist.`);
					throw error;
				}
			}),

		/**
		 * Writes a working-tree file, creating its folders. Nothing is staged.
		 * @param {string} path
		 * @param {string | Uint8Array} data
		 * @returns {Promise<void>}
		 */
		writeFile: (path, data) =>
			locked(async () => {
				const filepath = normalizePath(path);
				if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
					throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'File content must be text or bytes.');
				}
				await assertCloned();
				const parent = filepath.split('/').slice(0, -1).join('/');
				if (parent) await mkdirp(abs(parent));
				const existing = await lstatOrNull(abs(filepath));
				if (existing?.isDirectory()) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${filepath} is a folder.`);
				// isomorphic-git decides a file is unchanged from its size, whole-second
				// mtime and inode, so a same-size edit in the second of the last index
				// write would look clean, and a pull could then run over it. Swapping
				// in a file created while the old one exists always changes the inode.
				const temp = `${gitdir}/${WRITE_TEMP_FILE}`;
				await fs.promises.writeFile(temp, data, {
					...(typeof data === 'string' ? { encoding: 'utf8' } : {}),
					...(existing ? { mode: existing.mode } : {})
				});
				if (existing) await fs.promises.unlink(abs(filepath));
				await fs.promises.rename(temp, abs(filepath));
				await flush();
			}),

		/**
		 * Renames a file or folder in the working tree. Never overwrites.
		 * @param {string} from
		 * @param {string} to
		 * @returns {Promise<void>}
		 */
		rename: (from, to) =>
			locked(async () => {
				const source = normalizePath(from);
				const target = normalizePath(to);
				await assertCloned();
				if (!(await lstatOrNull(abs(source)))) throw new GitEngineError(ErrorCode.PATH_NOT_FOUND, `${source} does not exist.`);
				if (await lstatOrNull(abs(target))) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${target} already exists.`);
				if (target.startsWith(`${source}/`)) {
					throw new GitEngineError(ErrorCode.INVALID_PATH, 'A folder cannot move inside itself.');
				}
				const parent = target.split('/').slice(0, -1).join('/');
				if (parent) await mkdirp(abs(parent));
				await fs.promises.rename(abs(source), abs(target));
				await flush();
			}),

		/**
		 * Deletes a file or folder from the working tree.
		 * @param {string} path
		 * @returns {Promise<void>}
		 */
		remove: (path) =>
			locked(async () => {
				const filepath = normalizePath(path);
				await assertCloned();
				if (!(await lstatOrNull(abs(filepath)))) throw new GitEngineError(ErrorCode.PATH_NOT_FOUND, `${filepath} does not exist.`);
				await removeRecursive(abs(filepath));
				await flush();
			}),

		/** @returns {Promise<RepoStatus>} */
		status: () =>
			locked(async () => {
				await assertCloned();
				return statusUnlocked();
			}),

		/** @returns {Promise<MergeState | null>} the open merge after a conflicted pull, if any */
		getMergeState: () =>
			locked(async () => {
				await assertCloned();
				return readMergeState(fs, gitdir);
			}),

		/**
		 * Size findings for files about to be committed, for warnings in the UI.
		 * @param {string[]} paths
		 * @returns {Promise<SizeFinding[]>}
		 */
		checkCommit: (paths) =>
			locked(async () => {
				await assertCloned();
				return checkPaths(normalizePaths(paths));
			}),

		/**
		 * Stages the given paths (a missing file stages its deletion) and
		 * commits them. Paths without changes are skipped. Size limits are
		 * checked first: a blocked file stops the commit before anything is
		 * staged.
		 * @param {{ paths: string[], message: string, author: Author }} options
		 * @returns {Promise<{ oid: string, paths: string[], warnings: SizeFinding[] }>}
		 */
		commit: ({ paths, message, author }) =>
			locked(async () => {
				const selected = normalizePaths(paths);
				assertMessage(message);
				assertAuthor(author);
				await assertCloned();
				await assertNoMerge();

				const changed = new Set((await statusUnlocked()).files.map((file) => file.path));
				const toCommit = selected.filter((path) => changed.has(path));
				if (toCommit.length === 0) {
					throw new GitEngineError(ErrorCode.NOTHING_TO_COMMIT, 'None of the selected files has changes to commit.');
				}
				const findings = await checkPaths(toCommit);
				const blocked = findings.filter((finding) => finding.level === 'block');
				if (blocked.length > 0) {
					throw new GitEngineError(ErrorCode.FILE_TOO_LARGE, blocked.map((finding) => finding.message).join(' '), {
						detail: { findings: blocked }
					});
				}

				try {
					for (const filepath of toCommit) {
						if (await lstatOrNull(abs(filepath))) await git.add({ ...base, filepath });
						else await git.remove({ ...base, filepath });
					}
					const oid = await git.commit({ ...base, message, author: { name: author.name, email: author.email } });
					await flush();
					return { oid, paths: toCommit, warnings: findings };
				} catch (error) {
					// Leave the index as it was, so a failed commit stages nothing.
					for (const filepath of toCommit) {
						await git.resetIndex({ ...base, filepath }).catch(() => {});
					}
					throw error;
				}
			}),

		/**
		 * Fetches and merges the remote branch, on a clean working tree only.
		 * A conflict is a result, not an error: the working tree gets the
		 * markers (ours for binary files), the index the unmerged entries, and
		 * the merge state is stored so a reload can resume it. The branch ref
		 * does not move until the merge commit.
		 * @param {{ author: Author, onProgress?: ProgressCallback }} options
		 * @returns {Promise<PullResult>}
		 */
		pull: ({ author, onProgress }) =>
			locked(async () => {
				assertAuthor(author);
				await assertCloned();
				await assertNoMerge();
				const { files } = await statusUnlocked();
				if (files.length > 0) {
					throw new GitEngineError(
						ErrorCode.DIRTY_TREE,
						`Commit or discard your changes before pulling (${files.length} changed ${files.length === 1 ? 'file' : 'files'}).`,
						{ detail: { files } }
					);
				}

				const branch = await currentBranch();
				const remoteRef = `refs/remotes/${REMOTE}/${branch}`;
				// No `depth` here: a depth-limited fetch marks the new remote tip
				// shallow, after which no merge base exists for a diverged branch.
				await git.fetch({
					...base,
					http,
					remote: REMOTE,
					ref: branch,
					singleBranch: true,
					tags: false,
					onProgress,
					...authCallbacks(getCredential)
				});
				await flush();
				const oursOid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
				const theirsOid = await git.resolveRef({ fs, gitdir, ref: remoteRef });
				if (oursOid === theirsOid) return { status: 'up_to_date', oid: oursOid };

				const mergeAuthor = { name: author.name, email: author.email };
				try {
					// Fast-forward, or a clean merge commit; touches no file on conflict.
					const result = await git.merge({
						...base,
						ours: branch,
						theirs: remoteRef,
						author: mergeAuthor,
						abortOnConflict: true,
						mergeDriver: createMergeDriver(new Set())
					});
					if (result.alreadyMerged) return { status: 'up_to_date', oid: oursOid };
					await git.checkout({ ...base, ref: branch });
					await flush();
					return { status: result.fastForward ? 'fast_forward' : 'merged', oid: /** @type {string} */ (result.oid) };
				} catch (error) {
					if (/** @type {{ code?: string }} */ (error)?.code !== 'MergeConflictError') throw error;
				}

				/** @type {Set<string>} */
				const binaryPaths = new Set();
				const conflict = /** @type {{ code?: string, data?: { filepaths?: string[] } }} */ (
					await git
						.merge({
							...base,
							ours: branch,
							theirs: remoteRef,
							author: mergeAuthor,
							abortOnConflict: false,
							mergeDriver: createMergeDriver(binaryPaths)
						})
						.then(
							() => {
								throw new Error('The merge was expected to conflict.');
							},
							(/** @type {unknown} */ error) => error
						)
				);
				if (conflict?.code !== 'MergeConflictError') throw conflict;
				const conflictedPaths = [...(conflict.data?.filepaths ?? [])].sort();

				// A binary file keeps our bytes in the working tree; diff3 markers
				// would corrupt it.
				for (const filepath of binaryPaths) {
					const { blob } = await git.readBlob({ fs, gitdir, oid: oursOid, filepath, cache });
					await fs.promises.writeFile(abs(filepath), blob);
				}
				/** @type {MergeState} */
				const merge = {
					branch,
					oursOid,
					theirsOid,
					conflictedPaths,
					binaryPaths: [...binaryPaths].sort(),
					startedAt: new Date().toISOString()
				};
				await writeMergeState(fs, gitdir, merge);
				await flush();
				return { status: 'conflict', oid: oursOid, merge };
			}),

		/**
		 * Commits the remote does not have yet, and what it does not have.
		 * @returns {Promise<{ branch: string, ahead: number, behind: number, hasRemote: boolean }>}
		 */
		aheadBehind: () =>
			locked(async () => {
				await assertCloned();
				const { branch, ahead, behind, remoteOid } = await aheadBehindUnlocked();
				return { branch, ahead, behind, hasRemote: remoteOid !== null };
			}),

		/** @returns {Promise<number>} the estimated size of the next push, in bytes */
		estimatePushBytes: () =>
			locked(async () => {
				await assertCloned();
				const { headOid, remoteOid, bases } = await aheadBehindUnlocked();
				return estimatePushBytesFrom(headOid, new Set([...(remoteOid ? [remoteOid] : []), ...bases]));
			}),

		/**
		 * Pushes the current branch. Refuses before any network call when a
		 * merge is open, when the remote has commits we lack, or when the
		 * estimated pack is over the limit.
		 * @param {{ onProgress?: ProgressCallback, signal?: AbortSignal }} [options]
		 * @returns {Promise<{ pushed: boolean, oid: string, bytes: number }>}
		 */
		push: ({ onProgress, signal } = {}) =>
			locked(async () => {
				await assertCloned();
				await assertNoMerge();
				const { branch, headOid, remoteOid, ahead, behind, bases } = await aheadBehindUnlocked();
				if (remoteOid !== null && ahead === 0) return { pushed: false, oid: headOid, bytes: 0 };
				if (behind > 0) {
					throw new GitEngineError(ErrorCode.NON_FAST_FORWARD, 'The remote branch has commits you do not have. Pull first, then push.');
				}
				const bytes = await estimatePushBytesFrom(headOid, new Set([...(remoteOid ? [remoteOid] : []), ...bases]));
				const tooLarge = checkPushSize(provider, bytes);
				if (tooLarge) throw new GitEngineError(ErrorCode.PUSH_TOO_LARGE, tooLarge.message, { detail: { finding: tooLarge } });

				/** @type {string[]} */
				const remoteMessages = [];
				try {
					await git.push({
						...base,
						http: withSignal(http, signal),
						remote: REMOTE,
						ref: branch,
						onProgress,
						onMessage: (message) => {
							remoteMessages.push(message.trim());
						},
						signal,
						...authCallbacks(getCredential)
					});
				} catch (error) {
					// isomorphic-git hands remote messages over without awaiting them.
					await new Promise((resolve) => setTimeout(resolve, 0));
					throw toGitEngineError(error, { remoteMessages });
				}
				await flush();
				return { pushed: true, oid: headOid, bytes };
			})
	};
}

/** @typedef {ReturnType<typeof createRepo>} Repo */

/**
 * Validates a working-tree path from the UI: relative, `/`-separated, and
 * never inside `.git` or outside the working tree.
 * @param {unknown} path
 * @returns {string}
 */
export function normalizePath(path) {
	if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
		throw new GitEngineError(ErrorCode.INVALID_PATH, 'A file path is required.');
	}
	if (path.includes('\\') || path.includes('\0')) {
		throw new GitEngineError(ErrorCode.INVALID_PATH, `${JSON.stringify(path)} is not a valid file path.`);
	}
	if (path.split('/').some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
		throw new GitEngineError(ErrorCode.INVALID_PATH, `${JSON.stringify(path)} is not a valid file path.`);
	}
	return path;
}

/**
 * @param {unknown} paths
 * @returns {string[]} unique validated paths
 */
function normalizePaths(paths) {
	if (!Array.isArray(paths) || paths.length === 0) {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'Select at least one file.');
	}
	return [...new Set(paths.map(normalizePath))];
}

/**
 * @param {unknown} message
 */
function assertMessage(message) {
	if (typeof message !== 'string' || message.trim() === '') {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'A commit message is required.');
	}
}

/**
 * @param {unknown} author
 */
function assertAuthor(author) {
	const value = /** @type {Partial<Author> | null | undefined} */ (author);
	if (typeof value?.name !== 'string' || value.name.trim() === '' || typeof value.email !== 'string' || value.email.trim() === '') {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'Set an author name and email for commits.');
	}
}

/**
 * @param {unknown} error
 * @returns {boolean} whether isomorphic-git could not find a branch ref
 */
function isMissingBranch(error) {
	const { code, message } = /** @type {{ code?: string, message?: string }} */ (error ?? {});
	return code === 'NotFoundError' && /refs\/heads\//.test(message ?? '');
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissing(error) {
	return /** @type {{ code?: string }} */ (error)?.code === 'ENOENT';
}
