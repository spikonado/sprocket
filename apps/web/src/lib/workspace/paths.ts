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

function getBrowseDirectoryPath(currentPath: string): string {
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

function hasTrailingPathSeparator(value: string): boolean {
	return /[\\/]$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
	return value.replace(/[\\/]+$/, '');
}

type BrowseEntry = {
	name: string;
	fullPath: string;
};

type BrowsePathInput = {
	query: string;
	browseParentPath: string;
	browseEntries: BrowseEntry[];
};

/** Resolves a typed leaf against browse entries or the current parent directory. */
function matchBrowseLeafPath(input: {
	leaf: string;
	browseParentPath: string;
	browseEntries: BrowseEntry[];
}): string | undefined {
	if (!input.leaf) {
		return undefined;
	}

	const exactEntry = input.browseEntries.find(
		(entry) => entry.name !== '..' && entry.name === input.leaf
	);
	if (exactEntry) {
		return exactEntry.fullPath;
	}

	if (input.browseParentPath) {
		const parentName = input.browseParentPath.split(/[/\\]/).filter(Boolean).at(-1);
		if (parentName && parentName.toLowerCase() === input.leaf.toLowerCase()) {
			return input.browseParentPath;
		}
	}

	return undefined;
}

export function resolveWorkspacePathFromBrowse(input: BrowsePathInput): string {
	const trimmed = input.query.trim();
	if (!trimmed) {
		return '';
	}

	if (hasTrailingPathSeparator(trimmed)) {
		return input.browseParentPath || trimTrailingPathSeparators(trimmed);
	}

	return (
		matchBrowseLeafPath({
			leaf: getBrowseLeafPathSegment(trimmed),
			browseParentPath: input.browseParentPath,
			browseEntries: input.browseEntries
		}) ?? trimmed
	);
}

export function workspacePathRequiresCreation(input: BrowsePathInput): boolean {
	const trimmed = input.query.trim();
	if (!trimmed || hasTrailingPathSeparator(trimmed)) {
		return false;
	}

	const leaf = getBrowseLeafPathSegment(trimmed);
	if (!leaf) {
		return false;
	}

	return (
		matchBrowseLeafPath({
			leaf,
			browseParentPath: input.browseParentPath,
			browseEntries: input.browseEntries
		}) === undefined
	);
}
