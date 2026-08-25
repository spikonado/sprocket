import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import { bindStagehandFactory } from '@convex/browserAgent';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

type StagehandInitOptions = {
	keepAlive?: boolean;
	browserbaseSessionCreateParams?: { keepAlive?: boolean; timeout?: number };
	browserbaseSessionID?: string;
};

const act = vi.fn().mockResolvedValue({
	success: true,
	message: 'Action performed',
	actionDescription: 'did the thing',
	actions: []
});
const observe = vi
	.fn()
	.mockResolvedValue([
		{ selector: '#pay', description: 'Pay button', method: 'click', arguments: [] }
	]);
const extract = vi.fn().mockResolvedValue({ total: '₹1,240', items: 2 });
const init = vi.fn().mockResolvedValue(undefined);
const close = vi.fn().mockResolvedValue(undefined);
const goto = vi.fn().mockResolvedValue(undefined);
const stagehandOptions: StagehandInitOptions[] = [];

const LIVE_VIEW_URL = 'https://live.browserbase.test/fullscreen/bb-session-task';
const fetchMock = vi.fn().mockResolvedValue({
	ok: true,
	json: async () => ({ debuggerFullscreenUrl: LIVE_VIEW_URL })
});
vi.stubGlobal('fetch', fetchMock);

async function startRun(
	t: ConvexTestInstance,
	asUser: Awaited<ReturnType<typeof seedOwnedThread>>['asUser'],
	threadId: Awaited<ReturnType<typeof seedOwnedThread>>['threadId']
) {
	const executionSecret = `browser-task-secret-${Math.random()}`;
	const created = await createQueuedRun(
		asUser,
		threadId,
		`browser-task-${Math.random()}`,
		executionSecret
	);
	const claimId = 'browser-task-claim';
	await t.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId,
		executionSecret
	});
	return { runId: created.runId, claimId, executionSecret };
}

let restoreStagehandFactory: () => void;

beforeEach(() => {
	restoreStagehandFactory = bindStagehandFactory((options) => {
		stagehandOptions.push(options);
		return {
			init,
			close,
			act,
			observe,
			extract,
			browserbaseSessionId: 'bb-session-task',
			context: { pages: () => [{ goto }] }
		};
	});
});

afterEach(() => {
	vi.clearAllMocks();
	stagehandOptions.length = 0;
	restoreStagehandFactory();
	delete process.env.BROWSERBASE_API_KEY;
	delete process.env.BROWSERBASE_PROJECT_ID;
	delete process.env.OPENAI_API_KEY;
});

