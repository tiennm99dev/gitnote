/**
 * Turns the engine's flat file list into the tree the file browser shows.
 */

import { baseName, isMarkdownPath } from './paths.js';

/**
 * @typedef {object} FileNode
 * @property {'file'} type
 * @property {string} name
 * @property {string} path
 * @property {number} size bytes; 0 for a draft whose file is gone
 * @property {boolean} unsaved it has an unsaved draft
 */

/**
 * @typedef {object} FolderNode
 * @property {'folder'} type
 * @property {string} name
 * @property {string} path
 * @property {TreeNode[]} children folders, then markdown, then everything else
 * @property {boolean} unsaved a file inside it has an unsaved draft
 */

/** @typedef {FileNode | FolderNode} TreeNode */

/**
 * @param {TreeNode} node
 * @returns {number}
 */
const rank = (node) => (node.type === 'folder' ? 0 : isMarkdownPath(node.path) ? 1 : 2);

/**
 * @param {TreeNode[]} nodes
 * @returns {void}
 */
function sortNodes(nodes) {
	nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	for (const node of nodes) if (node.type === 'folder') sortNodes(node.children);
}

/**
 * Builds the tree. Git's own folder never shows. A draft whose file is gone
 * still shows, so unsaved text is never out of reach.
 * @param {readonly { path: string, size: number }[]} entries from `listTree`
 * @param {readonly string[]} [draftPaths] paths with an unsaved draft
 * @param {string} [filter] keeps paths containing this, ignoring case
 * @returns {TreeNode[]} the top level
 */
export function buildTree(entries, draftPaths = [], filter = '') {
	const query = filter.trim().toLocaleLowerCase();
	const drafts = new Set(draftPaths);
	const sizes = new Map(entries.map((entry) => [entry.path, entry.size]));
	for (const path of drafts) if (!sizes.has(path)) sizes.set(path, 0);

	/** @type {TreeNode[]} */
	const root = [];
	/** @type {Map<string, FolderNode>} */
	const folders = new Map();
	for (const [path, size] of sizes) {
		const segments = path.split('/');
		if (segments.some((segment) => segment.toLowerCase() === '.git')) continue;
		if (query && !path.toLocaleLowerCase().includes(query)) continue;
		const unsaved = drafts.has(path);
		let siblings = root;
		for (let depth = 1; depth < segments.length; depth += 1) {
			const folderPath = segments.slice(0, depth).join('/');
			let folder = folders.get(folderPath);
			if (!folder) {
				folder = { type: 'folder', name: segments[depth - 1], path: folderPath, children: [], unsaved: false };
				folders.set(folderPath, folder);
				siblings.push(folder);
			}
			folder.unsaved ||= unsaved;
			siblings = folder.children;
		}
		siblings.push({ type: 'file', name: baseName(path), path, size, unsaved });
	}
	sortNodes(root);
	return root;
}

/**
 * @param {string} path
 * @returns {string[]} every folder above the path, top first
 */
export function foldersAbove(path) {
	const segments = path.split('/');
	return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}
