export function isFilesystemBrowseQuery(value: string): boolean {
	return (
		value.startsWith('./') ||
		value.startsWith('../') ||
		value.startsWith('.\\') ||
		value.startsWith('..\\') ||
		value.startsWith('/') ||
		value.startsWith('~/') ||
		value === '~' ||
		/^[a-zA-Z]:[\\/]/.test(value)
	);
}

export function getBrowseDirectoryPath(currentPath: string): string {
	if (currentPath.endsWith('/') || currentPath.endsWith('\\')) {
		return currentPath;
	}

	const lastUnixSeparator = currentPath.lastIndexOf('/');
	const lastWindowsSeparator = currentPath.lastIndexOf('\\');
	const lastSeparator = Math.max(lastUnixSeparator, lastWindowsSeparator);

	if (lastSeparator < 0) {
		return currentPath;
	}

	return currentPath.slice(0, lastSeparator + 1);
}

export function getBrowseLeafPathSegment(currentPath: string): string {
	const directoryPath = getBrowseDirectoryPath(currentPath);
	return currentPath.slice(directoryPath.length);
}

export function appendBrowsePathSegment(currentPath: string, segment: string): string {
	const separator = currentPath.includes('\\') ? '\\' : '/';
	const directoryPath = getBrowseDirectoryPath(currentPath);
	return `${directoryPath}${segment}${separator}`;
}

export function inferWorkspaceNameFromPath(value: string): string {
	const trimmed = value.replace(/[\\/]+$/, '');
	const segments = trimmed.split(/[/\\]/).filter(Boolean);
	return segments.at(-1) ?? trimmed;
}

export function hasTrailingPathSeparator(value: string): boolean {
	return /[\\/]$/.test(value);
}

export function trimTrailingPathSeparators(value: string): string {
	return value.replace(/[\\/]+$/, '');
}

type BrowseEntry = {
	name: string;
	fullPath: string;
};

export function resolveWorkspacePathFromBrowse(input: {
	query: string;
	browseParentPath: string;
	browseEntries: BrowseEntry[];
}): string {
	const trimmed = input.query.trim();
	if (!trimmed) {
		return '';
	}

	if (hasTrailingPathSeparator(trimmed)) {
		return input.browseParentPath || trimTrailingPathSeparators(trimmed);
	}

	const leaf = getBrowseLeafPathSegment(trimmed);
	const exactEntry = input.browseEntries.find(
		(entry) => entry.name !== '..' && entry.name === leaf
	);
	if (exactEntry) {
		return exactEntry.fullPath;
	}

	if (leaf && input.browseParentPath) {
		const parentName = input.browseParentPath.split(/[/\\]/).filter(Boolean).at(-1);
		if (parentName && parentName.toLowerCase() === leaf.toLowerCase()) {
			return input.browseParentPath;
		}
	}

	return trimmed;
}

export function workspacePathRequiresCreation(input: {
	query: string;
	browseParentPath: string;
	browseEntries: BrowseEntry[];
}): boolean {
	const trimmed = input.query.trim();
	if (!trimmed || hasTrailingPathSeparator(trimmed)) {
		return false;
	}

	const leaf = getBrowseLeafPathSegment(trimmed);
	if (!leaf) {
		return false;
	}

	const exactEntry = input.browseEntries.find(
		(entry) => entry.name !== '..' && entry.name === leaf
	);
	if (exactEntry) {
		return false;
	}

	if (input.browseParentPath) {
		const parentName = input.browseParentPath.split(/[/\\]/).filter(Boolean).at(-1);
		if (parentName && parentName.toLowerCase() === leaf.toLowerCase()) {
			return false;
		}
	}

	return true;
}
