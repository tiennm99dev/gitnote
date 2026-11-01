/**
 * Turns a note into safe HTML. The order matters: markdown-it renders with raw
 * HTML on, DOMPurify cleans the result, and only then are images and links
 * rewritten, because DOMPurify's allow-list rejects `blob:` and must stay that
 * way. `blob:` URLs come only from {@link createImageUrls}, only for an image
 * type, and only ever land in an `<img>`.
 */

import { tasklist } from '@mdit/plugin-tasklist';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { imageTypeFor, resolveNoteUrl } from '../notes/paths.js';

/**
 * Elements that could post a form, or restyle or cover the app. Raw HTML in a
 * note keeps its structure, not the power to look like part of the app. Media
 * would only fail against the CSP. `class` is out because the app's own utility
 * classes could otherwise position a note's content over its controls. Inline
 * SVG is out because its links and images would skip the rewriting below; an SVG
 * file still shows through `<img>`.
 */
const SANITIZE_CONFIG = Object.freeze({
	RETURN_DOM_FRAGMENT: /** @type {const} */ (true),
	SANITIZE_NAMED_PROPS: true,
	FORBID_TAGS: ['style', 'form', 'button', 'select', 'option', 'optgroup', 'datalist', 'textarea', 'fieldset', 'legend', 'label', 'video', 'audio', 'source', 'track', 'picture', 'map', 'area', 'dialog', 'svg', 'image', 'feimage', 'use'],
	FORBID_ATTR: ['style', 'class', 'srcset', 'action', 'formaction', 'background', 'popover', 'popovertarget', 'popovertargetaction', 'xlink:href']
});

/**
 * Sanitizing renames every `id`, so a link to one must carry the same prefix.
 * This is DOMPurify's `SANITIZE_NAMED_PROPS` prefix.
 */
const ID_PREFIX = 'user-content-';

/**
 * A closing `---` alone does not make front matter: two horizontal rules look the
 * same. The block must start right away with a `key:` or a comment, or be empty.
 */
