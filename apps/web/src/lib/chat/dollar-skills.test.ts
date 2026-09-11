import { describe, expect, it } from 'vitest';

import { applySkillSelection, filterSkills, getActiveDollarQuery } from '$lib/chat/dollar-skills';
import type { SkillSummary } from '$lib/types/sprocket';

const skills: SkillSummary[] = [
	{ name: 'pdf-processing', description: 'Handle PDFs' },
	{ name: 'code-review', description: 'Review code' },
	{ name: 'deploy', description: 'Deploy apps' }
];

describe('getActiveDollarQuery', () => {
	it('matches with the caret mid-token', () => {
		expect(getActiveDollarQuery('$pdf-processing', 5)).toBe('pdf-');
	});

	it('rejects a path-like slash inside a skill token', () => {
		expect(getActiveDollarQuery('path/$foo/bar', 10)).toBeNull();
	});

	it('rejects a dollar mid-token', () => {
		expect(getActiveDollarQuery('price$foo', 9)).toBeNull();
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
	it('replaces the active skill token and places the caret after a trailing space', () => {
		expect(applySkillSelection('use $pd', 7, 'pdf-processing')).toEqual({
			text: 'use $pdf-processing ',
			caret: 20
		});
	});

	it('replaces the full skill token when the caret is mid-token', () => {
		expect(applySkillSelection('$pdf-processing more', 5, 'deploy')).toEqual({
			text: '$deploy more',
			caret: 8
		});
	});

	it('does not double an existing trailing space', () => {
		expect(applySkillSelection('$pd more', 3, 'deploy')).toEqual({
			text: '$deploy more',
			caret: 8
		});
	});
});
