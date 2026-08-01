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
vi.mock('@browserbasehq/stagehand', () => ({
	Stagehand: class {
		init = init;
		close = close;
		act = act;
		observe = observe;
		extract = extract;
		browserbaseSessionId = 'bb-session-task';
		context = { pages: () => [{ goto }] };
	}
}));

async function startRun(t: ConvexTestInstance) {
	const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
	const executionSecret = 'browser-task-secret';
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
		const run = await startRun(t);

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

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('browserSessions')
				.withIndex('by_run', (query) => query.eq('runId', run.runId))
				.collect()
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ browserbaseSessionId: 'bb-session-task' });
	});

	it('observe returns candidate actions, act runs one, extract reads page data', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		process.env.OPENAI_API_KEY = 'openai_key';
		const t = initConvexTest();
		const run = await startRun(t);
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
});
