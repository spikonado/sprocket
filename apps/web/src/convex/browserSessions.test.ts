import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

async function startRun(t: ConvexTestInstance) {
	const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
	const executionSecret = 'browser-session-secret';
	const created = await createQueuedRun(
		asUser,
		threadId,
		`browser-session-${Math.random()}`,
		executionSecret
	);
	const claimId = 'browser-session-claim';
	await t.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId,
		executionSecret
	});
	return { runId: created.runId, claimId, executionSecret };
}

function jsonResponse(value: unknown) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.BROWSERBASE_API_KEY;
	delete process.env.BROWSERBASE_PROJECT_ID;
});

describe('browserSessions.start', () => {
	it('reuses the run session and never persists its credential-bearing connect URL', async () => {
		process.env.BROWSERBASE_API_KEY = 'bb_secret_key';
		process.env.BROWSERBASE_PROJECT_ID = 'project-1';
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					id: 'bb-session-1',
					connectUrl: 'wss://connect.browserbase.com/?apiKey=bb_secret_key&sessionId=bb-session-1'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					debuggerFullscreenUrl: 'https://www.browserbase.com/debug/bb-session-1',
					debuggerUrl: 'https://www.browserbase.com/debug/bb-session-1?navbar=true',
					pages: [],
					wsUrl: 'wss://debug.browserbase.com/bb-session-1'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					id: 'bb-session-1',
					status: 'RUNNING',
					connectUrl: 'wss://connect.browserbase.com/?apiKey=bb_secret_key&sessionId=bb-session-1'
				})
			);
		vi.stubGlobal('fetch', fetchMock);
		const t = initConvexTest();
		const run = await startRun(t);

		const first = await t.action(api.browserSessions.start, run);
		const second = await t.action(api.browserSessions.start, run);

		expect(first).toEqual({
			connectUrl: 'wss://connect.browserbase.com/?apiKey=bb_secret_key&sessionId=bb-session-1',
			liveViewUrl: 'https://www.browserbase.com/debug/bb-session-1'
		});
		expect(second).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.browserbase.com/v1/sessions');
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
			projectId: 'project-1',
			keepAlive: true
		});
		expect(fetchMock.mock.calls[1][0]).toBe(
			'https://api.browserbase.com/v1/sessions/bb-session-1/debug'
		);
		expect(fetchMock.mock.calls[2][0]).toBe('https://api.browserbase.com/v1/sessions/bb-session-1');

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('browserSessions')
				.withIndex('by_run', (query) => query.eq('runId', run.runId))
				.collect()
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			runId: run.runId,
			userId: 'user_alice',
			browserbaseSessionId: 'bb-session-1',
			liveViewUrl: 'https://www.browserbase.com/debug/bb-session-1'
		});
		expect(stored[0]).not.toHaveProperty('connectUrl');
		expect(JSON.stringify(stored[0])).not.toContain('bb_secret_key');
	});
});
