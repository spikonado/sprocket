import { createContext } from 'react';
import type { WorkspaceFileTarget } from '$lib/types/sprocket';
import { isAbsoluteImagePath, isWindowsImagePath } from './markdown-image-path';
import { decodeImagePath, type MarkdownImageScope } from './markdown-images';

/** `directory` is true when the link itself shows a folder; otherwise the machine is asked. */
export type MarkdownLinkTarget = WorkspaceFileTarget & { directory: boolean };

export type MarkdownFileLinks = {
	/** Workspaces whose tree shows linked entries, with relative links resolving against the first. */
	roots: readonly string[];
	open: (target: MarkdownLinkTarget) => void;
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

/** Returns `path` relative to `root`, `''` for the root itself, or null when outside. */
function relativePath(root: string, path: string) {
	const normalizedRoot = normalizePath(root);

	if (!normalizedRoot) return null;

	const windows = isWindowsImagePath(normalizedRoot);
	const comparable = (value: string) => (windows ? value.toLowerCase() : value);

	if (comparable(path) === comparable(normalizedRoot)) return '';

	const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;

	return comparable(path).startsWith(comparable(prefix)) ? path.slice(prefix.length) : null;
}

function joinPath(directory: string, name: string) {
	if (!name) return directory;

	return directory.endsWith('/') ? directory + name : `${directory}/${name}`;
}

export function markdownFileTarget(
	href: string,
	roots: readonly string[],
	scope?: MarkdownImageScope
): MarkdownLinkTarget | null {
	if (href.startsWith('//')) return null;

	if (/^[a-z][a-z\d+.-]*:/i.test(href) && !isWindowsImagePath(href)) return null;

	const path = decodeImagePath(href);

	if (!path) return null;

	const documentPath = scope?.documentPath;

	const base = documentPath
		? resolvePath(scope?.workspacePath ?? roots[0], `${documentPath}/..`)
		: roots[0];

	const absolute = resolvePath(base, path);

	if (!absolute) return null;

	let target: MarkdownLinkTarget | null = null;

	for (const root of roots) {
		const relative = relativePath(root, absolute);

		if (relative !== null && (!target || relative.length < target.path.length)) {
			target = { workspacePath: root, path: relative, directory: false };
		}
	}

	const directory = /[\\/]$/.test(path) || target?.path === '';

	if (target) return { ...target, directory };

	const split = absolute.lastIndexOf('/') + 1;
	const parent = absolute.slice(0, split - 1);

	// Outside the workspaces, a folder becomes its own tree root and a file opens from its folder.
	return directory || split === absolute.length
		? { workspacePath: absolute, path: '', directory: true }
		: {
				workspacePath: /^(?:[a-z]:)?$/i.test(parent) ? absolute.slice(0, split) : parent,
				path: absolute.slice(split),
				directory: false
			};
}

export async function openMarkdownLink(
	target: MarkdownLinkTarget,
	{
		roots,
		entryKind,
		openFile,
		openDirectory
	}: {
		roots: readonly string[];
		entryKind: (entry: WorkspaceFileTarget) => Promise<'file' | 'directory'>;
		openFile: (file: WorkspaceFileTarget) => void;
		openDirectory: (directory: WorkspaceFileTarget) => void;
	}
) {
	const { workspacePath, path } = target;
	let directory = target.directory;

	if (!directory) {
		try {
			directory = (await entryKind({ workspacePath, path })) === 'directory';
		} catch {
			// The file tab reports a missing or unreadable file.
		}
	}

	if (!directory) openFile({ workspacePath, path });
	else if (roots.includes(workspacePath)) openDirectory({ workspacePath, path });
	else openDirectory({ workspacePath: joinPath(workspacePath, path), path: '' });
}
