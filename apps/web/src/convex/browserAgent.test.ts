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
const init = vi.fn().mockResolvedValue(undefined);
const close = vi.fn().mockResolvedValue(undefined);
const goto = vi.fn().mockResolvedValue(undefined);
vi.mock('@browserbasehq/stagehand', () => ({
	Stagehand: class {
		init = init;
		close = close;
		act = act;
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
});

describe('browserAgent.runTask', () => {
	it('drives the browser via the sub-agent and persists the session for the executor', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		const t = initConvexTest();
		const run = await startRun(t);

		const out = await t.action(api.browserAgent.runTask, {
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
});
