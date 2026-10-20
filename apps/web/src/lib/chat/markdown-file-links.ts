import { createContext } from 'react';
import type { WorkspaceFileTarget } from '$lib/types/sprocket';
import {
	isAbsoluteImagePath,
	isWindowsImagePath,
	stripImageFileScheme
} from './markdown-image-path';
import { decodeImagePath, type MarkdownImageScope } from './markdown-images';

export type MarkdownFileLinks = {
	/** Workspaces the files tab can open, with relative links resolving against the first. */
	roots: readonly string[];
	openFile: (file: WorkspaceFileTarget) => void;
};

export const MarkdownFileLinksContext = createContext<MarkdownFileLinks | null>(null);

function normalizePath(path: string) {
	const slashed = path.replaceAll('\\', '/');

	const prefix = isWindowsImagePath(slashed)
		? slashed.slice(0, 3)
		: slashed.slice(0, slashed.startsWith('/') ? 1 : 0);

	const parts: string[] = [];

	for (const part of slashed.slice(prefix.length).split('/')) {
		if (!part || part === '.') continue;

		if (part !== '..') parts.push(part);
		else if (parts.pop() === undefined) return null;
	}

	return prefix + parts.join('/');
}

function resolvePath(base: string | null | undefined, path: string) {
	if (isAbsoluteImagePath(path)) return normalizePath(path);

	return base ? normalizePath(`${base}/${path}`) : null;
}

export function markdownFileTarget(
	href: string,
	roots: readonly string[],
	scope?: MarkdownImageScope
): WorkspaceFileTarget | null {
	const source = stripImageFileScheme(href);

	if (source.startsWith('//')) return null;

	if (/^[a-z][a-z\d+.-]*:/i.test(source) && !isWindowsImagePath(source)) return null;

	// Agents often point at a line with `path:12` or `path#L12`; the editor opens the whole file.
	const path = decodeImagePath(source).replace(/:\d+(?::\d+)?$/, '');

	if (!path || path.endsWith('/') || path.endsWith('\\')) return null;

	const documentPath = scope?.documentPath;

	const base = documentPath
		? resolvePath(scope?.workspacePath ?? roots[0], `${documentPath}/..`)
		: roots[0];

	const absolute = resolvePath(base, path);

	if (!absolute) return null;

	let target: WorkspaceFileTarget | null = null;

	for (const root of roots) {
		const normalizedRoot = normalizePath(root);

		if (!normalizedRoot) continue;

		const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;

		const inside = isWindowsImagePath(prefix)
			? absolute.toLowerCase().startsWith(prefix.toLowerCase())
			: absolute.startsWith(prefix);

		if (!inside || absolute.length === prefix.length) continue;

		const relative = absolute.slice(prefix.length);

		if (!target || relative.length < target.path.length)
			target = { workspacePath: root, path: relative };
	}

	return target;
}
