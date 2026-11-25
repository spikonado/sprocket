import { expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedThreadRecord, type ConvexTestInstance } from './test.setup';

const DAY_MS = 24 * 60 * 60 * 1000;

async function scheduledCaptures(t: ConvexTestInstance) {
	const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

	return scheduled
		.filter((job) => job.name.endsWith('lib:capture'))
		.map((job) => {
			const [args] = job.args;

			return { distinctId: args.distinctId, event: args.event, ...JSON.parse(args.properties) };
		});
}

it('sends per-user daily token usage and thread counts', async () => {
	const t = initConvexTest();
	const now = Date.now();
	const dayStart = now - (now % DAY_MS);
	await seedThreadRecord(t, 'user_alice', 'alpha');
	await seedThreadRecord(t, 'user_alice', 'alpha');
	await seedThreadRecord(t, 'user_bob', 'alpha');

	const counts = {
		inputTokens: 100,
		cacheReadTokens: 40,
		cacheWriteTokens: 0,
		outputTokens: 10,
		reasoningTokens: 5
	};

	await t.run((ctx) =>
		ctx.db.insert('userTokenUsage', {
			userId: 'user_alice',
			granularity: 'day',
			bucketStart: dayStart,
			provider: 'spikonado',
			model: 'gpt-5.6-sol',
			serviceTier: 'standard',
			cacheWriteTtl: null,
			calls: 3,
			standard: counts,
			longContext: { ...counts, inputTokens: 1 }
		})
	);

	await t.mutation(internal.analytics.sendDailyTokenUsage, { dayStart, cursor: null });
	await t.mutation(internal.analytics.sendDailyThreadsCreated, { dayStart, cursor: null });

	expect(await scheduledCaptures(t)).toEqual([
		expect.objectContaining({
			distinctId: 'user_alice',
			event: 'daily_token_usage',
			model: 'gpt-5.6-sol',
			calls: 3,
			input_tokens: 101,
			output_tokens: 20
		}),
		expect.objectContaining({ distinctId: 'user_alice', event: 'daily_threads_created', count: 2 }),
		expect.objectContaining({ distinctId: 'user_bob', event: 'daily_threads_created', count: 1 })
	]);
});
