import type { AgentQuestionAnswer, AgentQuestionOption } from '@convex/lib/agentQuestions';
import type { SupportedReasoningEffort } from '@convex/lib/models';
import type { TranscriptRow } from '$lib/types/sprocket';
import type { Step } from './rows';

/** One thread's transcript as the local server serves it: thread rows, each work row's items, and full item details. */
export type TranscriptFixture = {
	rows: TranscriptRow[];
	work: Record<string, TranscriptRow[]>;
	items: Record<string, TranscriptRow>;
};

export type DemoQuestion = {
	questionId: string;
	question: string;
	options: AgentQuestionOption[];
	continueWith: (answer: AgentQuestionAnswer) => Step[];
};

export type DemoThread = {
	id: string;
	title: string;
	model: string;
	effort: SupportedReasoningEffort;
	minutesAgo: number;
	parentId?: string;
	settled?: boolean;
	runs: TranscriptFixture[];
	question?: DemoQuestion;
	/** Played the first time the thread opens, as if the agent were working on it. */
	liveRun?: Step[];
	/** Awaits approval once the live run reaches its tool recorded as running. */
	purchase?: { merchant: string; amountCents: number; currency: string };
};