describe('browserAgent', () => {
	it('drives the browser via the sub-agent and persists the shared session', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		process.env.OPENAI_API_KEY = 'openai_key';
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const run = await startRun(t, asUser, threadId);

		const out = await t.action(api.browserAgent.act, {
			instruction: 'add the part to cart and stop at the payment form',
			startUrl: 'https://shop.example',
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		});

		expect(init).toHaveBeenCalled();
		expect(goto).toHaveBeenCalledWith('https://shop.example');
		expect(act).toHaveBeenCalledWith('add the part to cart and stop at the payment form');
		expect(close).toHaveBeenCalled();
		expect(out).toMatchObject({ truncated: false });
		expect(out.text).toContain('Action performed');

		// First call in a thread creates a long-lived keep-alive session.
		expect(stagehandOptions.at(-1)).toMatchObject({
			keepAlive: true,
			browserbaseSessionCreateParams: { keepAlive: true, timeout: 3600 }
		});
		expect(stagehandOptions.at(-1)).not.toHaveProperty('browserbaseSessionID');

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('browserSessions')
				.withIndex('by_thread', (query) => query.eq('threadId', threadId))
				.collect()
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			browserbaseSessionId: 'bb-session-task',
			liveViewUrl: LIVE_VIEW_URL
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.browserbase.com/v1/sessions/bb-session-task/debug',
			expect.objectContaining({ headers: { 'x-bb-api-key': 'bb_key' } })
		);

		// A later run in the same thread resumes the same Browserbase session.
		await t.run(async (ctx) => await ctx.db.patch('runs', run.runId, { status: 'completed' }));
		const secondRun = await startRun(t, asUser, threadId);
		await t.action(api.browserAgent.act, {
			instruction: 'continue on the same page',
			runId: secondRun.runId,
			claimId: secondRun.claimId,
			executionSecret: secondRun.executionSecret
		});
		expect(stagehandOptions.at(-1)).toMatchObject({
			browserbaseSessionID: 'bb-session-task'
		});

		const afterResume = await t.run(async (ctx) =>
			ctx.db
				.query('browserSessions')
				.withIndex('by_thread', (query) => query.eq('threadId', threadId))
				.collect()
		);
		expect(afterResume).toHaveLength(1);
		// Resuming the session in a new run marks that run as the browser user.
		expect(afterResume[0].lastUsedRunId).toBe(secondRun.runId);
		// The stored live view URL is reused, not refetched.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('still records the session when the live view URL fetch fails', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		process.env.OPENAI_API_KEY = 'openai_key';
		fetchMock.mockRejectedValueOnce(new Error('browserbase debug endpoint down'));
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const run = await startRun(t, asUser, threadId);

		const out = await t.action(api.browserAgent.act, {
			instruction: 'browse anyway',
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		});
		expect(out.text).toContain('Action performed');

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('browserSessions')
				.withIndex('by_thread', (query) => query.eq('threadId', threadId))
				.first()
		);
		expect(stored).toMatchObject({
			browserbaseSessionId: 'bb-session-task',
			lastUsedRunId: run.runId
		});
		expect(stored?.liveViewUrl).toBeUndefined();
	});

	it('backfills the live view URL for a session row missing it', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		process.env.OPENAI_API_KEY = 'openai_key';
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const run = await startRun(t, asUser, threadId);
		await t.run(async (ctx) => {
			const thread = await ctx.db.get('threadRecords', threadId);
			await ctx.db.insert('browserSessions', {
				threadId,
				runId: run.runId,
				lastUsedRunId: run.runId,
				userId: thread!.userId,
				browserbaseSessionId: 'bb-session-task',
				startedAt: Date.now()
			});
		});

		await t.action(api.browserAgent.act, {
			instruction: 'keep browsing',
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		});

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('browserSessions')
				.withIndex('by_thread', (query) => query.eq('threadId', threadId))
				.first()
		);
		expect(stored?.liveViewUrl).toBe(LIVE_VIEW_URL);
	});

	it('observe returns candidate actions, act runs one, extract reads page data', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		process.env.OPENAI_API_KEY = 'openai_key';
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const run = await startRun(t, asUser, threadId);
		const auth = {
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		};

		const observed = await t.action(api.browserAgent.observe, {
			instruction: 'find the pay button',
			...auth
		});
		expect(observe).toHaveBeenCalledWith('find the pay button');
		expect(observed.actions).toEqual([
			{ selector: '#pay', description: 'Pay button', method: 'click', arguments: [] }
		]);

		const acted = await t.action(api.browserAgent.act, {
			action: { selector: '#pay', description: 'Pay button', method: 'click', arguments: [] },
			...auth
		});
		expect(act).toHaveBeenCalledWith({
			selector: '#pay',
			description: 'Pay button',
			method: 'click',
			arguments: []
		});
		expect(acted.text).toContain('Action performed');

		const extracted = await t.action(api.browserAgent.extract, {
			instruction: 'read the order total',
			...auth
		});
		expect(extract).toHaveBeenCalledWith('read the order total');
		expect(extracted.text).toContain('1,240');
	});

	it('bounds the actions payload and marks it truncated for a hostile page', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		process.env.OPENAI_API_KEY = 'openai_key';
		// A page that makes Stagehand return thousands of actions.
		observe.mockResolvedValueOnce(
			Array.from({ length: 5_000 }, (_, index) => ({
				selector: `#el-${index}`,
				description: `Element ${index} with a long description to inflate the payload size`,
				method: 'click',
				arguments: []
			}))
		);
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const run = await startRun(t, asUser, threadId);

		const observed = await t.action(api.browserAgent.observe, {
			instruction: 'find everything',
			runId: run.runId,
			claimId: run.claimId,
			executionSecret: run.executionSecret
		});

		expect(observed.truncated).toBe(true);
		// The structured array itself is bounded, not just its text mirror.
		expect(observed.actions.length).toBeLessThanOrEqual(50);
		expect(JSON.stringify(observed.actions).length).toBeLessThanOrEqual(8_000);
		expect(observed.text.length).toBeLessThanOrEqual(8_100);
	});
});
