import { describe, expect, it } from 'vitest';

import {
	applySkillSelection,
	filterSkills,
	getActiveDollarQuery,
	type SkillSummary
} from '$lib/chat/dollar-skills';

const skills: SkillSummary[] = [
	{ name: 'pdf-processing', description: 'Handle PDFs' },
	{ name: 'code-review', description: 'Review code' },
	{ name: 'deploy', description: 'Deploy apps' }
];

describe('getActiveDollarQuery', () => {
	it('matches at the start of text', () => {
		expect(getActiveDollarQuery('$pdf', 4)).toBe('pdf');
	});

	it('matches after whitespace', () => {
		expect(getActiveDollarQuery('please $code', 12)).toBe('code');
	});

	it('matches with the caret mid-token', () => {
		expect(getActiveDollarQuery('$pdf-processing', 5)).toBe('pdf-');
	});

	it('rejects path-like slashes', () => {
		expect(getActiveDollarQuery('foo/bar', 7)).toBeNull();
	});

	it('rejects a dollar sign followed by a space', () => {
		expect(getActiveDollarQuery('$ pdf', 2)).toBeNull();
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

	it('keeps alphabetical order within each group', () => {
		expect(filterSkills(skills, '').map((skill) => skill.name)).toEqual([
			'code-review',
			'deploy',
			'pdf-processing'
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
});