const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n(?:(?:[ \t]*#|[^\s#:][^\n:]*:(?=[ \t\r\n]))[^\n]*\n(?:[^\n]*\n)*?)?---[ \t]*(?:\r?\n|$)/;

const markdown = new MarkdownIt({ html: true, linkify: true });
markdown.use(tasklist, { disabled: true, label: false });
// Column alignment arrives as a style attribute, which sanitizing removes.
markdown.core.ruler.push('table_align_attribute', (state) => {
	for (const token of state.tokens) {
		if (token.type !== 'th_open' && token.type !== 'td_open') continue;
		const align = /text-align:(\w+)/.exec(String(token.attrGet('style') ?? ''))?.[1];
		token.attrs = align ? [['align', align]] : null;
	}
});

// Links to a heading need a target. Sanitizing adds the prefix to these ids.
markdown.core.ruler.push('heading_ids', (state) => {
	/**
	 * Every id handed out, with how many times it was asked for.
	 * @type {Map<string, number>}
	 */
	const used = new Map();
	state.tokens.forEach((token, index) => {
		if (token.type !== 'heading_open') return;
		const words = (state.tokens[index + 1].children ?? []).filter((child) => child.type === 'text' || child.type === 'code_inline').map((child) => child.content);
		const slug = slugify(words.join(''));
		if (slug === '') return;
		let id = slug;
		for (let copy = used.get(slug) ?? 0; used.has(id); copy += 1) {
			id = `${slug}-${copy + 1}`;
			used.set(slug, copy + 1);
		}
		used.set(id, 0);
		token.attrSet('id', id);
	});
});

/**
 * @param {string} text a heading's text
 * @returns {string} lowercase, without punctuation, each space a hyphen, as git hosts make heading links
 */
function slugify(text) {
	return text
		.trim()
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');
}

/**
 * @param {string} suffix a URL's query and fragment, if any
 * @returns {string} the same, with the fragment naming a sanitized id
 */
const prefixFragment = (suffix) => suffix.replace(/#(?=.)/, `#${ID_PREFIX}`);

/**
 * Lazily made `blob:` URLs for the images one open note shows. Each image is
 * read once, however often the note re-renders while being typed in.
 * @typedef {object} ImageUrls
 * @property {(path: string) => Promise<string | null>} urlFor null for a path that is not an allowed image, or that cannot be read
 * @property {() => void} dispose revokes every URL made so far, and any still on its way
 */

/**
 * @param {object} options
 * @param {(path: string) => Promise<Uint8Array>} options.readFile
 * @param {(blob: Blob) => string} [options.createUrl]
 * @param {(url: string) => void} [options.revokeUrl]
 * @returns {ImageUrls}
 */
export function createImageUrls({ readFile, createUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url) }) {
	/** @type {Map<string, Promise<string | null>>} */
	const made = new Map();
	let disposed = false;

	/**
	 * @param {string} path
	 * @param {string} type
	 * @returns {Promise<string | null>}
	 */
	const make = async (path, type) => {
		try {
			const bytes = await readFile(path);
			if (disposed) return null;
			return createUrl(new Blob([/** @type {BlobPart} */ (bytes)], { type }));
		} catch {
			// Not cached: the file may exist by the next render.
			made.delete(path);
			return null;
		}
	};

	return {
		urlFor(path) {
			const type = imageTypeFor(path);
			if (!type || disposed) return Promise.resolve(null);
			let url = made.get(path);
			if (!url) {
				url = make(path, type);
				made.set(path, url);
			}
			return url;
		},
		dispose() {
			disposed = true;
			for (const url of made.values()) {
				void url.then((value) => {
					if (value) revokeUrl(value);
				});
			}
			made.clear();
		}
	};
}

/**
 * @param {string} source
 * @returns {string} the source without YAML front matter or a byte order mark
 */
export function stripFrontMatter(source) {
	return source.replace(FRONT_MATTER, '').replace(/^\uFEFF/, '');
}

/**
 * @param {Element} image
 * @param {string} notePath
 * @param {ImageUrls} images
 * @returns {Promise<void>}
 */
async function rewriteImage(image, notePath, images) {
	const source = image.getAttribute('src');
	if (source === null || source.startsWith('data:')) return;
	const target = resolveNoteUrl(notePath, source);
	if (target.kind === 'external') {
		// The CSP blocks images from other hosts, so offer the picture as a link.
		const link = image.ownerDocument.createElement('a');
		link.setAttribute('href', source);
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noopener noreferrer');
		link.textContent = image.getAttribute('alt') || source;
		image.replaceWith(link);
		return;
	}
	const url = target.kind === 'repo' ? await images.urlFor(target.path) : null;
	if (url) {
		image.setAttribute('src', url);
	} else {
		image.removeAttribute('src');
		image.setAttribute('data-missing', 'true');
	}
}

/**
 * @param {Element} link
 * @param {string} notePath
 * @param {(path: string) => string} linkFor the app's URL for a file in this repository
 * @returns {void}
 */
function rewriteLink(link, notePath, linkFor) {
	const href = link.getAttribute('href');
	if (href === null) return;
	const target = resolveNoteUrl(notePath, href);
	if (target.kind === 'repo') {
		link.setAttribute('href', `${linkFor(target.path)}${prefixFragment(target.suffix)}`);
	} else if (target.kind === 'fragment') {
		link.setAttribute('href', prefixFragment(href));
	} else if (target.kind === 'invalid') {
		link.removeAttribute('href');
	} else if (target.kind === 'external') {
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noopener noreferrer');
	}
}

/**
 * @param {string} source the note's markdown
 * @param {object} context
 * @param {string} context.notePath where the note is, which relative URLs start from
 * @param {ImageUrls} context.images
 * @param {(path: string) => string} context.linkFor
 * @returns {Promise<string>} sanitized HTML
 */
export async function renderMarkdown(source, { notePath, images, linkFor }) {
	const clean = DOMPurify.sanitize(markdown.render(stripFrontMatter(source)), SANITIZE_CONFIG);
	const box = clean.ownerDocument.createElement('div');
	box.append(clean);
	for (const input of box.querySelectorAll('input')) {
		// Task list checkboxes stay; they show state and change nothing.
		if (input.getAttribute('type') === 'checkbox') input.setAttribute('disabled', '');
		else input.remove();
	}
	await Promise.all([...box.querySelectorAll('img')].map((image) => rewriteImage(image, notePath, images)));
	for (const link of box.querySelectorAll('a')) rewriteLink(link, notePath, linkFor);
	return box.innerHTML;
}
