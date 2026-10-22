import { v, type Infer } from 'convex/values';
import { paginationResultValidator } from 'convex/server';
import { internal } from '@convex/_generated/api';
import { env, internalAction, internalQuery } from '@convex/_generated/server';
import { vAnalyticsEvent } from '@convex/lib/analytics';
import { vJsonValue, type JsonObject } from '@convex/lib/json';

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

// executorJobs payloads can hold whole files, so pages are also bounded by bytes read.
const TOOL_PAGE_SIZE = 200;

const TOOL_PAGE_MAX_BYTES = 1_000_000;

type PostHogEvent = Infer<typeof vAnalyticsEvent> & { timestamp: string };

async function postEvent(event: PostHogEvent): Promise<void> {
	const token = env.POSTHOG_PROJECT_TOKEN;

	if (!token) return;

	const properties: JsonObject = { ...event.properties, site: 'sprocket_app' };

	if (event.personProperties) properties.$set = event.personProperties;

	const response = await fetch(`${env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST}/i/v0/e/`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			api_key: token,
			event: event.event,
			distinct_id: event.distinctId,
			timestamp: event.timestamp,
			properties
		})
	});

	if (!response.ok) throw new Error(`PostHog capture failed with status ${response.status}.`);
}

export const send = internalAction({
	args: { ...vAnalyticsEvent.fields, timestamp: v.string() },
	returns: v.null(),
	handler: async (_ctx, args) => {
		await postEvent(args);

		return null;
	}
});

export const runSummary = internalQuery({
	args: { runId: v.id('runs') },
	returns: v.union(
		v.null(),
		v.object({ userId: v.string(), properties: v.record(v.string(), vJsonValue) })
	),
	handler: async (ctx, { runId }) => {
		const run = await ctx.db.get('runs', runId);

		if (!run) return null;
		const thread = await ctx.db.get('threadRecords', run.threadId);

		const calls = await ctx.db
			.query('modelCallUsage')
			.withIndex('by_runId_eventId', (q) => q.eq('runId', runId))
			.collect();

		const questions = await ctx.db
			.query('agentQuestions')
			.withIndex('by_runId_sequence', (q) => q.eq('runId', runId))
			.collect();

		// One handoff records `handoff:<claimId>:<attemptSeq>:<index>` per summary call.
		const handoffs = new Set(
			calls
				.filter((call) => call.eventId.startsWith('handoff:'))
				.map((call) => call.eventId.slice(0, call.eventId.lastIndexOf(':')))
		);

		const sum = (
			field:
				'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens'
		) => calls.reduce((total, call) => total + call[field], 0);

		return {
			userId: run.userId,
			properties: {
				run_id: runId,
				thread_id: run.threadId,
				is_subagent: thread?.parentThreadId !== undefined,
				is_continuation: run.continuationOfRunId !== undefined,
				status: run.status,
				failure_kind: run.failureKind ?? null,
				model: run.selectedModel,
				provider: run.completionProvider ?? null,
				reasoning_effort: run.reasoningEffort,
				fast_mode: run.fastMode,
				duration_ms:
					run.startedAt !== undefined && run.completedAt !== undefined
						? run.completedAt - run.startedAt
						: null,
				user_stopped: run.cancellationRequestedAt !== undefined,
				model_calls: calls.length,
				context_handoffs: handoffs.size,
				input_tokens: sum('inputTokens'),
				cache_read_tokens: sum('cacheReadTokens'),
				cache_write_tokens: sum('cacheWriteTokens'),
				output_tokens: sum('outputTokens'),
				reasoning_tokens: sum('reasoningTokens'),
				question_wait_ms: questions.reduce(
					(total, question) =>
						total +
						(question.answeredAt !== undefined ? question.answeredAt - question._creationTime : 0),
					0
				)
			}
		};
	}
});

const vToolPage = paginationResultValidator(
	v.object({ kind: v.string(), skill: v.union(v.string(), v.null()) })
);

export const runToolPage = internalQuery({
	args: { runId: v.id('runs'), cursor: v.union(v.string(), v.null()) },
	returns: vToolPage,
	handler: async (ctx, { runId, cursor }) => {
		const page = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (q) => q.eq('runId', runId))
			.paginate({ cursor, numItems: TOOL_PAGE_SIZE, maximumBytesRead: TOOL_PAGE_MAX_BYTES });

		return {
			...page,
			page: page.page.map((job) => ({
				kind: job.kind,
				skill:
					job.kind === 'read_skill' && job.status === 'completed' && 'name' in job.payload
						? job.payload.name
						: null
			}))
		};
	}
});

export const captureRunCompleted = internalAction({
	args: { runId: v.id('runs') },
	returns: v.null(),
	handler: async (ctx, { runId }) => {
		const summary = await ctx.runQuery(internal.analytics.runSummary, { runId });

		if (!summary) return null;
		const toolCalls: Record<string, number> = {};
		const skillsRead = new Set<string>();
		let cursor: string | null = null;

		for (;;) {
			const page: Infer<typeof vToolPage> = await ctx.runQuery(internal.analytics.runToolPage, {
				runId,
				cursor
			});

			for (const job of page.page) {
				toolCalls[job.kind] = (toolCalls[job.kind] ?? 0) + 1;

				if (job.skill) skillsRead.add(job.skill);
			}

			if (page.isDone) break;
			cursor = page.continueCursor;
		}

		await postEvent({
			distinctId: summary.userId,
			event: 'run_completed',
			timestamp: new Date().toISOString(),
			properties: {
				...summary.properties,
				tool_calls: toolCalls,
				subagents_spawned: toolCalls.spawn_subagent ?? 0,
				skills_read: [...skillsRead]
			}
		});

		return null;
	}
});
