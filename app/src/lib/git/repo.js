/**
 * The git engine: clone, read, write, commit, pull and push one repository on
 * the device, with no UI. The file system is a parameter: LightningFS in the
 * browser (see fs.js), any Node-style `fs` with `promises` elsewhere.
 *
 * Every public operation holds the repository's lock (lock.js), and every
 * operation that changes stored data flushes the file system before it
 * resolves, so a resolved commit survives the tab closing right after. The
 * exceptions are pull's fetch and push's send: they add objects and move only
 * the remote-tracking ref, so they run under a separate network lock and a
 * stalled connection cannot hold up saving a draft.
 *
 * LightningFS overwrites an existing file in IndexedDB at once, but records a
 * new file only when its directory is saved by a flush. Objects are new files,
 * while the index and branch refs are overwritten, so a tab that dies can keep
 * a ref or an index that names objects it lost. Objects are therefore always
 * flushed before anything names them.
 *
 * A pull records itself on disk before it changes anything, and the first
 * operation after an interrupted pull undoes it, so a crash never leaves a
 * moved branch over an old working tree. See `MergeState`.
 */

import { Buffer } from 'buffer';
import git from 'isomorphic-git';
import { ErrorCode, GitEngineError, toGitEngineError } from './errors.js';
import { assertNoCredentials, requestPersistentStorage } from './fs.js';
import { authCallbacks, withSignal } from './http.js';
import { checkFileSize, checkPushSize, checkUnpushedSize, limitsFor } from './limits.js';
import { withRepoLock } from './lock.js';
import { clearMergeState, createMergeDriver, hasConflictMarkers, isBinary, readMergeState, writeMergeState } from './merge.js';

// isomorphic-git uses the Node `Buffer` global; browsers have none.
globalThis.Buffer ??= Buffer;

/**
 * A promise-style file system; the engine also renames files and writes links.
 * @typedef {import('isomorphic-git').PromiseFsClient & { promises: { rename: (from: string, to: string) => Promise<unknown>, symlink: (target: string, path: string) => Promise<unknown>, readlink: (path: string) => Promise<unknown> } }} FsClient
 */
/** @typedef {import('isomorphic-git').HttpClient} HttpClient */
/** @typedef {import('isomorphic-git').ProgressCallback} ProgressCallback */
/** @typedef {import('./http.js').CredentialSource} CredentialSource */
/** @typedef {import('./limits.js').ProviderId} ProviderId */
/** @typedef {import('./limits.js').SizeFinding} SizeFinding */
/** @typedef {import('./merge.js').MergeState} MergeState */
/** @typedef {import('./merge.js').Conflict} Conflict */
/** @typedef {import('./lock.js').LockManagerLike} LockManagerLike */

/**
 * @typedef {object} Author
 * @property {string} name
 * @property {string} email
 */

/**
 * @typedef {object} FileChange
 * @property {string} path
 * @property {'added' | 'modified' | 'deleted'} change compared with HEAD; while
 *   a merge is open, every conflicted path and any edit on top of the merge's
 *   staged result, which already holds the clean half of the merge
 */

/**
 * One blob in a commit's tree.
 * @typedef {object} TreeBlob
 * @property {string} oid
 * @property {number} mode
 */

/**
 * A path whose blob differs between ours and theirs.
 * @typedef {object} BlobChange
 * @property {string} path
 * @property {TreeBlob | null} ours
 * @property {TreeBlob | null} theirs
 * @property {TreeBlob | null} base
 */

/**
 * @typedef {object} RepoStatus
 * @property {FileChange[]} files changed files, sorted by path
 * @property {boolean} clean no changed files and no open merge
 * @property {MergeState | null} merge the open merge, if any
 */

/**
 * What deleting a copy would lose. Nulls mean it could not be read.
 * @typedef {object} WorkCounts
 * @property {number | null} unpushed commits only on this device
 * @property {number | null} drafts changed files not yet committed
 */

/**
 * @typedef {object} TreeEntry
 * @property {string} path
 * @property {number} size bytes
 * @property {true} [symlink] a symbolic link, whose target must not be followed
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
 * @property {{ persist?: () => Promise<boolean | null> }} [storage] asked to make storage persistent after the first clone; defaults to the browser's storage
 * @property {LockManagerLike | null} [locks] defaults to `navigator.locks`
 */

const REMOTE = 'origin';

/** Where `writeFile` prepares new content, out of the working tree. */
const WRITE_TEMP_FILE = 'gitnote-write.tmp';

/** Where `writeFile` keeps the old file until the new one is flushed. */
const WRITE_BACKUP_FILE = 'gitnote-write.bak';

/** Git's file mode for a symbolic link. */
const SYMLINK_MODE = 0o120000;

/** These would break the `name <email>` line of a commit's header. */
const AUTHOR_FORBIDDEN = /[\p{Cc}<>]/u;

