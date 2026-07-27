import { describe, expect, it } from 'vitest';

import {
	AGENT_DECIDE_OPTION_ID,
	AGENT_DECIDE_OPTION_LABEL,
	MAX_OPTION_ID_CHARS,
	MAX_OPTION_LABEL_CHARS,
	MAX_QUESTION_CHARS,
	canSubmitQuestionAnswer,
	finalizeQuestionOptions,
	normalizeQuestionAnswer,
	validateQuestionText
} from '@convex/lib/agentQuestions';

describe('agentQuestions helpers', () => {
	it('finalizes options with agent_decide appended', () => {
		const options = finalizeQuestionOptions([
			{ id: 'yes', label: 'Yes' },
			{ id: 'no', label: 'No' }
		]);
		expect(options).toHaveLength(3);
		expect(options.at(-1)).toEqual({
			id: AGENT_DECIDE_OPTION_ID,
			label: AGENT_DECIDE_OPTION_LABEL
		});
	});

	it('rejects overlong question and option fields', () => {
		expect(() => validateQuestionText('x'.repeat(MAX_QUESTION_CHARS + 1))).toThrow(/2000/);
		expect(() =>
			finalizeQuestionOptions([{ id: 'x'.repeat(MAX_OPTION_ID_CHARS + 1), label: 'Ok' }])
		).toThrow(/20/);
		expect(() =>
			finalizeQuestionOptions([{ id: 'ok', label: 'x'.repeat(MAX_OPTION_LABEL_CHARS + 1) }])
		).toThrow(/200/);
	});

	it('normalizes option, extension, and custom answers', () => {
		const options = finalizeQuestionOptions([{ id: 'ship', label: 'Ship it' }]);
		expect(normalizeQuestionAnswer({ options, optionId: 'ship' })).toEqual({
			optionId: 'ship',
			optionLabel: 'Ship it'
		});
		expect(normalizeQuestionAnswer({ options, optionId: 'ship', text: '  tonight  ' })).toEqual({
			optionId: 'ship',
			optionLabel: 'Ship it',
			text: 'tonight'
		});
		expect(normalizeQuestionAnswer({ options, text: 'custom' })).toEqual({
			text: 'custom'
		});
		expect(() => normalizeQuestionAnswer({ options })).toThrow(/Select an option/);
	});

	it('gates composer submit for question answers', () => {
		expect(canSubmitQuestionAnswer({ selectedOptionId: null, text: '' })).toBe(false);
		expect(canSubmitQuestionAnswer({ selectedOptionId: 'a', text: '' })).toBe(true);
		expect(canSubmitQuestionAnswer({ selectedOptionId: null, text: 'custom' })).toBe(true);
	});
});
