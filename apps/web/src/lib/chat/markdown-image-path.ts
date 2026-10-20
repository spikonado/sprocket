export function isWindowsImagePath(path: string) {
	return /^[a-z]:[\\/]/i.test(path);
}

export function isAbsoluteImagePath(path: string) {
	return /^[\\/]/.test(path) || isWindowsImagePath(path);
}
