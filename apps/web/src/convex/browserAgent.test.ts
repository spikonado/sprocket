import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

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
const stagehandOptions: Record<string, unknown>[] = [];
vi.mock('@browserbasehq/stagehand', () => ({
	Stagehand: class {
		constructor(options: Record<string, unknown>) {
			stagehandOptions.push(options);
		}
		init = init;
		close = close;
		act = act;
		observe = observe;
		extract = extract;
		browserbaseSessionId = 'bb-session-task';
		context = { pages: () => [{ goto }] };
	}
}));

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

afterEach(() => {
	vi.clearAllMocks();
	stagehandOptions.length = 0;
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
		expect(String((out as { text: string }).text)).toContain('Action performed');

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
		expect(stored[0]).toMatchObject({ browserbaseSessionId: 'bb-session-task' });

		// A later run in the same thread resumes the same Browserbase session.
		await t.run(async (ctx) => await ctx.db.patch(run.runId, { status: 'completed' }));
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
		expect(String((acted as { text: string }).text)).toContain('Action performed');

		const extracted = await t.action(api.browserAgent.extract, {
			instruction: 'read the order total',
			...auth
		});
		expect(extract).toHaveBeenCalledWith('read the order total');
		expect(String((extracted as { text: string }).text)).toContain('1,240');
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
