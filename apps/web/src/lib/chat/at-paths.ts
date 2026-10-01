import type { WorkspaceSearchEntry } from '$lib/types/sprocket';

const ACTIVE_PATH_TOKEN = /(^|\s)@([^\s"@]*|"(?:[^"\\]|\\.)*)$/;

const UNQUOTED_PATH_CHARACTER = /[\s"\\@]/;

const QUOTED_TOKEN_ESCAPE = /\\(["\\])/g;

export function workspaceEntryDisplayPath(entry: WorkspaceSearchEntry) {
	return entry.path + (entry.kind === 'directory' ? '/' : '');
}

function matchActivePathToken(text: string, caret: number) {
	if (caret < 0 || caret > text.length) return null;
	const match = text.slice(0, caret).match(ACTIVE_PATH_TOKEN);

	if (!match || match.index === undefined) return null;
	const token = match[2];
	const quoted = token.startsWith('"');
	const query = quoted ? token.slice(1).replace(QUOTED_TOKEN_ESCAPE, '$1') : token;

	return { query, quoted, start: match.index + match[1].length };
}

export function getActiveAtQuery(text: string, caret: number): string | null {
	return matchActivePathToken(text, caret)?.query ?? null;
}

export function applyPathSelection(text: string, caret: number, entry: WorkspaceSearchEntry) {
	const match = matchActivePathToken(text, caret);

	if (!match) return null;
	let end = caret;

	if (match.quoted) {
		while (end < text.length && text[end] !== '"') {
			end += text[end] === '\\' && end + 1 < text.length ? 2 : 1;
		}

		if (text[end] === '"') end += 1;
	} else {
		while (end < text.length && !/\s/.test(text[end])) end += 1;
	}

	if (text[end] === ' ') end += 1;
	const path = workspaceEntryDisplayPath(entry);
	const reference = UNQUOTED_PATH_CHARACTER.test(path) ? JSON.stringify(path) : path;
	const replacement = `@${reference} `;

	return {
		text: text.slice(0, match.start) + replacement + text.slice(end),
		caret: match.start + replacement.length
	};
}
