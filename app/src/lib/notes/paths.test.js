import { describe, expect, it } from 'vitest';
import { imagePathFor, imageTypeFor, isMarkdownPath, notePathFrom, relativeUrlFrom, resolveNoteUrl } from './paths.js';

describe('file kinds', () => {
	it('knows markdown and allowed images by extension, ignoring case', () => {
		expect(isMarkdownPath('a/B.MD')).toBe(true);
		expect(isMarkdownPath('a.md.txt')).toBe(false);
		expect(isMarkdownPath('.md')).toBe(false);
		expect(imageTypeFor('a/b.JPG')).toBe('image/jpeg');
		expect(imageTypeFor('a.svg')).toBe('image/svg+xml');
		for (const path of ['a.html', 'a.htm', 'a.xml', 'a.js', 'png', 'constructor']) expect(imageTypeFor(path)).toBeNull();
	});
});

describe('the path of a new note', () => {
	it.each([
		['idea', 'idea.md'],
		['  ideas/first idea ', 'ideas/first idea.md'],
		['meeting 11.01', 'meeting 11.01.md'],
		['v1.2/release.notes', 'v1.2/release.notes.md'],
		['a.md', 'a.md'],
		['A.MARKDOWN', 'A.MARKDOWN'],
		['todo.txt', 'todo.txt'],
		['pic.png', 'pic.png'],
		['.gitignore', '.gitignore']
	])('turns %j into %j', (typed, path) => {
		expect(notePathFrom(typed)).toBe(path);
		if (path.endsWith('.md')) expect(isMarkdownPath(path)).toBe(true);
	});

	it.each(['', '   ', 'foo/', 'a/b/ '])('finds no file in %j', (typed) => {
		expect(notePathFrom(typed)).toBeNull();
	});
});

describe('URLs in a note', () => {
	it('tells apart what they point at', () => {
		expect(resolveNoteUrl('n/a.md', '#x')).toEqual({ kind: 'fragment' });
		expect(resolveNoteUrl('n/a.md', 'https://x.io/a.md')).toEqual({ kind: 'external' });
		expect(resolveNoteUrl('n/a.md', 'mailto:a@x.io')).toEqual({ kind: 'external' });
		expect(resolveNoteUrl('n/a.md', '//x.io/a.md')).toEqual({ kind: 'external' });
		expect(resolveNoteUrl('n/a.md', 'b.md?plain=1#t')).toEqual({ kind: 'repo', path: 'n/b.md', suffix: '#t' });
		expect(resolveNoteUrl('n/a.md', '/b.md')).toEqual({ kind: 'repo', path: 'b.md', suffix: '' });
		expect(resolveNoteUrl('a.md', './x/./y/../b.md')).toEqual({ kind: 'repo', path: 'x/b.md', suffix: '' });
	});

	it('refuses paths that would leave the tree or reach git', () => {
		for (const url of ['../../b.md', '.git/config', 'x/.GIT/config', '%2e%2e/%2e%2e/b.md', 'a\\b.md', '%zz', '..']) {
			expect(resolveNoteUrl('n/a.md', url)).toEqual({ kind: 'invalid' });
		}
	});
});

describe('where an image goes', () => {
	const now = new Date('2026-11-01T14:30:05Z');
	const place = (/** @type {string} */ fileName, /** @type {string} */ mimeType, /** @type {string[]} */ taken = [], notePath = 'notes/a.md') =>
		imagePathFor({ notePath, fileName, mimeType, taken: new Set(taken), now });

	it('lands in assets next to the note', () => {
		expect(place('cat.png', 'image/png')).toBe('notes/assets/cat.png');
		expect(place('cat.png', 'image/png', [], 'a.md')).toBe('assets/cat.png');
	});

	it('names a pasted image by time, since browsers name them all alike', () => {
		expect(place('image.png', 'image/png')).toBe('notes/assets/pasted-20261101143005.png');
		expect(place('', 'image/webp')).toBe('notes/assets/pasted-20261101143005.webp');
	});

	it('never takes a name in use', () => {
		expect(place('cat.png', 'image/png', ['notes/assets/cat.png', 'notes/assets/cat-2.png'])).toBe('notes/assets/cat-3.png');
	});

	it('cleans the name and keeps letters of any language', () => {
		expect(place('../My cat (1).PNG', 'image/png')).toBe('notes/assets/My-cat-1.png');
		expect(place('ảnh mèo.jpg', 'image/jpeg')).toBe('notes/assets/ảnh-mèo.jpg');
	});

	it('takes the extension from the type when the name has none', () => {
		expect(place('cat', 'image/gif')).toBe('notes/assets/cat.gif');
	});

	it('refuses anything but an allowed image', () => {
		expect(place('page.html', 'text/html')).toBeNull();
		expect(place('page.html', 'image/png')).toBe('notes/assets/page.png');
		expect(place('x', 'image/bmp')).toBeNull();
	});

	it('writes a link relative to the note, encoded', () => {
		expect(relativeUrlFrom('notes/a.md', 'notes/assets/my cat.png')).toBe('./assets/my%20cat.png');
		expect(relativeUrlFrom('a.md', 'assets/cat.png')).toBe('./assets/cat.png');
	});
});
