import { describe, expect, it } from 'vitest';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('convex component registration', () => {
	it('registers the five reliability components', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(t, asUser, threadId, 'component-reg', 'secret', 'Hello');
		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(run?.lifecycleWorkflowId).toEqual(expect.any(String));
	});
});
