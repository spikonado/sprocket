import type { SkillSummary } from '$lib/types/sprocket';

const ACTIVE_SKILL_TOKEN = /(^|\s)\$([a-z0-9-]*)$/i;

function matchActiveSkillToken(
	text: string,
	caret: number
): { query: string; tokenStart: number } | null {
	if (caret < 0 || caret > text.length) {
		return null;
	}

	const before = text.slice(0, caret);
	const match = before.match(ACTIVE_SKILL_TOKEN);
	if (!match || match.index === undefined) {
		return null;
	}

	return {
		query: match[2].toLowerCase(),
		tokenStart: match.index + match[1].length
	};
}

export function getActiveDollarQuery(text: string, caret: number): string | null {
	return matchActiveSkillToken(text, caret)?.query ?? null;
}

export function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
	const normalized = query.toLowerCase();
	const prefix: SkillSummary[] = [];
	const substring: SkillSummary[] = [];

	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		if (name.startsWith(normalized)) {
			prefix.push(skill);
		} else if (normalized.length > 0 && name.includes(normalized)) {
			substring.push(skill);
		}
	}

	prefix.sort((left, right) => left.name.localeCompare(right.name));
	substring.sort((left, right) => left.name.localeCompare(right.name));
	return [...prefix, ...substring];
}

export function applySkillSelection(
	text: string,
	caret: number,
	name: string
): { text: string; caret: number } | null {
	const match = matchActiveSkillToken(text, caret);
	if (!match) {
		return null;
	}

	let tokenEnd = caret;
	while (tokenEnd < text.length && /[a-z0-9-]/i.test(text[tokenEnd] ?? '')) {
		tokenEnd += 1;
	}
	// Replacement includes a trailing space; consume an existing one so we don't double it.
	if (text[tokenEnd] === ' ') {
		tokenEnd += 1;
	}

	const replacement = `$${name} `;
	const nextText = `${text.slice(0, match.tokenStart)}${replacement}${text.slice(tokenEnd)}`;
	return {
		text: nextText,
		caret: match.tokenStart + replacement.length
	};
}
