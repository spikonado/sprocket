import { resolveLocalApiBaseUrl } from '$lib/local/client';
import { isAbsoluteImagePath, isWindowsImagePath } from './markdown-image-path';

export type MarkdownImageScope = {
	workspacePath?: string;
	documentPath?: string;
};

export function decodeImagePath(source: string) {
	const path = source.split(/[?#]/, 1)[0];

	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

export function markdownImageUrl(source: string, scope?: MarkdownImageScope, render?: string) {
	if (/^(?:https?:|data:image\/|blob:|\/\/)/i.test(source)) return source;

	if (!source) return null;

	if (/^[a-z][a-z\d+.-]*:/i.test(source) && !isWindowsImagePath(source)) return null;

	const path = decodeImagePath(source);
	const documentPath = scope?.documentPath?.replaceAll('\\', '/');
	const directory = documentPath?.slice(0, documentPath.lastIndexOf('/') + 1) ?? '';
	const resolvedPath = isAbsoluteImagePath(path) ? path : directory + path;

	if (!isAbsoluteImagePath(resolvedPath) && !scope?.workspacePath) return null;

	const query = new URLSearchParams();

	if (scope?.workspacePath) {
		query.set('workspacePath', scope.workspacePath);
	}

	query.set('path', resolvedPath);

	if (render) query.set('render', render);

	const baseUrl = resolveLocalApiBaseUrl();
	const pathUrl = `/api/workspace/image?${query}`;

	return baseUrl && baseUrl !== globalThis.window?.location.origin
		? `${baseUrl}${pathUrl}`
		: pathUrl;
}

let renderCount = 0;

/** Browsers reuse decoded images by URL, so each message render needs its own URL to show the file as it is now. */
export function nextImageRender() {
	return String(++renderCount);
}

export function prepareMarkdownImages(html: string, scope: MarkdownImageScope, render: string) {
	const template = document.createElement('template');
	template.innerHTML = html;

	for (const image of template.content.querySelectorAll('img')) {
		const source = image.getAttribute('src') ?? '';
		const url = markdownImageUrl(source, scope, render);
		image.setAttribute('loading', 'lazy');
		image.setAttribute('decoding', 'async');
		image.setAttribute('referrerpolicy', 'no-referrer');
		image.removeAttribute('srcset');

		if (url) {
			image.src = url;
		} else {
			image.removeAttribute('src');
			image.alt = `${image.alt || 'Image'} (unavailable)`;
		}

		if (url && url.startsWith(`${resolveLocalApiBaseUrl()}/api/workspace/image?`)) {
			image.crossOrigin = 'use-credentials';
		}

		if (!image.closest('a') && url) {
			image.tabIndex = 0;
			image.setAttribute('role', 'button');
			image.setAttribute('aria-label', `View ${image.alt || 'image'}`);
		}
	}

	return template.innerHTML;
}
