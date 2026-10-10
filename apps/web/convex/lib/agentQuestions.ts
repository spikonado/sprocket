import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';

export async function isPendingQuestionActionable(
	db: DatabaseReader,
	question: Doc<'agentQuestions'>
): Promise<boolean> {
	if (question.status !== 'pending') return false;
	const run = await db.get('runs', question.runId);

	return run !== null && run.status !== 'cancelled' && run.cancellationRequestedAt === undefined;
}

async function* actionablePendingQuestions(db: DatabaseReader, threadId: Id<'threadRecords'>) {
	let afterSequence = -1;

	for (;;) {
		const pending = db
			.query('agentQuestions')
			.withIndex('by_threadId_status_sequence', (query) =>
				query.eq('threadId', threadId).eq('status', 'pending').gt('sequence', afterSequence)
			)
			.order('asc');

		let skippedRun = false;

		for await (const question of pending) {
			if (await isPendingQuestionActionable(db, question)) {
				yield question;

				continue;
			}

			const last = await db
				.query('agentQuestions')
				.withIndex('by_runId_sequence', (query) => query.eq('runId', question.runId))
				.order('desc')
				.first();

			afterSequence = last?.sequence ?? question.sequence;
			skippedRun = true;

			break;
		}

		if (!skippedRun) return;
	}
}

export async function headActionablePendingQuestion(
	db: DatabaseReader,
	threadId: Id<'threadRecords'>
): Promise<Doc<'agentQuestions'> | null> {
	for await (const question of actionablePendingQuestions(db, threadId)) {
		return question;
	}

	return null;
}

export async function actionablePendingQuestionsForThread(
	db: DatabaseReader,
	threadId: Id<'threadRecords'>
): Promise<Doc<'agentQuestions'>[]> {
	const questions: Doc<'agentQuestions'>[] = [];

	for await (const question of actionablePendingQuestions(db, threadId)) {
		questions.push(question);
	}

	return questions;
}

export const AGENT_DECIDE_OPTION_ID = 'agent_decide';

export const AGENT_DECIDE_OPTION_LABEL = 'Let me (the agent) decide';

export const MAX_QUESTION_CHARS = 2000;

export const MAX_OPTION_ID_CHARS = 20;

export const MAX_OPTION_LABEL_CHARS = 200;

export const MAX_QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const QUESTION_TIMEOUT_CHECKPOINT_MS = 365 * 24 * 60 * 60 * 1000;

export function validateQuestionTimeoutMs(
	timeoutMs: number | null | undefined
): number | undefined {
	if (timeoutMs === undefined || timeoutMs === null) return undefined;

	if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
		throw new Error('timeoutMs must be a finite non-negative integer, null, or omitted.');
	}

	return timeoutMs;
}

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

export type AnsweredAgentQuestion = {
	question: string;
	answer: AgentQuestionAnswer;
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

function formatAnswer(answer: AgentQuestionAnswer): string {
	return [answer.optionLabel, answer.text]
		.filter((part): part is string => Boolean(part))
		.join(': ');
}

export function formatQuestionContinuationPrompt(questions: AnsweredAgentQuestion[]): string {
	if (questions.length === 1) {
		return formatAnswer(questions[0].answer);
	}

	const entries = questions.map((question, index) => {
		const answerText = formatAnswer(question.answer).replaceAll('\n', '\n   ');

		return `${index + 1}. ${answerText}`;
	});

	return `Answers to your questions:\n\n${entries.join('\n\n')}`;
}

export function canSubmitQuestionAnswer(args: {
	selectedOptionId: string | null | undefined;
	text: string;
}): boolean {
	return Boolean(args.selectedOptionId?.trim()) || Boolean(args.text.trim());
}
