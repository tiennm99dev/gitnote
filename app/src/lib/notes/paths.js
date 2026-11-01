/**
 * Pure path rules shared by the notes UI: what kind of file a path is, how a
 * URL written in a note maps to a file in the repository, and where a new image
 * goes. Paths are working-tree paths: relative and `/`-separated.
 */

/** Image types the app turns into `blob:` URLs, by extension. Nothing else may run from one. */
const IMAGE_TYPES = Object.freeze({
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml'
});

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

/** Other types a new note may name. Any other dotted ending is part of its name, as in `meeting 11.01`. */
const NOTE_TEXT_EXTENSIONS = new Set(['txt', 'csv', 'json', 'yaml', 'yml', 'toml', 'html', 'xml']);

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * @param {string} path
 * @returns {string} the lowercase extension, or an empty string
 */
function extensionOf(path) {
	const name = baseName(path);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isMarkdownPath(path) {
	return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

/**
 * @param {string} path
 * @returns {string | null} the MIME type when the path may become a `blob:` URL
 */
export function imageTypeFor(path) {
	const extension = extensionOf(path);
	return Object.hasOwn(IMAGE_TYPES, extension) ? IMAGE_TYPES[/** @type {keyof typeof IMAGE_TYPES} */ (extension)] : null;
}

/**
 * @param {string} value what the user typed for a new note
 * @returns {string | null} the path, as a markdown file unless it names a known
 *   type or a dotfile; null when it names no file
 */
export function notePathFrom(value) {
	const path = value.trim();
	const name = baseName(path);
	if (name === '') return null;
	const extension = extensionOf(path);
	const named = MARKDOWN_EXTENSIONS.has(extension) || NOTE_TEXT_EXTENSIONS.has(extension) || imageTypeFor(path) !== null;
	const dotfile = name.startsWith('.') && extension === '';
	return named || dotfile ? path : `${path}.md`;
}

/**
 * @param {string} path
 * @returns {string} the last segment
 */
export function baseName(path) {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * @param {string} path
 * @returns {string} the parent folder, or an empty string at the top
 */
export function dirName(path) {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * @typedef {{ kind: 'fragment' } | { kind: 'external' } | { kind: 'repo', path: string, suffix: string } | { kind: 'invalid' }} NoteUrl
 */

/**
 * Works out what a link or image URL in a note points at. A path starting with
 * `/` counts from the repository root, as it does on the git hosts. Anything
 * that would leave the working tree or reach `.git` is invalid.
 * @param {string} notePath the note holding the URL
 * @param {string} url
 * @returns {NoteUrl}
 */
export function resolveNoteUrl(notePath, url) {
	if (url.startsWith('#')) return { kind: 'fragment' };
	if (url.startsWith('//') || URL_SCHEME.test(url)) return { kind: 'external' };
	const cut = url.search(/[?#]/);
	const rawPath = cut < 0 ? url : url.slice(0, cut);
	const hash = url.indexOf('#');
	let decoded;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		return { kind: 'invalid' };
	}
	if (decoded === '' || decoded.includes('\\') || decoded.includes('\0')) return { kind: 'invalid' };
	const segments = decoded.startsWith('/') ? [] : dirName(notePath).split('/').filter(Boolean);
	for (const segment of decoded.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (segments.length === 0) return { kind: 'invalid' };
			segments.pop();
		} else if (segment.toLowerCase() === '.git') {
			return { kind: 'invalid' };
		} else {
			segments.push(segment);
		}
	}
	if (segments.length === 0) return { kind: 'invalid' };
	return { kind: 'repo', path: segments.join('/'), suffix: hash < 0 ? '' : url.slice(hash) };
}

/**
 * @param {string} path a working-tree path
 * @returns {string} the path as a URL path, each segment encoded
 */
export function encodePath(path) {
	return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Picks where an image goes: `assets/` next to the note, under a name no file in
 * `taken` uses, so that adding an image never overwrites anything.
 * @param {object} options
 * @param {string} options.notePath
 * @param {string} options.fileName the name it came with, possibly empty
 * @param {string} options.mimeType the type it came with, possibly empty
 * @param {ReadonlySet<string>} options.taken paths already in use
 * @param {Date} [options.now]
 * @returns {string | null} the new path, or null when the type is not an allowed image
 */
export function imagePathFor({ notePath, fileName, mimeType, taken, now = new Date() }) {
	const fromType = Object.entries(IMAGE_TYPES).find(([, type]) => type === mimeType)?.[0];
	const fromName = imageTypeFor(fileName) ? extensionOf(fileName) : undefined;
	const extension = fromName ?? fromType;
	if (!extension) return null;
	const stem = fileName.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '');
	// Browsers name every pasted image the same.
	const generic = stem === '' || stem === 'image';
	const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
	const name = generic ? `pasted-${stamp}` : stem;
	const folder = [dirName(notePath), 'assets'].filter(Boolean).join('/');
	let candidate = `${folder}/${name}.${extension}`;
	for (let copy = 2; taken.has(candidate); copy += 1) candidate = `${folder}/${name}-${copy}.${extension}`;
	return candidate;
}

/**
 * @param {string} notePath
 * @param {string} targetPath a path in the same folder as the note, or below it
 * @returns {string} the URL to write in the note
 */
export function relativeUrlFrom(notePath, targetPath) {
	const folder = dirName(notePath);
	return `./${encodePath(folder ? targetPath.slice(folder.length + 1) : targetPath)}`;
}
