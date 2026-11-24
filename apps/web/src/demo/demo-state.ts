import type { Doc, Id } from '@convex/_generated/dataModel';
import type { api } from '@convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import {
	AGENT_DECIDE_OPTION_ID,
	finalizeQuestionOptions,
	formatQuestionContinuationPrompt,
	normalizeQuestionAnswer
} from '@convex/lib/agentQuestions';
import type { InboxState } from '@convex/lib/inboxState';
import { reasoningEffortIds, type SupportedReasoningEffort } from '@convex/lib/models';
import type { TokenUsageTotals } from '@convex/lib/validators';
import { fetchGatewayModelCatalog, type ModelCatalog } from '$lib/chat/model-catalog';
import type { PendingAgentQuestion } from '$lib/components/home/prompt-composer';
import { fixtureId } from '$lib/convex-test-client';
import type { InboxSectionData } from '$lib/project/inbox';
import type { ThreadTreeSummary } from '$lib/project/useThreadTree';
import type { Store } from '$lib/store';
import { DOWNLOAD_URL, previewReply } from './fixtures/preview-reply';
import type { DemoProject } from './fixtures/demo-project';
import { joinRuns, prompt, recordRun, type Step } from './fixtures/rows';
import type { DemoQuestion, DemoThread, TranscriptFixture } from './fixtures/types';
import { runUsage } from './fixtures/usage';
import { playRun } from './play-run';
import { DemoTranscripts } from './transcript-api';

type Thread = Doc<'threadRecords'>;

export type RunState =
	| { status: 'idle' }
	| { status: 'scheduled'; steps: Step[] }
	| { status: 'running'; runId: string; abort: AbortController }
	| { status: 'paying'; runId: string; abort: AbortController; purchase: Purchase }
	| {
			status: 'waiting';
			question: PendingAgentQuestion;
			continueWith: DemoQuestion['continueWith'];
	  };

type Purchase = FunctionReturnType<typeof api.payments.pendingThreadApprovals>[number];

type ThreadState = {
	record: Thread;
	run: RunState;
	runIds: string[];
	purchase?: DemoThread['purchase'];
};

/** A finished run's transcript, or `null` while it plays. */
type RunRecord = { model: string; fixture: TranscriptFixture | null };

export type CatalogState =
	{ status: 'loading' } | { status: 'ready'; catalog: ModelCatalog } | { status: 'failed' };

const USER_ID = 'demo-user';
const TITLE_CHARS = 48;

export function isWorking(run: RunState) {
	return run.status === 'running' || run.status === 'paying' || run.status === 'scheduled';
}

function reasoningEffort(effort: string): SupportedReasoningEffort {
	return reasoningEffortIds.find((id) => id === effort) ?? 'medium';
}

function byRecency(left: Thread, right: Thread) {
	return right.lastMessageAt - left.lastMessageAt;
}

function section(state: InboxState, rows: Thread[]): InboxSectionData {
	return { state, rows, loading: false, canLoadMore: false, loadMore() {} };
}

function initialRun(thread: DemoThread): RunState {
	if (thread.liveRun) return { status: 'scheduled', steps: thread.liveRun };

	if (!thread.question) return { status: 'idle' };
	const { questionId, question, options, continueWith } = thread.question;

	return {
		status: 'waiting',
		question: { questionId, question, options: finalizeQuestionOptions(options) },
		continueWith
	};
}

/** The threads, runs and usage a signed-in user's Convex deployment would hold, kept in memory. */
export class DemoState implements Store<number> {
	readonly userId = USER_ID;
	readonly transcripts: DemoTranscripts;
	#threads = new Map<string, ThreadState>();
	#runs = new Map<string, RunRecord>();
	#catalog: CatalogState = { status: 'loading' };
	#cache = new Map<string, unknown>();
	#listeners = new Set<() => void>();
	#version = 0;
	#created = 0;

	constructor(projects: DemoProject[]) {
		const now = Date.now();

		const threads = projects.flatMap(({ project, threads }) =>
			threads.map((thread) => ({ thread, repositoryKey: project.repositoryKey }))
		);

		this.transcripts = new DemoTranscripts(
			Object.fromEntries(threads.map(({ thread }) => [thread.id, joinRuns(...thread.runs)]))
		);

		for (const { thread, repositoryKey } of threads) {
			const lastMessageAt = now - thread.minutesAgo * 60_000;
			const run = initialRun(thread);
			const runIds: string[] = [];

			for (const fixture of thread.runs) {
				const runId = fixture.rows[0]?.runId;

				if (!runId) continue;
				runIds.push(runId);
				this.#runs.set(runId, { model: thread.model, fixture });
			}

			const record: Thread = {
				_id: fixtureId<'threadRecords'>(thread.id),
				_creationTime: lastMessageAt,
				userId: USER_ID,
				status: isWorking(run) ? 'running' : 'completed',
				repositoryKey,
				title: thread.title,
				selectedModel: thread.model,
				reasoningEffort: thread.effort,
				fastMode: false,
				lastMessageAt
			};

			if (thread.parentId) record.parentThreadId = fixtureId<'threadRecords'>(thread.parentId);

			if (thread.settled) record.archivedAt = lastMessageAt;
			this.#threads.set(thread.id, { run, runIds, record, purchase: thread.purchase });
		}
	}