/** What git's check-ref-format forbids in a branch name, including a leading `-`. */
const BAD_BRANCH_NAME = /^-|^\/|\/$|\/\/|\.\.|@\{|\.lock(\/|$)|\.$|\/\.|^\.|[\p{Cc} ~^:?*[\\]/u;

/** Path segments that would reach git's own data or leave the working tree. */
const FORBIDDEN_SEGMENTS = new Set(['', '.', '..', '.git']);

// The operations' types are inferred; `Repo` below names them.
// eslint-disable-next-line jsdoc/require-returns
/**
 * @param {RepoOptions} options
 */
export function createRepo({ id, fs, http, provider, getCredential, dir = '/repo', storage = { persist: requestPersistentStorage }, locks }) {
	const gitdir = `${dir}/.git`;
	/** Serialises this repository's network traffic, apart from its lock. */
	const networkLock = `${id}#network`;
	/** isomorphic-git's parsed-object cache, shared by this repo's operations. */
	const cache = {};
	const base = { fs, dir, gitdir, cache };

	/**
	 * @template T
	 * @param {string} lockId
	 * @param {() => Promise<T>} operation
	 * @param {AbortSignal} [signal] once aborted, any failure counts as the cancel
	 * @returns {Promise<T>}
	 */
	const withLock = (lockId, operation, signal) =>
		withRepoLock(
			lockId,
			async () => {
				try {
					return await operation();
				} catch (error) {
					if (signal?.aborted && !(error instanceof GitEngineError)) {
						throw new GitEngineError(ErrorCode.CANCELLED, 'The operation was cancelled.', { cause: error });
					}
					throw toGitEngineError(error);
				}
			},
			locks === undefined ? undefined : { locks }
		);

	/**
	 * @template T
	 * @param {() => Promise<T>} operation
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<T>}
	 */
	const locked = (operation, signal) =>
		withLock(
			id,
			async () => {
				await recoverInterruptedPull();
				return operation();
			},
			signal
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

	/**
	 * The default branch is recorded last, so a clone interrupted by a closed
	 * tab or a crash, which no catch block ever sees, does not count.
	 * @returns {Promise<boolean>}
	 */
	const isCloned = async () => {
		if ((await lstatOrNull(gitdir)) === null) return false;
		return Boolean(await git.getConfig({ fs, gitdir, path: 'gitnote.defaultBranch' }));
	};

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
	 * The commit behind a branch is never expected to be absent, unlike the
	 * parents past a shallow boundary, and nothing can be done without it.
	 * @returns {Promise<void>}
	 */
	const assertHeadPresent = async () => {
		if (await readCommitOrNull(await git.resolveRef({ fs, gitdir, ref: 'HEAD' }))) return;
		throw new GitEngineError(
			ErrorCode.REPO_DAMAGED,
			"This repository's local copy is damaged: the commit its branch points at is missing. Remove it from this device and clone it again."
		);
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
	 * @param {string} oid
	 * @returns {Promise<Set<string>>} `oid` and every ancestor on disk
	 */
	const ancestorsOf = async (oid) => new Set((await commitsUntil(oid, new Set())).map((commit) => commit.oid));

	/**
	 * Counts against full ancestor sets, not merge bases: after a merge, the
	 * walk from HEAD would otherwise go through the local parent to commits the
	 * remote already has, and count a shallow boundary's whole tree as new.
	 * @returns {Promise<{ branch: string, headOid: string, remoteOid: string | null, ahead: number, behind: number, remoteCommits: Set<string> }>}
	 */
	const aheadBehindUnlocked = async () => {
		await assertHeadPresent();
		const branch = await currentBranch();
		const headOid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
		const remoteOid = await resolveOrNull(`refs/remotes/${REMOTE}/${branch}`);
		const remoteCommits = remoteOid === null ? new Set() : await ancestorsOf(remoteOid);
		const ahead = (await commitsUntil(headOid, remoteCommits)).length;
		const behind = remoteOid === null ? 0 : (await commitsUntil(remoteOid, await ancestorsOf(headOid))).length;
		return { branch, headOid, remoteOid, ahead, behind, remoteCommits };
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
		await assertHeadPresent();
		const matrix = await git.statusMatrix({ fs, dir, gitdir, cache });
		const merge = await readMergeState(fs, gitdir);
		const conflicted = new Set(merge?.conflictedPaths);
		/** @type {FileChange[]} */
		const files = [];
		/**
		 * @param {string} path
		 * @param {number} head
		 * @param {number} workdir
		 */
		const report = (path, head, workdir) => {
			files.push({ path, change: workdir === 0 ? 'deleted' : head === 0 ? 'added' : 'modified' });
		};
		for (const [path, head, workdir, stage] of matrix) {
			if (merge) {
				// The index holds the merge's result, so an edit is what differs from it.
				const matchesIndex = stage === 2 || (workdir === 1 && stage === 1) || (workdir === 0 && stage === 0);
				if (conflicted.delete(path) || !matchesIndex) report(path, head, workdir);
			} else if (workdir === 2 || (head === 1 && workdir === 0)) {
				report(path, head, workdir);
			}
		}
		// A conflicted file only theirs had, once removed, is in neither HEAD nor the tree.
		for (const path of conflicted) files.push({ path, change: 'deleted' });
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return { files, clean: files.length === 0 && merge === null, merge };
	};

	/** @returns {Promise<void>} */
	const assertCleanTree = async () => {
		const { files } = await statusUnlocked();
		if (files.length > 0) {
			throw new GitEngineError(
				ErrorCode.DIRTY_TREE,
				`Commit or discard your changes before pulling (${files.length} changed ${files.length === 1 ? 'file' : 'files'}).`,
				{ detail: { files } }
			);
		}
	};

	/**
	 * Files `status` hides because they are ignored can still sit where the
	 * remote now tracks a file, and a merge would overwrite them.
	 * @param {string} theirsOid
	 * @returns {Promise<void>}
	 */
	const assertNoUntrackedCollisions = async (theirsOid) => {
		const matrix = await git.statusMatrix({ fs, dir, gitdir, cache, ref: theirsOid, ignored: true });
		const paths = matrix.filter(([, incoming, workdir, stage]) => incoming === 1 && workdir === 2 && stage === 0).map(([path]) => path);
		if (paths.length > 0) {
			throw new GitEngineError(
				ErrorCode.CHECKOUT_CONFLICT,
				`Pulling would overwrite files on this device that git does not track: ${paths.join(', ')}. Move them, then pull again.`,
				{ detail: { files: paths } }
			);
		}
	};

	/**
	 * The blobs that differ between two commits, with what a third has there.
	 * @param {string} oursOid
	 * @param {string} theirsOid
	 * @param {string} [baseOid]
	 * @returns {Promise<BlobChange[]>}
	 */
	const changedBlobs = async (oursOid, theirsOid, baseOid) => {
		/** @type {BlobChange[]} */
		const changes = [];
		await git.walk({
			fs,
			dir,
			gitdir,
			cache,
			trees: [oursOid, theirsOid, ...(baseOid ? [baseOid] : [])].map((ref) => git.TREE({ ref })),
			map: async (path, [ours, theirs, base]) => {
				const oursType = await ours?.type();
				const theirsType = await theirs?.type();
				if (oursType === 'tree' && theirsType === 'tree' && (await ours?.oid()) === (await theirs?.oid())) return null;
				const oursBlob = await treeBlob(ours);
				const theirsBlob = await treeBlob(theirs);
				if (!sameBlob(oursBlob, theirsBlob)) changes.push({ path, ours: oursBlob, theirs: theirsBlob, base: await treeBlob(base) });
				return oursType === 'tree' || theirsType === 'tree' ? true : null;
			}
		});
		return changes;
	};

	/**
	 * Writes a committed blob to the working tree as a new file, so the file's
	 * inode changes too: see `writeFile`.
	 * @param {string} path
	 * @param {TreeBlob} blob
	 * @returns {Promise<void>}
	 */
	const writeTreeBlob = async (path, { oid, mode }) => {
		const target = abs(path);
		await removeRecursive(target);
		const parent = path.split('/').slice(0, -1).join('/');
		if (parent) await mkdirp(abs(parent));
		const { blob } = await git.readBlob({ fs, gitdir, oid, cache });
		if (mode === SYMLINK_MODE) await fs.promises.symlink(new TextDecoder().decode(blob), target);
		else await fs.promises.writeFile(target, blob, { mode: mode & 0o111 ? 0o777 : 0o666 });
	};

	/**
	 * Removes a path and the folders that leaves empty; git has no empty folders.
	 * @param {string} path
	 * @returns {Promise<void>}
	 */
	const removeFromTree = async (path) => {
		await removeRecursive(abs(path));
		await pruneEmptyParents(path);
	};

	/**
	 * @param {string} path a path just removed or moved away
	 * @returns {Promise<void>}
	 */
	const pruneEmptyParents = async (path) => {
		const segments = path.split('/').slice(0, -1);
		while (segments.length > 0) {
			const folder = abs(segments.join('/'));
			const stat = await lstatOrNull(folder);
			if (stat?.isDirectory()) {
				if (/** @type {string[]} */ (await fs.promises.readdir(folder)).length > 0) return;
				await fs.promises.rmdir(folder);
			}
			segments.pop();
		}
	};

	/**
	 * Puts the branch, the working tree and the index back to where a pull
	 * found them, and closes its record last, so a crash here is simply retried.
	 * A pull starts on a clean tree, and only paths that differ between ours and
	 * theirs can have moved, so this restores those from ours. For the same
	 * reason it discards a conflict's resolution in progress. A path in
	 * `keptDrafts` keeps its file and only leaves the merge's index.
	 * @param {MergeState} state
	 * @returns {Promise<void>}
	 */
	const rollBackPull = async ({ branch, oursOid, theirsOid, keptDrafts }) => {
		const kept = new Set(keptDrafts);
		await git.writeRef({ fs, gitdir, ref: `refs/heads/${branch}`, value: oursOid, force: true });
		for (const { path, ours } of await changedBlobs(oursOid, theirsOid)) {
			if (!kept.has(path)) {
				if (ours) await writeTreeBlob(path, ours);
				else await removeFromTree(path);
			}
			await git.resetIndex({ ...base, ref: oursOid, filepath: path });
		}
		await flush();
		await clearMergeState(fs, gitdir);
		await flush();
	};

	/**
	 * Runs before every operation. A pull that was applying when the tab died
	 * is undone, and a merge commit that landed just before the tab died
	 * closes its merge state.
	 * @returns {Promise<void>}
	 */
	const recoverInterruptedPull = async () => {
		const state = await readMergeState(fs, gitdir);
		if (!state) return;
		if (state.phase === 'applying') {
			await rollBackPull(state);
		} else if ((await git.resolveRef({ fs, gitdir, ref: 'HEAD' })) !== state.oursOid) {
			await clearMergeState(fs, gitdir);
			await flush();
		}
	};

	/**
	 * @param {string} oid
	 * @param {string} filepath
	 * @returns {Promise<TreeBlob | null>} null when the commit has no file there
	 */
	const treeBlobAt = async (oid, filepath) => {
		const segments = filepath.split('/');
		/** @type {TreeBlob | null} */
		let found = null;
		await git.walk({
			fs,
			dir,
			gitdir,
			cache,
			trees: [git.TREE({ ref: oid })],
			map: async (path, [entry]) => {
				if (path === filepath) {
					found = await treeBlob(entry);
					return null;
				}
				// Only the folders on the way down to the file are worth opening.
				return path === '.' || segments.slice(0, path.split('/').length).join('/') === path ? true : null;
			}
		});
		return found;
	};

	/**
	 * @param {string} oid
	 * @param {string} filepath
	 * @returns {Promise<Uint8Array | null>} null when the commit does not have the path
	 */
	const readBlobOrNull = async (oid, filepath) => {
		try {
			return (await git.readBlob({ fs, gitdir, oid, filepath, cache })).blob;
		} catch (error) {
			if (/** @type {{ code?: string }} */ (error)?.code === 'NotFoundError') return null;
			throw error;
		}
	};

	/**
	 * Writes merged text as a new file, keeping the old file's mode unless the
	 * merge settled on another.
	 * @param {string} path
	 * @param {string} text
	 * @param {number} [mode] the git mode of the merged file
	 * @returns {Promise<void>}
	 */
	const writeMergedText = async (path, text, mode) => {
		const target = abs(path);
		const existing = await lstatOrNull(target);
		await removeRecursive(target);
		const fileMode = mode === undefined ? existing?.mode : mode & 0o111 ? 0o777 : 0o666;
		await fs.promises.writeFile(target, text, { encoding: 'utf8', ...(fileMode === undefined ? {} : { mode: fileMode }) });
	};

	/**
	 * Builds a conflicted merge's result from what isomorphic-git's merge wrote
	 * to the index. The working tree still holds ours, so only paths that differ
	 * from ours change. Each path that merged cleanly is staged, so the merge
	 * commit cannot revert the remote's changes; a conflicted path gets markers,
	 * or one side's exact bytes when it is binary or one side deleted it.
	 * Only a conflict the merge driver ran on can have markers, and a file one
	 * side deleted never reaches the driver, so what each side did is read from
	 * the commits.
	 *
	 * isomorphic-git hands its driver a file's base name, so what it reports
	 * cannot be told apart by path. The driver runs again here, on each file both
	 * sides changed, with the full path.
	 * @param {{ branch: string, oursOid: string, theirsOid: string, conflictedPaths: string[] }} options
	 * @returns {Promise<Conflict[]>}
	 */
	const applyConflictedMerge = async ({ branch, oursOid, theirsOid, conflictedPaths }) => {
		const conflicted = new Set(conflictedPaths);
		/** @type {Set<string>} */
		const driverBinaryPaths = new Set();
		/** @type {Map<string, string>} */
		const mergedTexts = new Map();
		const driver = createMergeDriver(driverBinaryPaths, mergedTexts);
		/**
		 * @param {TreeBlob | null} blob
		 * @returns {Promise<string>} its content as the driver reads it; an absent base is empty
		 */
		const decoded = async (blob) => (blob ? new TextDecoder().decode((await git.readBlob({ fs, gitdir, oid: blob.oid, cache })).blob) : '');
		const [baseOid] = await git.findMergeBase({ fs, gitdir, oids: [oursOid, theirsOid], cache });
		/** @type {Conflict[]} */
		const conflicts = [];
		/** @type {string[]} */
		const toStage = [];
		for (const { path, ours, theirs, base: baseBlob } of await changedBlobs(oursOid, theirsOid, baseOid)) {
			if (ours && theirs && ours.oid !== theirs.oid && baseBlob?.oid !== ours.oid && baseBlob?.oid !== theirs.oid) {
				await driver({ branches: ['base', branch, `${REMOTE}/${branch}`], contents: [await decoded(baseBlob), await decoded(ours), await decoded(theirs)], path });
			}
			const mergedText = mergedTexts.get(path);
			if (conflicted.has(path)) {
				const survivor = ours ?? theirs;
				const kind = !ours ? 'deleted_by_us' : !theirs ? 'deleted_by_theirs' : 'both_modified';
				const binary =
					driverBinaryPaths.has(path) ||
					(kind !== 'both_modified' &&
						survivor !== null &&
						isBinary(new TextDecoder().decode((await git.readBlob({ fs, gitdir, oid: survivor.oid, cache })).blob)));
				if (kind === 'deleted_by_us' && theirs) await writeTreeBlob(path, theirs);
				else if (kind === 'both_modified' && !binary && mergedText !== undefined) await writeMergedText(path, mergedText);
				conflicts.push({ path, kind, binary });
			} else if (sameBlob(baseBlob, theirs)) {
				// Only we changed it: the index and working tree already hold it.
			} else if (!sameBlob(baseBlob, ours)) {
				// Both sides changed it. Content and mode merge separately, and the
				// driver only runs when both sides changed the content.
				const mode = ours && theirs ? (baseBlob?.mode === ours.mode ? theirs.mode : ours.mode) : undefined;
				if (mergedText !== undefined) await writeMergedText(path, mergedText, mode);
				else if (ours && theirs && mode !== undefined) await writeTreeBlob(path, { oid: baseBlob?.oid === ours.oid ? theirs.oid : ours.oid, mode });
				toStage.push(path);
			} else if (theirs) {
				await writeTreeBlob(path, theirs);
				toStage.push(path);
			} else {
				await removeFromTree(path);
				await git.remove({ ...base, filepath: path });
			}
		}
		// Forced, because the remote may track a path that matches .gitignore.
		if (toStage.length > 0) await git.add({ ...base, filepath: toStage, force: true });
		return conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	};

	/**
	 * Merges fetched commits into a clean tree. The merge's record is flushed
	 * before anything moves, and any failure puts everything back.
	 * @param {{ branch: string, oursOid: string, theirsOid: string, remoteRef: string, author: { name: string, email: string } }} options
	 * @returns {Promise<PullResult>}
	 */
	const applyPull = async ({ branch, oursOid, theirsOid, remoteRef, author }) => {
		/** @type {MergeState} */
		const applying = {
			phase: 'applying',
			branch,
			oursOid,
			theirsOid,
			conflictedPaths: [],
			binaryPaths: [],
			conflicts: [],
			resolvedPaths: [],
			keptDrafts: [],
			startedAt: new Date().toISOString()
		};
		await writeMergeState(fs, gitdir, applying);
		await flush();
		try {
			try {
				// Fast-forward, or a clean merge commit; touches no file on conflict.
				const result = await git.merge({
					...base,
					ours: branch,
					theirs: remoteRef,
					author,
					abortOnConflict: true,
					mergeDriver: createMergeDriver(new Set())
				});
				await git.checkout({ ...base, ref: branch });
				await flush();
				await clearMergeState(fs, gitdir);
				await flush();
				return { status: result.fastForward ? 'fast_forward' : 'merged', oid: /** @type {string} */ (result.oid) };
			} catch (error) {
				if (/** @type {{ code?: string }} */ (error)?.code !== 'MergeConflictError') throw error;
			}

			// With no `dir`, the merge only fills the index. With one, it rewrites
			// the whole working tree as text, and fails on a symbolic link.
			const conflict = /** @type {{ code?: string, data?: { filepaths?: string[] } }} */ (
				await git
					.merge({ fs, gitdir, cache, ours: branch, theirs: remoteRef, author, abortOnConflict: false, mergeDriver: createMergeDriver(new Set()) })
					.then(
						() => {
							throw new Error('The merge was expected to conflict.');
						},
						(/** @type {unknown} */ error) => error
					)
			);
			if (conflict?.code !== 'MergeConflictError') throw conflict;
			const conflictedPaths = [...(conflict.data?.filepaths ?? [])].sort();

			const conflicts = await applyConflictedMerge({ branch, oursOid, theirsOid, conflictedPaths });
			// The record is overwritten at once, so it may say `conflicted` only
			// once the tree it describes is saved; until then a crash rolls back.
			await flush();
			/** @type {MergeState} */
			const merge = {
				...applying,
				phase: 'conflicted',
				conflictedPaths,
				binaryPaths: conflicts.filter((item) => item.binary).map((item) => item.path),
				conflicts
			};
			await writeMergeState(fs, gitdir, merge);
			await flush();
			return { status: 'conflict', oid: oursOid, merge };
		} catch (error) {
			// When this fails too, the record stays and the next operation retries it.
			await rollBackPull(applying).catch(() => {});
			throw error;
		}
	};

	/**
	 * @param {SizeFinding[]} findings
	 * @returns {void}
	 */
	const assertNotBlocked = (findings) => {
		const blocked = findings.filter((finding) => finding.level === 'block');
		if (blocked.length > 0) {
			throw new GitEngineError(ErrorCode.FILE_TOO_LARGE, blocked.map((finding) => finding.message).join(' '), {
				detail: { findings: blocked }
			});
		}
	};

	/** @returns {Promise<MergeState>} */
	const requireOpenMerge = async () => {
		const merge = await readMergeState(fs, gitdir);
		if (!merge) throw new GitEngineError(ErrorCode.NO_OPEN_MERGE, 'No merge is open.');
		return merge;
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
	 * What committing these paths would run into, for warnings in the UI. A file
	 * that alone exceeds the push limit already says so.
	 * @param {string[]} paths validated paths
	 * @returns {Promise<SizeFinding[]>}
	 */
	const checkPathsForCommit = async (paths) => {
		const findings = await checkPaths(paths);
		const { blockPushBytes } = limitsFor(provider);
		if (findings.some((finding) => finding.size > blockPushBytes)) return findings;
		const { headOid, remoteCommits } = await aheadBehindUnlocked();
		let bytes = await estimatePushBytesFrom(headOid, remoteCommits);
		for (const path of paths) bytes += (await lstatOrNull(abs(path)))?.size ?? 0;
		const finding = checkUnpushedSize(provider, bytes);
		return finding ? [...findings, finding] : findings;
	};

	/**
	 * @param {string} path
	 * @returns {Promise<Uint8Array | null>} what git would store for a working-tree path, or null without a file there
	 */
	const readWorkingBlob = async (path) => {
		const stat = await lstatOrNull(abs(path));
		if (stat?.isSymbolicLink()) return new TextEncoder().encode(/** @type {string} */ (await fs.promises.readlink(abs(path))));
		return stat?.isFile() ? /** @type {Uint8Array} */ (await fs.promises.readFile(abs(path))) : null;
	};

	/**
	 * Saves these paths' blobs, so the index that is about to name them can
	 * never outlive them. `git.add` then finds each one already written.
	 * @param {string[]} paths validated paths
	 * @returns {Promise<void>}
	 */
	const saveBlobs = async (paths) => {
		for (const path of paths) {
			const blob = await readWorkingBlob(path);
			if (blob) await git.writeBlob({ fs, dir, gitdir, blob });
		}
		await flush();
	};

	/**
	 * Makes a commit from the index and only then moves the branch, because the
	 * ref is overwritten at once while the commit's objects are new files.
	 * @param {{ message: string, author: Author, parent?: string[] }} options
	 * @returns {Promise<string>} the new commit
	 */
	const commitAndMoveBranch = async ({ message, author, parent }) => {
		const branch = await currentBranch();
		const oid = await git.commit({ ...base, message, author: { name: author.name, email: author.email }, ...(parent ? { parent } : {}), noUpdateBranch: true });
		await flush();
		await git.writeRef({ fs, gitdir, ref: `refs/heads/${branch}`, value: oid, force: true });
		await flush();
		return oid;
	};

	/**
	 * Unstages everything but `selected`. A tab that died between staging and
	 * committing leaves staged paths behind, which would join an unrelated commit.
	 * @param {string[]} selected
	 * @returns {Promise<void>}
	 */
	const unstageOthers = async (selected) => {
		const keep = new Set(selected);
		for (const [filepath, head, , stage] of await git.statusMatrix({ fs, dir, gitdir, cache })) {
			const staged = head === 0 ? stage !== 0 : stage !== 1;
			if (staged && !keep.has(filepath)) await git.resetIndex({ ...base, filepath });
		}
	};

	/**
	 * Conflicts with no markers that nobody has decided: binary files and files
	 * one side deleted still hold what the merge put there.
	 * @param {MergeState} merge
	 * @returns {Promise<string[]>}
	 */
	const undecidedConflicts = async (merge) => {
		const resolved = new Set(merge.resolvedPaths);
		/** @type {string[]} */
		const undecided = [];
		for (const { path, kind, binary } of merge.conflicts) {
			if (resolved.has(path) || (kind === 'both_modified' && !binary)) continue;
			const blob = await readWorkingBlob(path);
			if (!blob) continue;
			const { oid: initial } = await git.readBlob({ fs, gitdir, oid: kind === 'deleted_by_us' ? merge.theirsOid : merge.oursOid, filepath: path, cache });
			if ((await git.hashBlob({ object: blob })).oid === initial) undecided.push(path);
		}
		return undecided;
	};

	/**
	 * @param {MergeState} merge
	 * @returns {Promise<string[]>} conflicted text files that still hold markers
	 */
	const conflictsWithMarkers = async (merge) => {
		/** @type {string[]} */
		const withMarkers = [];
		for (const { path, binary } of merge.conflicts) {
			if (binary || !(await lstatOrNull(abs(path)))) continue;
			const text = /** @type {string} */ (await fs.promises.readFile(abs(path), { encoding: 'utf8' }));
			if (hasConflictMarkers(text)) withMarkers.push(path);
		}
		return withMarkers;
	};

	/**
	 * Downloads the remote branch's new commits and moves only the
	 * remote-tracking ref. No `depth` here: a depth-limited fetch marks the new
	 * remote tip shallow, after which no merge base exists for a diverged branch.
	 * @param {{ branch: string, onProgress?: ProgressCallback, signal?: AbortSignal }} options
	 * @returns {Promise<void>}
	 */
	const fetchBranch = ({ branch, onProgress, signal }) =>
		withLock(
			networkLock,
			async () => {
				signal?.throwIfAborted();
				await git.fetch({
					...base,
					http: withSignal(http, signal),
					remote: REMOTE,
					ref: branch,
					singleBranch: true,
					tags: false,
					onProgress,
					...authCallbacks(getCredential)
				});
				await flush();
			},
			signal
		);

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

	/**
	 * The caller holds the lock.
	 * @param {string} path
	 * @param {string | Uint8Array} data
	 * @param {boolean} exclusive refuse a path that already exists
	 * @returns {Promise<void>}
	 */
	const writeWorkingFile = async (path, data, exclusive) => {
		const filepath = normalizePath(path);
		if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
			throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'File content must be text or bytes.');
		}
		await assertCloned();
		const parent = filepath.split('/').slice(0, -1).join('/');
		if (parent) await mkdirp(abs(parent));
		const existing = await lstatOrNull(abs(filepath));
		if (existing?.isDirectory()) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${filepath} is a folder.`);
		if (existing && exclusive) throw new GitEngineError(ErrorCode.PATH_EXISTS, `${filepath} already exists.`);
		// isomorphic-git decides a file is unchanged from its size, whole-second
		// mtime and inode, so a same-size edit in the second of the last index
		// write would look clean, and a pull could then run over it. Swapping
		// in a file created while the old one exists always changes the inode.
		const temp = `${gitdir}/${WRITE_TEMP_FILE}`;
		const backup = `${gitdir}/${WRITE_BACKUP_FILE}`;
		if (await lstatOrNull(backup)) await fs.promises.unlink(backup);
		await fs.promises.writeFile(temp, data, {
			...(typeof data === 'string' ? { encoding: 'utf8' } : {}),
			...(existing ? { mode: existing.mode } : {})
		});
		// LightningFS deletes an unlinked file's data at once but saves its
		// directory later. The old file is deleted only once the directory
		// on disk points at the new one, so a closed tab always keeps one.
		if (existing) await fs.promises.rename(abs(filepath), backup);
		try {
			await fs.promises.rename(temp, abs(filepath));
		} catch (error) {
			if (existing) await fs.promises.rename(backup, abs(filepath));
			throw error;
		}
		await flush();
		if (existing) {
			await fs.promises.unlink(backup);
			await flush();
		}
	};

	/**
	 * Never throws, because a copy too damaged to read must still be deletable.
	 * A copy that cannot be read reports nulls rather than zero, so a warning
	 * never understates what is at risk.
	 * @returns {Promise<WorkCounts>}
	 */
	const countWorkUnlocked = async () => {
		try {
			await recoverInterruptedPull();
			if (!(await isCloned())) return { unpushed: 0, drafts: 0 };
			const { ahead } = await aheadBehindUnlocked();
			const { files } = await statusUnlocked();
			return { unpushed: ahead, drafts: files.length };
		} catch {
			return { unpushed: null, drafts: null };
		}
	};

	/**
	 * @param {string} url
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<boolean>} true only when the remote answers with no branches; a failed check counts as false
	 */
	const remoteHasNoBranches = async (url, signal) => {
		try {
			// Version 1 reads the plain ref advertisement, the request a clone starts with.
			const heads = await git.listServerRefs({ http: withSignal(http, signal), url, prefix: 'refs/heads/', protocolVersion: 1, ...authCallbacks(getCredential) });
			return heads.length === 0;
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof GitEngineError && error.code === ErrorCode.AUTH_REQUIRED) throw error;
			return false;
		}
	};

	return {
		id,
		dir,

		/** @returns {Promise<boolean>} whether a clone is on this device */
		isCloned: () => locked(isCloned),

		/** @returns {Promise<WorkCounts>} what deleting this copy would lose now */
		countWork: () => withLock(id, countWorkUnlocked),

		/**
		 * Deletes everything stored for this repository on this device, including
		 * unpushed commits, but only if it still holds what the user agreed to lose.
		 * The check and the deletion share one hold of the lock, so nothing written
		 * in any tab can fall between them.
		 *
		 * Deletes file by file rather than with LightningFS's `wipe`: that clears the
		 * store under a tab still holding the old file tree in memory, which goes on
		 * seeing deleted files. Ordinary deletes reach other tabs like any other write.
		 * @param {WorkCounts} expected
		 * @returns {Promise<boolean>} false when the counts differ and nothing was deleted
		 */
		wipeIfUnchanged: (expected) =>
			withLock(id, async () => {
				const { unpushed, drafts } = await countWorkUnlocked();
				if (unpushed !== expected.unpushed || drafts !== expected.drafts) return false;
				await removeRecursive(dir);
				await flush();
				return true;
			}),

		/**
		 * Shallow-clones one branch: `ref`, or the remote's default branch without
		 * it. On failure or cancel nothing is left behind, and what an interrupted
		 * clone left is cleared first, so the clone can simply be retried.
		 * @param {{ url: string, ref?: string, onProgress?: ProgressCallback, signal?: AbortSignal }} options
		 * @returns {Promise<{ branch: string, oid: string, persisted: boolean | null }>}
		 */
		clone: ({ url, ref, onProgress, signal }) =>
			locked(async () => {
				assertCloneUrl(url);
				if (ref !== undefined) assertBranchName(ref);
				if (await isCloned()) {
					throw new GitEngineError(ErrorCode.ALREADY_CLONED, 'This repository is already cloned on this device.');
				}
				signal?.throwIfAborted();
				// A wipe or a failed clone may have left parsed objects behind.
				for (const key of Reflect.ownKeys(cache)) Reflect.deleteProperty(cache, key);
				/** @type {{ branch: string, oid: string }} */
				let cloned;
				try {
					await removeRecursive(dir);
					await mkdirp(dir);
					await git.clone({
						...base,
						http: withSignal(http, signal),
						url,
						// Fully qualified, because a tag of the same name would win otherwise.
						...(ref === undefined ? {} : { ref: `refs/heads/${ref}` }),
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
					// The config is overwritten at once, so it may call this a clone only
					// once everything the clone wrote is saved.
					await flush();
					await git.setConfig({ fs, gitdir, path: 'gitnote.defaultBranch', value: branch });
					const oid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
					await flush();
					cloned = { branch, oid };
				} catch (error) {
					await removeRecursive(dir);
					await flush();
					// A missing branch and an empty remote fail alike when a branch was
					// asked for, so only the remote's own list can tell them apart.
					if (ref !== undefined && /** @type {{ code?: string }} */ (error ?? {}).code === 'NotFoundError' && !(await remoteHasNoBranches(url, signal))) {
						throw new GitEngineError(ErrorCode.BRANCH_NOT_FOUND, `The branch ${ref} is not on the remote. Pick another branch.`, { cause: error });
					}
					// With no refs on the remote, clone cannot find a branch to check out.
					if (isMissingBranch(error)) {
						throw new GitEngineError(ErrorCode.EMPTY_REPO, 'This repository has no commits yet. Add a first commit on the git host, then clone it.', {
							cause: error
						});
					}
					throw error;
				}
				// Optional: a refusal must never cost a complete clone.
				const persisted = await Promise.resolve(storage?.persist?.() ?? null).catch(() => null);
				return { ...cloned, persisted };
			}, signal),

		/** @returns {Promise<TreeEntry[]>} every file and symbolic link in the working tree, sorted by path */
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
						else if (stat.isSymbolicLink()) entries.push({ path, size: stat.size, symlink: true });
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
				await assertCloned();
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
				await assertCloned();
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
		writeFile: (path, data) => locked(() => writeWorkingFile(path, data, false)),

		/**
		 * Writes a new working-tree file, creating its folders. Nothing is staged.
		 * @param {string} path
		 * @param {string | Uint8Array} data
		 * @returns {Promise<void>}
		 * @throws {GitEngineError} `PATH_EXISTS` when anything is already there
		 */
		createFile: (path, data) => locked(() => writeWorkingFile(path, data, true)),

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
				await pruneEmptyParents(source);
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
				await pruneEmptyParents(filepath);
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
				return checkPathsForCommit(normalizePaths(paths));
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
				const findings = await checkPathsForCommit(toCommit);
				assertNotBlocked(findings);
				await unstageOthers(toCommit);

				try {
					await saveBlobs(toCommit);
					for (const filepath of toCommit) {
						if (await lstatOrNull(abs(filepath))) await git.add({ ...base, filepath });
						else await git.remove({ ...base, filepath });
					}
					const oid = await commitAndMoveBranch({ message, author });
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
		 * The fetch runs outside the repository's lock, so saving a draft never
		 * waits for the network; a draft saved meanwhile makes the merge refuse,
		 * with the fetched commits kept for the next pull.
		 *
		 * A conflict is a result, not an error: the working tree gets the
		 * markers (one side's bytes for binary files and files one side
		 * deleted), the index the merge's result with unmerged entries for those
		 * paths, and the merge state is stored so a reload can resume it. The
		 * branch ref does not move until `completeMerge`.
		 * @param {{ author: Author, onProgress?: ProgressCallback, signal?: AbortSignal }} options
		 * @returns {Promise<PullResult>}
		 */
		pull: ({ author, onProgress, signal }) =>
			(async () => {
				const branch = await locked(async () => {
					assertAuthor(author);
					await assertCloned();
					await assertNoMerge();
					await assertCleanTree();
					return currentBranch();
				}, signal);

				await fetchBranch({ branch, onProgress, signal });

				return locked(async () => {
					signal?.throwIfAborted();
					await assertCloned();
					await assertNoMerge();
					await assertCleanTree();
					const remoteRef = `refs/remotes/${REMOTE}/${branch}`;
					const oursOid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
					const theirsOid = await git.resolveRef({ fs, gitdir, ref: remoteRef });
					if (oursOid === theirsOid) return { status: 'up_to_date', oid: oursOid };
					if ((await commitsUntil(theirsOid, await ancestorsOf(oursOid))).length === 0) return { status: 'up_to_date', oid: oursOid };
					await assertNoUntrackedCollisions(theirsOid);
					return applyPull({ branch, oursOid, theirsOid, remoteRef, author: { name: author.name, email: author.email } });
				}, signal);
			})(),

		/**
		 * Refreshes what `aheadBehind` knows about the remote and changes nothing
		 * else, so the counts stay true while local changes hold a pull back.
		 * @param {{ signal?: AbortSignal }} [options]
		 * @returns {Promise<void>}
		 */
		fetchRemote: ({ signal } = {}) =>
			(async () => {
				const branch = await locked(async () => {
					await assertCloned();
					return currentBranch();
				}, signal);
				await fetchBranch({ branch, signal });
			})(),

		/**
		 * Picks one side's version of a conflicted file for the working tree: the
		 * ours/theirs choice for binary files and for a file one side deleted.
		 * A side that deleted the file removes it. `completeMerge` stages it.
		 * @param {{ path: string, side: 'ours' | 'theirs' }} options
		 * @returns {Promise<void>}
		 */
		resolveConflict: ({ path, side }) =>
			locked(async () => {
				const filepath = normalizePath(path);
				if (side !== 'ours' && side !== 'theirs') throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'Pick ours or theirs.');
				await assertCloned();
				const merge = await requireOpenMerge();
				if (!merge.conflictedPaths.includes(filepath)) {
					throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, `${filepath} has no conflict.`);
				}
				const blob = await readBlobOrNull(side === 'ours' ? merge.oursOid : merge.theirsOid, filepath);
				if (blob) {
					const parent = filepath.split('/').slice(0, -1).join('/');
					if (parent) await mkdirp(abs(parent));
					await fs.promises.writeFile(abs(filepath), blob);
				} else {
					await removeFromTree(filepath);
				}
				await flush();
				if (!merge.resolvedPaths.includes(filepath)) {
					await writeMergeState(fs, gitdir, { ...merge, resolvedPaths: [...merge.resolvedPaths, filepath] });
					await flush();
				}
			}),

		/**
		 * Makes the merge commit: both parents, with the merge's clean half and
		 * the working-tree version of each conflicted path (a missing file means
		 * it stays deleted). Other edits stay uncommitted. Refuses while a
		 * conflicted file still has markers, unless `allowMarkers` says they are
		 * the file's real content, and while a binary file or a file one side
		 * deleted is undecided: neither `resolveConflict` nor an edit has settled
		 * it, and committing would silently drop the other side.
		 * @param {{ author: Author, message?: string, allowMarkers?: boolean }} options
		 * @returns {Promise<{ oid: string, parents: [string, string], warnings: SizeFinding[] }>}
		 */
		completeMerge: ({ author, message, allowMarkers = false }) =>
			locked(async () => {
				assertAuthor(author);
				if (message !== undefined) assertMessage(message);
				await assertCloned();
				const merge = await requireOpenMerge();

				const withMarkers = allowMarkers ? [] : await conflictsWithMarkers(merge);
				const undecided = await undecidedConflicts(merge);
				if (withMarkers.length > 0 || undecided.length > 0) {
					const sentences = [
						...(withMarkers.length > 0 ? [`Conflict markers are still in ${withMarkers.join(', ')}.`] : []),
						...(undecided.length > 0 ? [`Choose which side to keep for ${undecided.join(', ')}.`] : [])
					];
					throw new GitEngineError(ErrorCode.CONFLICTS_UNRESOLVED, sentences.join(' '), { detail: { paths: [...withMarkers, ...undecided].sort() } });
				}
				const findings = await checkPathsForCommit(merge.conflictedPaths);
				assertNotBlocked(findings);

				await saveBlobs(merge.conflictedPaths);
				for (const filepath of merge.conflictedPaths) {
					if (await lstatOrNull(abs(filepath))) await git.add({ ...base, filepath, force: true });
					else await git.remove({ ...base, filepath });
				}
				const oid = await commitAndMoveBranch({
					message: message ?? `Merge remote-tracking branch '${REMOTE}/${merge.branch}'`,
					author,
					parent: [merge.oursOid, merge.theirsOid]
				});
				await clearMergeState(fs, gitdir);
				await flush();
				return { oid, parents: [merge.oursOid, merge.theirsOid], warnings: findings };
			}),

		/**
		 * Abandons the open merge: the paths the merge touched go back to our
		 * commit, including any resolution in progress. The fetched commits stay,
		 * so the next pull starts the same merge again. An edit `status` lists
		 * outside the conflicted paths stays in the working tree as a draft against
		 * our commit, whichever file it is on, and the record carries the list, so
		 * a tab that dies during the abort keeps them too.
		 * @returns {Promise<{ oid: string }>} the branch's commit
		 */
		abortMerge: () =>
			locked(async () => {
				await assertCloned();
				const merge = await requireOpenMerge();
				const conflicted = new Set(merge.conflictedPaths);
				const keptDrafts = (await statusUnlocked()).files.map((file) => file.path).filter((path) => !conflicted.has(path));
				const aborting = { ...merge, phase: /** @type {const} */ ('applying'), keptDrafts };
				await writeMergeState(fs, gitdir, aborting);
				await flush();
				await rollBackPull(aborting);
				return { oid: merge.oursOid };
			}),

		/**
		 * Where each conflict of the open merge stands: the same checks that make
		 * `completeMerge` refuse.
		 * @returns {Promise<import('./merge.js').ConflictProgress[]>} empty when no merge is open
		 */
		describeConflicts: () =>
			locked(async () => {
				await assertCloned();
				const merge = await readMergeState(fs, gitdir);
				if (!merge) return [];
				const withMarkers = new Set(await conflictsWithMarkers(merge));
				const undecided = new Set(await undecidedConflicts(merge));
				return merge.conflicts.map((conflict) => ({ ...conflict, hasMarkers: withMarkers.has(conflict.path), undecided: undecided.has(conflict.path) }));
			}),

		/**
		 * The way out when the merge record cannot be read, which otherwise makes
		 * every operation fail. Which commit was being merged is lost, but the
		 * branch has not moved: the index goes back to it and the files stay as they
		 * are, so whatever the merge left in them shows as changes to commit or
		 * discard.
		 * @returns {Promise<boolean>} false when the record was readable and nothing changed
		 */
		resetDamagedMerge: () =>
			withLock(id, async () => {
				try {
					await readMergeState(fs, gitdir);
					return false;
				} catch (error) {
					if (!(error instanceof GitEngineError && error.code === ErrorCode.MERGE_STATE_DAMAGED)) throw error;
				}
				await clearMergeState(fs, gitdir);
				await flush();
				await unstageOthers([]);
				await flush();
				return true;
			}),

		/**
		 * The file as the branch's commit has it, for showing what changed.
		 * @param {string} path
		 * @returns {Promise<Uint8Array | null>} null when the commit does not have it
		 */
		readCommitted: (path) =>
			locked(async () => {
				const filepath = normalizePath(path);
				await assertCloned();
				return readBlobOrNull(await git.resolveRef({ fs, gitdir, ref: 'HEAD' }), filepath);
			}),

		/**
		 * Throws away uncommitted changes: each path goes back to the branch's
		 * commit, and a file the commit does not have is deleted. Editor drafts are
		 * not files and stay. Refuses while a merge is open; `abortMerge` is the way
		 * out of that.
		 * @param {string[]} paths
		 * @returns {Promise<string[]>} the paths that had changes
		 */
		discardChanges: (paths) =>
			locked(async () => {
				const selected = normalizePaths(paths);
				await assertCloned();
				await assertNoMerge();
				const changed = new Set((await statusUnlocked()).files.map((file) => file.path));
				const toDiscard = selected.filter((path) => changed.has(path));
				const headOid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
				/** @type {Map<string, TreeBlob>} */
				const committed = new Map();
				for (const path of toDiscard) {
					const blob = await treeBlobAt(headOid, path);
					if (blob) committed.set(path, blob);
				}
				// Removals first: a new file can sit where a committed folder belongs.
				for (const path of toDiscard) {
					if (!committed.has(path)) await removeFromTree(path);
				}
				for (const [path, blob] of committed) await writeTreeBlob(path, blob);
				await flush();
				for (const filepath of toDiscard) await git.resetIndex({ ...base, ref: headOid, filepath });
				await flush();
				return toDiscard;
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
				const { headOid, remoteCommits } = await aheadBehindUnlocked();
				return estimatePushBytesFrom(headOid, remoteCommits);
			}),

		/**
		 * Takes back the commits the remote does not have: the branch and index
		 * return to the remote-tracking commit and the working tree stays, so
		 * their changes become drafts to commit again in smaller groups. This is
		 * the way out of a push over the size limit. It refuses while the remote
		 * has commits we lack, because those would then look like local deletions.
		 * @returns {Promise<{ oid: string, undone: number }>} the branch's commit and how many went
		 */
		undoUnpushedCommits: () =>
			locked(async () => {
				await assertCloned();
				await assertNoMerge();
				const { branch, headOid, remoteOid, ahead, behind } = await aheadBehindUnlocked();
				if (remoteOid === null || ahead === 0) return { oid: headOid, undone: 0 };
				if (behind > 0) {
					throw new GitEngineError(ErrorCode.NON_FAST_FORWARD, 'The remote branch has commits you do not have. Pull first, then undo.');
				}
				const changes = await changedBlobs(headOid, remoteOid);
				await git.writeRef({ fs, gitdir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
				for (const { path } of changes) await git.resetIndex({ ...base, ref: remoteOid, filepath: path });
				await flush();
				return { oid: remoteOid, undone: ahead };
			}),

		/**
		 * Pushes the commit the branch is on when this runs. Refuses before any
		 * network call when a merge is open, when the remote has commits we lack,
		 * or when the estimated pack is over the limit. The send holds only the
		 * network lock, so saves go on during a stalled push; a commit made
		 * meanwhile waits for the next push.
		 * @param {{ onProgress?: ProgressCallback, signal?: AbortSignal }} [options]
		 * @returns {Promise<{ pushed: boolean, oid: string, bytes: number }>}
		 */
		push: ({ onProgress, signal } = {}) =>
			withLock(
				networkLock,
				async () => {
					const { branch, headOid, send, bytes } = await locked(async () => {
						await assertCloned();
						await assertNoMerge();
						const state = await aheadBehindUnlocked();
						if (state.remoteOid !== null && state.ahead === 0) return { branch: state.branch, headOid: state.headOid, send: false, bytes: 0 };
						if (state.behind > 0) {
							throw new GitEngineError(ErrorCode.NON_FAST_FORWARD, 'The remote branch has commits you do not have. Pull first, then push.');
						}
						const estimate = await estimatePushBytesFrom(state.headOid, state.remoteCommits);
						const tooLarge = checkPushSize(provider, estimate);
						if (tooLarge) throw new GitEngineError(ErrorCode.PUSH_TOO_LARGE, tooLarge.message, { detail: { finding: tooLarge } });
						return { branch: state.branch, headOid: state.headOid, send: true, bytes: estimate };
					}, signal);
					if (!send) return { pushed: false, oid: headOid, bytes: 0 };

					/** @type {string[]} */
					const remoteMessages = [];
					try {
						await git.push({
							...base,
							http: withSignal(http, signal),
							remote: REMOTE,
							// The commit that was checked, even if the branch has moved since.
							ref: headOid,
							remoteRef: `refs/heads/${branch}`,
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
						if (signal?.aborted && !(error instanceof GitEngineError)) throw error;
						throw toGitEngineError(error, { remoteMessages });
					}
					await locked(flush, signal);
					return { pushed: true, oid: headOid, bytes };
				},
				signal
			)
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
 * @param {unknown} ref
 * @returns {void}
 */
function assertBranchName(ref) {
	if (typeof ref !== 'string' || ref === '' || ref === '@' || BAD_BRANCH_NAME.test(ref)) {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'That is not a valid branch name.');
	}
}

/**
 * @param {unknown} url
 * @returns {void}
 */
function assertCloneUrl(url) {
	/** @type {URL} */
	let parsed;
	try {
		parsed = new URL(/** @type {string} */ (url));
	} catch {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'That is not a valid repository URL.');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'Repository URLs must use https.');
	}
	assertNoCredentials(parsed);
}

/**
 * @param {import('isomorphic-git').WalkerEntry | null | undefined} entry
 * @returns {Promise<TreeBlob | null>} null unless the entry is a blob
 */
async function treeBlob(entry) {
	if (!entry || (await entry.type()) !== 'blob') return null;
	return { oid: /** @type {string} */ (await entry.oid()), mode: /** @type {number} */ (await entry.mode()) };
}

/**
 * @param {TreeBlob | null} a
 * @param {TreeBlob | null} b
 * @returns {boolean}
 */
function sameBlob(a, b) {
	return a?.oid === b?.oid && a?.mode === b?.mode;
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
 * @throws {GitEngineError} `INVALID_ARGUMENT` when git could not record this author
 */
export function assertAuthor(author) {
	const value = /** @type {Partial<Author> | null | undefined} */ (author);
	if (typeof value?.name !== 'string' || value.name.trim() === '' || typeof value.email !== 'string' || value.email.trim() === '') {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'Set an author name and email for commits.');
	}
	if (AUTHOR_FORBIDDEN.test(value.name) || AUTHOR_FORBIDDEN.test(value.email)) {
		throw new GitEngineError(ErrorCode.INVALID_ARGUMENT, 'An author name or email cannot contain line breaks, control characters, or angle brackets.');
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
	const code = /** @type {{ code?: string }} */ (error)?.code;
	// ENOTDIR: a parent of the path is a file.
	return code === 'ENOENT' || code === 'ENOTDIR';
}
