import { ConvexError } from 'convex/values';

const UNCAUGHT_CONVEX_ERROR_PREFIX = 'Uncaught ConvexError: ';
const UNCAUGHT_ERROR_PREFIX = 'Uncaught Error: ';

function firstLineAfterPrefix(message: string, prefix: string): string | null {
	if (!message.startsWith(prefix)) {
		return null;
	}
	const rest = message.slice(prefix.length);
	const newline = rest.indexOf('\n');
	const line = newline === -1 ? rest : rest.slice(0, newline);
	const cutParen = line.indexOf('(');
	const text = (cutParen === -1 ? line : line.slice(0, cutParen)).trim();
	return text || null;
}

/** Readable sentence from a Convex client error, preferring ConvexError data. */
export function convexClientErrorMessage(error: Error): string | null {
	if (error instanceof ConvexError) {
		// SAFETY: this app throws ConvexError with a string payload.
		const data = error.data as string;
		const text = data.trim();
		if (text) {
			return text;
		}
	}

	const message = error.message.trim();
	if (!message) {
		return null;
	}
	return (
		firstLineAfterPrefix(message, UNCAUGHT_CONVEX_ERROR_PREFIX) ??
		firstLineAfterPrefix(message, UNCAUGHT_ERROR_PREFIX) ??
		message
	);
}
