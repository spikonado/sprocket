import { resolveLocalApiBaseUrl } from '$lib/local/client';

export type MarkdownImageScope = { workspacePath: string; documentPath?: string };

export function markdownImageUrl(source: string, scope?: MarkdownImageScope) {
	if (/^(?:https?:|data:image\/|blob:|\/\/)/i.test(source)) return source;

	if (!scope || !source) return null;

	if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) return null;

	let path: string;

	try {
		path = decodeURIComponent(source.split(/[?#]/, 1)[0]);
	} catch {
		return null;
	}

	const absolute = /^(?:[\\/]|[a-z]:[\\/])/i.test(path);
	const documentPath = scope.documentPath?.replaceAll('\\', '/');
	const directory = documentPath?.slice(0, documentPath.lastIndexOf('/') + 1) ?? '';

	const query = new URLSearchParams({
		workspacePath: scope.workspacePath,
		path: absolute ? path : directory + path
	});

	const baseUrl = resolveLocalApiBaseUrl();
	const pathUrl = `/api/workspace/image?${query}`;

	return baseUrl && baseUrl !== globalThis.window?.location.origin
		? `${baseUrl}${pathUrl}`
		: pathUrl;
}

export function prepareMarkdownImages(html: string, scope?: MarkdownImageScope) {
	const template = document.createElement('template');
	template.innerHTML = html;

	for (const image of template.content.querySelectorAll('img')) {
		const source = image.getAttribute('src') ?? '';
		const url = markdownImageUrl(source, scope);
		image.setAttribute('loading', 'lazy');
		image.setAttribute('decoding', 'async');
		image.setAttribute('referrerpolicy', 'no-referrer');
		image.removeAttribute('srcset');

		if (url) image.src = url;
		else {
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
