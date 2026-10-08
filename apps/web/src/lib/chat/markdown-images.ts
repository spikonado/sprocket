import { resolveLocalApiBaseUrl } from '$lib/local/client';
import {
	isAbsoluteImagePath,
	isWindowsImagePath,
	stripImageFileScheme
} from './markdown-image-path';

export type MarkdownImageScope = {
	workspacePath?: string;
	documentPath?: string;
	transcript?: { userId: string; threadId: string };
};

function decodeImagePath(source: string) {
	const path = source.split(/[?#]/, 1)[0];

	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

export function markdownImageUrl(source: string, scope?: MarkdownImageScope) {
	source = stripImageFileScheme(source);

	if (/^(?:https?:|data:image\/|blob:|\/\/)/i.test(source)) return source;

	if (!source) return null;

	if (/^[a-z][a-z\d+.-]*:/i.test(source) && !isWindowsImagePath(source)) return null;

	const path = decodeImagePath(source);
	const documentPath = scope?.documentPath?.replaceAll('\\', '/');
	const directory = documentPath?.slice(0, documentPath.lastIndexOf('/') + 1) ?? '';
	const resolvedPath = isAbsoluteImagePath(path) ? path : directory + path;
	const toolPath = path.replace(/^(?:\.\/)+/, '');

	const transcript =
		!documentPath && /^(?:parse_file|screenshot_url|scrape_url)\//.test(toolPath)
			? scope?.transcript
			: undefined;

	if (!isAbsoluteImagePath(resolvedPath) && !scope?.workspacePath && !transcript) return null;

	const query = new URLSearchParams();

	if (transcript) {
		query.set('userId', transcript.userId);
		query.set('threadId', transcript.threadId);
	}

	if (scope?.workspacePath) {
		query.set('workspacePath', scope.workspacePath);
	}

	query.set('path', transcript ? toolPath : resolvedPath);

	const baseUrl = resolveLocalApiBaseUrl();
	const pathUrl = `/api/workspace/image?${query}`;

	return baseUrl && baseUrl !== globalThis.window?.location.origin
		? `${baseUrl}${pathUrl}`
		: pathUrl;
}

export function prepareMarkdownImages(html: string, scope?: MarkdownImageScope) {
	const template = document.createElement('template');
	template.innerHTML = html;

	for (const link of template.content.querySelectorAll('a[href]')) {
		const source = link.getAttribute('href') ?? '';

		if (
			/^[a-z][a-z\d+.-]*:/i.test(source) &&
			!/^https?:/i.test(source) &&
			!isWindowsImagePath(source)
		)
			continue;

		if (!/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(decodeImagePath(source))) continue;

		if (link.querySelector('img')) {
			const url = markdownImageUrl(source, scope);

			if (url) link.setAttribute('href', url);

			continue;
		}

		const image = document.createElement('img');
		image.setAttribute('src', source);
		image.alt = link.textContent || 'Image';

		const title = link.getAttribute('title');

		if (title) image.title = title;

		link.replaceWith(image);
	}

	for (const image of template.content.querySelectorAll('img')) {
		const source = image.getAttribute('src') ?? '';
		const url = markdownImageUrl(source, scope);
		image.setAttribute('loading', 'lazy');
		image.setAttribute('decoding', 'async');
		image.setAttribute('referrerpolicy', 'no-referrer');
		image.removeAttribute('srcset');
		image.removeAttribute('data-local-image-url');

		if (url) {
			image.src = url;
			const parsed = new URL(url, window.location.href);

			if (
				parsed.pathname === '/api/workspace/image' &&
				parsed.origin === resolveLocalApiBaseUrl()
			) {
				image.setAttribute('data-local-image-url', url);
			}
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
