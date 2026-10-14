import { describe, expect, it } from 'vitest';

import { applySkillSelection, filterSkills, getActiveSkillMention } from '$lib/chat/skill-mentions';
import type { SkillSummary } from '$lib/types/sprocket';

const pdfSkill: SkillSummary = {
	name: 'pdf-processing',
	description: 'Handle PDFs',
	disableModelInvocation: false
};

const deploySkill: SkillSummary = {
	name: 'deploy',
	description: 'Deploy apps',
	disableModelInvocation: true
};

const skills: SkillSummary[] = [
	pdfSkill,
	{ name: 'code-review', description: 'Review code', disableModelInvocation: false },
	deploySkill
];

describe('getActiveSkillMention', () => {
	it('matches with the caret mid-token', () => {
		expect(getActiveSkillMention('$pdf-processing', 5)).toEqual({
			query: 'pdf-',
			prefix: '$',
			tokenStart: 0
		});
	});

	it('rejects a path-like slash inside a skill token', () => {
		expect(getActiveSkillMention('path/$foo/bar', 10)).toBeNull();
	});

	it('rejects a dollar mid-token', () => {
		expect(getActiveSkillMention('price$foo', 9)).toBeNull();
	});

	it('matches slash commands without matching slashes inside paths', () => {
		expect(getActiveSkillMention('use /de', 7)).toEqual({
			query: 'de',
			prefix: '/',
			tokenStart: 4
		});
		expect(getActiveSkillMention('src/deploy', 10)).toBeNull();
		expect(getActiveSkillMention('/usr/bin', 8)).toBeNull();
	});
});

describe('filterSkills', () => {
	it('orders prefix matches before substring matches', () => {
		expect(filterSkills(skills, 'de').map((skill) => skill.name)).toEqual([
			'deploy',
			'code-review'
		]);
	});
});

describe('applySkillSelection', () => {
	it.each(['/', '$'])('inserts a disabled skill with slash when selected through %s', (prefix) => {
		expect(applySkillSelection(`use ${prefix}de more`, 7, deploySkill)).toEqual({
			text: 'use /deploy more',
			caret: 12
		});
	});

	it('replaces the active skill token and places the caret after a trailing space', () => {
		expect(applySkillSelection('use $pd', 7, pdfSkill)).toEqual({
			text: 'use $pdf-processing ',
			caret: 20
		});
	});

	it('replaces the full skill token when the caret is mid-token', () => {
		expect(applySkillSelection('$pdf-processing more', 5, deploySkill)).toEqual({
			text: '/deploy more',
			caret: 8
		});
	});

	it('does not double an existing trailing space', () => {
		expect(applySkillSelection('$pd more', 3, deploySkill)).toEqual({
			text: '/deploy more',
			caret: 8
		});
	});
});
