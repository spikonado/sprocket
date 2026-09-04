export const AGENT_DECIDE_OPTION_ID = 'agent_decide';
export const AGENT_DECIDE_OPTION_LABEL = 'Let me (the agent) decide';

export const MAX_QUESTION_CHARS = 2000;
export const MAX_OPTION_ID_CHARS = 20;
export const MAX_OPTION_LABEL_CHARS = 200;
export const MAX_QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MIN_AGENT_OPTIONS = 1;
const MAX_AGENT_OPTIONS = 4;

export type AgentQuestionOption = {
	id: string;
	label: string;
};

export type AgentQuestionAnswer = {
	optionId?: string;
	optionLabel?: string;
	text?: string;
};

function agentDecideOption(): AgentQuestionOption {
	return {
		id: AGENT_DECIDE_OPTION_ID,
		label: AGENT_DECIDE_OPTION_LABEL
	};
}

export function validateQuestionText(question: string): string {
	const trimmed = question.trim();
	if (!trimmed) {
		throw new Error('Question cannot be empty.');
	}
	if (trimmed.length > MAX_QUESTION_CHARS) {
		throw new Error(`Question cannot exceed ${MAX_QUESTION_CHARS} characters.`);
	}
	return trimmed;
}

function validateAgentOptions(options: AgentQuestionOption[]): AgentQuestionOption[] {
	if (options.length < MIN_AGENT_OPTIONS || options.length > MAX_AGENT_OPTIONS) {
		throw new Error(
			`Provide between ${MIN_AGENT_OPTIONS} and ${MAX_AGENT_OPTIONS} options (the agent-decide option is added automatically).`
		);
	}

	const seen = new Set<string>();
	const normalized: AgentQuestionOption[] = [];
	for (const option of options) {
		const id = option.id.trim();
		const label = option.label.trim();
		if (!id) {
			throw new Error('Option id cannot be empty.');
		}
		if (!label) {
			throw new Error('Option label cannot be empty.');
		}
		if (id.length > MAX_OPTION_ID_CHARS) {
			throw new Error(`Option id cannot exceed ${MAX_OPTION_ID_CHARS} characters.`);
		}
		if (label.length > MAX_OPTION_LABEL_CHARS) {
			throw new Error(`Option label cannot exceed ${MAX_OPTION_LABEL_CHARS} characters.`);
		}
		if (id === AGENT_DECIDE_OPTION_ID) {
			throw new Error(`Option id '${AGENT_DECIDE_OPTION_ID}' is reserved.`);
		}
		if (seen.has(id)) {
			throw new Error(`Duplicate option id '${id}'.`);
		}
		seen.add(id);
		normalized.push({ id, label });
	}
	return normalized;
}

export function finalizeQuestionOptions(options: AgentQuestionOption[]): AgentQuestionOption[] {
	return [...validateAgentOptions(options), agentDecideOption()];
}

export function normalizeQuestionAnswer(args: {
	options: AgentQuestionOption[];
	optionId?: string;
	text?: string;
}): AgentQuestionAnswer {
	const text = args.text?.trim() || undefined;
	const optionId = args.optionId?.trim() || undefined;

	if (!optionId && !text) {
		throw new Error('Select an option or provide an answer.');
	}

	if (!optionId) {
		return { text };
	}

	const option = args.options.find((entry) => entry.id === optionId);
	if (!option) {
		throw new Error(`Unknown option id '${optionId}'.`);
	}

	const answer: AgentQuestionAnswer = {
		optionId: option.id,
		optionLabel: option.label
	};
	if (text) answer.text = text;
	return answer;
}

export function canSubmitQuestionAnswer(args: {
	selectedOptionId: string | null | undefined;
	text: string;
}): boolean {
	return Boolean(args.selectedOptionId?.trim()) || Boolean(args.text.trim());
}
