function isPlainObject(value) {
	return value !== null && !Array.isArray(value) && value === Object(value);
}

export function parseNonEmptyString(value) {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- this is the decoder for untyped IPC and argv input.
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();

	return trimmed.length > 0 ? trimmed : null;
}

export function parseDesktopBootstrap(value) {
	if (!isPlainObject(value)) {
		return null;
	}

	const httpBaseUrl = parseNonEmptyString(value.httpBaseUrl);

	if (httpBaseUrl === null) {
		return null;
	}

	return { httpBaseUrl };
}
