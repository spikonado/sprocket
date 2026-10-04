export function stripImageFileScheme(source: string) {
	return source.replace(/^file:\/\/\/([a-z]:[\\/])/i, '$1').replace(/^file:\/\//i, '');
}

export function isWindowsImagePath(path: string) {
	return /^[a-z]:[\\/]/i.test(path);
}

export function isAbsoluteImagePath(path: string) {
	return /^[\\/]/.test(path) || isWindowsImagePath(path);
}
