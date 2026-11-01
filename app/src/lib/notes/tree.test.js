import { describe, expect, it } from 'vitest';
import { buildTree, foldersAbove } from './tree.js';

const files = (/** @type {string[]} */ ...paths) => paths.map((path) => ({ path, size: 1 }));

/**
 * @param {import('./tree.js').TreeNode[]} nodes
 * @returns {unknown[]}
 */
const shape = (nodes) => nodes.map((node) => (node.type === 'folder' ? { [node.name]: shape(node.children) } : node.name));

describe('the file tree', () => {
	it('puts folders first, then markdown, then the rest', () => {
		const tree = buildTree(files('z.md', 'a.txt', 'docs/b.png', 'docs/c.md', 'm/n/o.md', 'b.md'));
		expect(shape(tree)).toEqual([{ docs: ['c.md', 'b.png'] }, { m: [{ n: ['o.md'] }] }, 'b.md', 'z.md', 'a.txt']);
	});

	it('never shows git folders', () => {
		expect(shape(buildTree(files('.git/config', 'x/.GIT/y', 'a.md', '.github/ci.yml')))).toEqual([{ '.github': ['ci.yml'] }, 'a.md']);
	});

	it('filters by path, ignoring case, and keeps the folders above a match', () => {
		const tree = buildTree(files('Notes/Today.md', 'Notes/old.md', 'x.md'), [], ' tODAY ');
		expect(shape(tree)).toEqual([{ Notes: ['Today.md'] }]);
		expect(shape(buildTree(files('Notes/a.md', 'x.md'), [], 'notes'))).toEqual([{ Notes: ['a.md'] }]);
	});

	it('marks unsaved drafts and the folders holding them', () => {
		const [folder, file] = buildTree(files('d/a.md', 'b.md'), ['d/a.md']);
		expect(folder).toMatchObject({ type: 'folder', unsaved: true });
		expect(file).toMatchObject({ path: 'b.md', unsaved: false });
	});

	it('shows a draft whose file is gone', () => {
		expect(buildTree([], ['gone.md'])).toEqual([{ type: 'file', name: 'gone.md', path: 'gone.md', size: 0, unsaved: true }]);
	});

	it('lists the folders to open for a path', () => {
		expect(foldersAbove('a/b/c.md')).toEqual(['a', 'a/b']);
		expect(foldersAbove('c.md')).toEqual([]);
	});
});
