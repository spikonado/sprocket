import type { WorkspaceSearchEntry } from '$lib/types/sprocket';

const ACTIVE_PATH_TOKEN = /(^|\s)@([^\s"@]*|"(?:[^"\\]|\\.)*)$/;

const QUOTED_TOKEN_ESCAPE = /\\(["\\])/g;

const MARKDOWN_LABEL_SPECIALS = /[\\[\]`*_<>&~]/g;

const URI_PUNCTUATION = /[!'()*]/g;

export function workspaceEntryDisplayPath(entry: WorkspaceSearchEntry) {
	return entry.path + (entry.kind === 'directory' ? '/' : '');
}

function escapeMarkdownLabel(name: string) {
	return name.replace(MARKDOWN_LABEL_SPECIALS, (character) =>
		character === '&' ? '&amp;' : `&#${character.charCodeAt(0)};`
	);
}

function encodePathSegment(segment: string) {
	return encodeURIComponent(segment).replace(
		URI_PUNCTUATION,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

export function getActiveAtMention(text: string, caret: number) {
	if (caret < 0 || caret > text.length) return null;
	const match = text.slice(0, caret).match(ACTIVE_PATH_TOKEN);

	if (!match || match.index === undefined) return null;
	const token = match[2];
	const quoted = token.startsWith('"');
	const query = quoted ? token.slice(1).replace(QUOTED_TOKEN_ESCAPE, '$1') : token;

	return { query, quoted, start: match.index + match[1].length };
}

export function applyPathSelection(text: string, caret: number, entry: WorkspaceSearchEntry) {
	const match = getActiveAtMention(text, caret);

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
	const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
	const label = escapeMarkdownLabel(name);
	const destination = path.split('/').map(encodePathSegment).join('/');
	const replacement = `[${label}](${destination}) `;

	return {
		text: text.slice(0, match.start) + replacement + text.slice(end),
		caret: match.start + replacement.length
	};
}
