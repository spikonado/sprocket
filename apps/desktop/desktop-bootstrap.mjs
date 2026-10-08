function isPlainObject(value) {
	return value !== null && !Array.isArray(value) && value === Object(value);
}

function parseNonEmptyString(value) {
	if (value === null || value === undefined || Array.isArray(value) || value === Object(value)) {
		return null;
	}

	if (value !== `${value}`) {
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