	getSnapshot = () => this.#version;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);

		return () => {
			this.#listeners.delete(listener);
		};
	};

	record(threadId: string): Thread | undefined {
		return this.#threads.get(threadId)?.record;
	}

	run(threadId: string): RunState {
		return this.#threads.get(threadId)?.run ?? { status: 'idle' };
	}

	sections(search: string, repositoryKeys: string[]): InboxSectionData[] {
		const query = search.trim().toLowerCase();

		return this.#cached(`sections:${repositoryKeys.join(' ')}:${query}`, () => {
			const inProjects = (thread: Thread) =>
				repositoryKeys.length === 0 || repositoryKeys.includes(thread.repositoryKey);

			const matches = (thread: Thread) =>
				(thread.title ?? '').toLowerCase().includes(query) ||
				this.children(thread._id).some(matches);

			const roots = this.#records().filter(
				(thread) => thread.parentThreadId === undefined && inProjects(thread) && matches(thread)
			);

			return [
				section(
					'unsettled',
					roots.filter((thread) => thread.archivedAt === undefined)
				),
				section(
					'settled',
					roots.filter((thread) => thread.archivedAt !== undefined)
				)
			];
		});
	}

	children(threadId: string): Thread[] {
		return this.#cached(`children:${threadId}`, () =>
			this.#records().filter((thread) => thread.parentThreadId === threadId)
		);
	}

	treeSummary(threadId: string): ThreadTreeSummary {
		return this.#cached(`summary:${threadId}`, () => {
			const descendants = this.#descendants(threadId).map((id) => this.run(id));
			const own = this.run(threadId);
			const descendantsActive = descendants.some((run) => run.status !== 'idle');
			const waitingForInput = own.status === 'waiting';

			return {
				workingDescendantCount: descendants.filter(isWorking).length,
				descendantCount: descendants.length,
				anyActive: descendantsActive || waitingForInput || isWorking(own),
				descendantsActive,
				waitingForInput
			};
		});
	}

	get catalog(): CatalogState {
		return this.#catalog;
	}

	async loadCatalog() {
		this.#setCatalog({ status: 'loading' });

		try {
			const catalog = await fetchGatewayModelCatalog(import.meta.env.PUBLIC_MODEL_GATEWAY_URL);

			this.#setCatalog({ status: 'ready', catalog });
		} catch {
			this.#setCatalog({ status: 'failed' });
		}
	}

	runUsage(runId: string): TokenUsageTotals[] {
		return this.#cached(`run-usage:${runId}`, () => {
			const run = this.#runs.get(runId);
			const catalog = this.#catalog.status === 'ready' ? this.#catalog.catalog : undefined;

			return run?.fixture ? [runUsage(run.model, run.fixture, catalog)] : [];
		});
	}

	pendingPurchases(threadId: string): Purchase[] {
		return this.#cached(`purchases:${threadId}`, () => {
			const run = this.run(threadId);

			return run.status === 'paying' ? [run.purchase] : [];
		});
	}

	threadUsage(threadId: string) {
		return this.#cached(`usage:${threadId}`, () => ({
			totals: this.#threadTotals(threadId),
			subagents: this.#descendants(threadId).map((id) => ({
				threadId: fixtureId<'threadRecords'>(id),
				title: this.record(id)?.title,
				totals: this.#threadTotals(id)
			}))
		}));
	}

	setInboxState(threadId: string, state: InboxState) {
		this.#patch(threadId, { archivedAt: state === 'settled' ? Date.now() : undefined });
	}

	rename(threadId: string, title: string) {
		this.#patch(threadId, { title });
	}

	open(threadId: string) {
		const run = this.run(threadId);

		if (run.status === 'scheduled') void this.#play(threadId, run.steps);
	}

	submitPrompt(
		threadId: Id<'threadRecords'> | null,
		repositoryKey: string,
		text: string,
		model: string,
		effort: string
	): Id<'threadRecords'> {
		const id = threadId ?? this.#createThread(repositoryKey, text, model, effort);
		this.#patch(id, { selectedModel: model, reasoningEffort: reasoningEffort(effort) });
		void this.#play(id, previewReply(text));

		return id;
	}

	answer(threadId: string, optionId: string | null, text: string) {
		const run = this.run(threadId);

		if (run.status !== 'waiting') return;

		const answer = normalizeQuestionAnswer({
			options: run.question.options,
			optionId: optionId ?? undefined,
			text
		});

		void this.#play(threadId, [
			prompt(formatQuestionContinuationPrompt([{ question: run.question.question, answer }])),
			...run.continueWith(answer)
		]);
	}

	skipQuestion(threadId: string) {
		this.answer(threadId, AGENT_DECIDE_OPTION_ID, '');
	}

	cancel(threadId: string) {
		const run = this.run(threadId);

		if (run.status === 'running' || run.status === 'paying') run.abort.abort();
	}

	async #play(threadId: string, steps: Step[]) {
		const thread = this.#threads.get(threadId);

		if (!thread) return;
		const runId = `run-${threadId}-${this.#runs.size}`;
		const fixture = recordRun(runId, steps);
		const abort = new AbortController();

		this.#runs.set(runId, { model: thread.record.selectedModel, fixture: null });
		this.#set(threadId, {
			run: { status: 'running', runId, abort },
			runIds: [...thread.runIds, runId],
			record: {
				...thread.record,
				status: 'running',
				lastMessageAt: Date.now(),
				archivedAt: undefined
			}
		});

		const played = await playRun(this.transcripts, threadId, fixture, abort.signal, () =>
			this.#awaitApproval(threadId, runId, abort)
		);

		this.#runs.set(runId, { model: thread.record.selectedModel, fixture: played });

		const record = this.record(threadId) ?? thread.record;

		this.#set(threadId, {
			run: { status: 'idle' },
			record: { ...record, status: abort.signal.aborted ? 'cancelled' : 'completed' }
		});
	}

	#awaitApproval(threadId: string, runId: string, abort: AbortController) {
		const thread = this.#threads.get(threadId);

		if (!thread?.purchase) return;
		const { merchant, amountCents, currency } = thread.purchase;

		const purchase: Purchase = {
			_id: fixtureId<'purchases'>(`purchase-${runId}`),
			threadId: thread.record._id,
			merchant,
			amount: amountCents,
			currency,
			status: 'awaiting_approval',
			createdAt: Date.now(),
			approvalUrl: DOWNLOAD_URL
		};

		this.#set(threadId, { run: { status: 'paying', runId, abort, purchase } });
	}

	#createThread(
		repositoryKey: string,
		text: string,
		model: string,
		effort: string
	): Id<'threadRecords'> {
		const now = Date.now();
		const id = fixtureId<'threadRecords'>(`new-thread-${++this.#created}`);
		const title = text.trim().split('\n', 1)[0].slice(0, TITLE_CHARS) || 'New thread';

		this.#threads.set(id, {
			run: { status: 'idle' },
			runIds: [],
			record: {
				_id: id,
				_creationTime: now,
				userId: USER_ID,
				status: 'queued',
				repositoryKey,
				title,
				selectedModel: model,
				reasoningEffort: reasoningEffort(effort),
				fastMode: false,
				lastMessageAt: now
			}
		});

		return id;
	}

	#records() {
		return [...this.#threads.values()].map((thread) => thread.record).sort(byRecency);
	}

	#descendants(threadId: string): string[] {
		return this.children(threadId).flatMap((child) => [child._id, ...this.#descendants(child._id)]);
	}

	#threadTotals(threadId: string) {
		return (this.#threads.get(threadId)?.runIds ?? []).flatMap((runId) => this.runUsage(runId));
	}

	#patch(threadId: string, patch: Partial<Thread>) {
		const record = this.record(threadId);

		if (record) this.#set(threadId, { record: { ...record, ...patch } });
	}

	#set(threadId: string, update: Partial<ThreadState>) {
		const thread = this.#threads.get(threadId);

		if (!thread) return;
		this.#threads.set(threadId, { ...thread, ...update });
		this.#changed();
	}

	#setCatalog(catalog: CatalogState) {
		this.#catalog = catalog;
		this.#changed();
	}

	#changed() {
		this.#cache.clear();
		this.#version += 1;

		for (const listener of this.#listeners) listener();
	}

	#cached<T>(key: string, compute: () => T): T {
		if (!this.#cache.has(key)) this.#cache.set(key, compute());

		// oxlint-disable-next-line typescript/consistent-type-assertions -- each key always stores the value its one caller computes.
		return this.#cache.get(key) as T;
	}
}
