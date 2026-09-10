import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import {
	interact as executeInteract,
	screenshot as executeScreenshot
} from '@convex/firecrawlBrowser';
import type { FunctionArgs } from 'convex/server';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

async function interact(
	t: ConvexTestInstance,
	args: FunctionArgs<typeof api.browserAgent.interact>
) {
	return t.action(async (ctx) => {
		const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
			runId: args.runId,
			executionSecret: args.executionSecret
		});
		return executeInteract(ctx, { ...args, ...actor });
	});
}

async function screenshot(
	t: ConvexTestInstance,
	args: FunctionArgs<typeof api.browserAgent.screenshot>
) {
	return t.action(async (ctx) => {
		const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
			runId: args.runId,
			executionSecret: args.executionSecret
		});
		return executeScreenshot(ctx, { ...args, ...actor });
	});
}

async function fixture(t: ConvexTestInstance, userId = 'browser-user') {
	const { asUser, threadId } = await seedOwnedThread(t, userId);
	const executionSecret = crypto.randomUUID();
	const { runId } = await createQueuedRun(
		t,
		asUser,
		threadId,
		crypto.randomUUID(),
		executionSecret
	);
	const claimId = crypto.randomUUID();
	await t.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });
	return { asUser, threadId, userId, runId, claimId, executionSecret };
}

function remote() {
	process.env.FIRECRAWL_BROWSER_API_KEY = 'test-key';
	let sequence = 0;
	const fetch = vi.fn(async (_url: string, options: RequestInit) => {
		const body = options.body ? JSON.parse(String(options.body)) : {};
		return new Response(
			JSON.stringify(
				body.profile
					? {
							success: true,
							id: `session-${++sequence}`,
							expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
							liveViewUrl: 'https://view.example/passive',
							interactiveLiveViewUrl: 'https://view.example/interactive'
						}
					: { success: true, stdout: 'Done', result: 'Done', exitCode: 0, killed: false }
			)
		);
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	delete process.env.FIRECRAWL_BROWSER_API_KEY;
});

describe('Firecrawl browser lifecycle', () => {
	it('holds both slots across idle sessions and releases a slot only after confirmed deletion', async () => {
		vi.useFakeTimers();
		const fetch = remote();
		const t = initConvexTest();
		const first = await fixture(t, 'first');
		const second = await fixture(t, 'second');
		const third = await fixture(t, 'third');
		await interact(t, { ...first, command: 'agent-browser get url' });
		await interact(t, { ...second, command: 'agent-browser get url' });
		await expect(interact(t, { ...third, command: 'agent-browser get url' })).rejects.toThrow(
			'Both browser session slots are in use'
		);
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(await t.run((ctx) => ctx.db.query('browserCapacity').collect())).toHaveLength(2);
		const session = await t.run((ctx) =>
			ctx.db
				.query('browserSessions')
				.withIndex('by_threadId', (q) => q.eq('threadId', first.threadId))
				.unique()
		);
		fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
		await first.asUser.mutation(api.browserSessions.stop, {
			id: session!._id,
			providerSessionId: session!.sessionId!
		});
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.query('browserCapacity').collect())).toHaveLength(2);
		await expect(interact(t, { ...third, command: 'agent-browser get url' })).rejects.toThrow(
			'Both browser session slots are in use'
		);
		await vi.advanceTimersByTimeAsync(60_000);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.query('browserCapacity').collect())).toHaveLength(1);
		await interact(t, { ...third, command: 'agent-browser get url' });
		expect(await t.run((ctx) => ctx.db.query('browserCapacity').collect())).toHaveLength(2);
	});

	it('keeps unknown creations reserved until the provider hard lifetime has passed', async () => {
		vi.useFakeTimers();
		const fetch = remote().mockRejectedValue(new Error('connection lost'));
		const t = initConvexTest();
		const auth = await fixture(t);
		for (let i = 0; i < 2; i++)
			await expect(interact(t, { ...auth, command: 'agent-browser click @e1' })).rejects.toThrow();
		await expect(interact(t, { ...auth, command: 'agent-browser click @e1' })).rejects.toThrow(
			'Both browser session slots are in use'
		);
		expect(fetch).toHaveBeenCalledTimes(2);
		const slots = await t.run((ctx) => ctx.db.query('browserCapacity').collect());
		expect(slots).toHaveLength(2);
		expect(slots.every((slot) => slot.sessionId === undefined)).toBe(true);
		vi.setSystemTime(slots[0].expiresAt - 1);
		await expect(
			t.mutation(internal.browserCapacity.reserve, {
				reservationId: 'new',
				expiresAt: Date.now() + 1_000
			})
		).rejects.toThrow('Both browser session slots are in use');
		vi.setSystemTime(slots[0].expiresAt);
		await t.mutation(internal.browserCapacity.expire, {});
		expect(await t.run((ctx) => ctx.db.query('browserCapacity').collect())).toEqual([]);
	});

	it('leaves a reader intact when no slot is available for a saving replacement', async () => {
		const fetch = remote().mockResolvedValueOnce(new Response('{}', { status: 409 }));
		const t = initConvexTest();
		const first = await fixture(t, 'reader');
		const second = await fixture(t, 'other');
		await interact(t, { ...first, command: 'agent-browser get url' });
		await interact(t, { ...second, command: 'agent-browser get url' });
		await expect(
			interact(t, { ...first, command: 'agent-browser click @e1', enforce_saving: true })
		).rejects.toThrow('Both browser session slots are in use');
		expect(fetch).toHaveBeenCalledTimes(5);
		expect(fetch.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('browserSessions')
					.withIndex('by_threadId', (q) => q.eq('threadId', first.threadId))
					.unique()
			)
		).toMatchObject({ sessionId: 'session-1', saveChanges: false, closing: false });
	});

	it('falls back to a reader only after a confirmed writer conflict', async () => {
		const fetch = remote().mockResolvedValueOnce(new Response('{}', { status: 409 }));
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await interact(t, {
			runId,
			claimId,
			executionSecret,
			command: 'agent-browser get url'
		});
		const requests = fetch.mock.calls.map(([, options]) => JSON.parse(String(options.body)));
		expect(requests.map((body) => body.profile?.saveChanges)).toEqual([true, false, undefined]);
		expect(await t.run((ctx) => ctx.db.query('browserSessions').unique())).toMatchObject({
			saveChanges: false
		});
	});

	it.each([503, 'timeout'] as const)(
		'does not retry uncertain creation or fall back after %s',
		async (failure) => {
			const fetch = remote();
			if (failure === 'timeout') fetch.mockRejectedValueOnce(new Error('timeout'));
			else fetch.mockResolvedValueOnce(new Response('{}', { status: failure }));
			const t = initConvexTest();
			const { runId, claimId, executionSecret } = await fixture(t);
			await expect(
				interact(t, {
					runId,
					claimId,
					executionSecret,
					command: 'agent-browser click @e1'
				})
			).rejects.toThrow();
			expect(fetch).toHaveBeenCalledTimes(1);
		}
	);

	it('rejects enforcement when saving is disabled before creating any session', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await fixture(t);
		await asUser.mutation(api.browserProfiles.setSaving, { enabled: false });
		await expect(
			interact(t, {
				runId,
				claimId,
				executionSecret,
				command: 'agent-browser open https://example.com',
				enforce_saving: true
			})
		).rejects.toThrow('browser saving is disabled in Settings');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('opens a saving replacement before closing the reader and executes only in the replacement', async () => {
		vi.useFakeTimers();
		const fetch = remote().mockResolvedValueOnce(new Response('{}', { status: 409 }));
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
		await interact(t, args);
		const reader = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		vi.setSystemTime(Date.now() + 1_000);
		await interact(t, { ...args, enforce_saving: true });
		const writer = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		expect(writer).toMatchObject({ _id: reader!._id, sessionId: 'session-2', saveChanges: true });
		expect(writer!.startedAt).toBeGreaterThan(reader!.startedAt);
		expect(writer!.expiresAt).toBe(writer!.startedAt + 3_600_000);
		expect(fetch.mock.calls[3][1].body).toContain('"saveChanges":true');
		expect(fetch.mock.calls[4][0]).toContain('/session-2/execute');
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		expect(
			fetch.mock.calls.filter(([, options]) => options.method === 'DELETE').map(([url]) => url)
		).toEqual(['https://api.firecrawl.dev/v2/interact/session-1']);
		await interact(t, { ...args, enforce_saving: true });
		expect(
			fetch.mock.calls.filter(([, options]) => options.body?.toString().includes('"profile"'))
		).toHaveLength(3);
	});

	it.each([409, 429])(
		'leaves the reader intact when a saving replacement returns %s',
		async (status) => {
			const fetch = remote().mockResolvedValueOnce(new Response('{}', { status: 409 }));
			const t = initConvexTest();
			const { runId, claimId, executionSecret } = await fixture(t);
			const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
			await interact(t, args);
			fetch.mockResolvedValueOnce(new Response('{}', { status }));
			await expect(interact(t, { ...args, enforce_saving: true })).rejects.toThrow(
				status === 409
					? "Saving can't be enforced currently as the main browser session is in use by another agent. Ask the user whether they want the cookies and login state saved for future use. If yes, they have to stop the other agent and its browser session."
					: 'A request-rate or concurrency limit was reached.'
			);
			expect(fetch).toHaveBeenCalledTimes(4);
			expect(await t.run((ctx) => ctx.db.query('browserSessions').unique())).toMatchObject({
				sessionId: 'session-1',
				saveChanges: false,
				closing: false,
				operationExpiresAt: 0
			});
			await interact(t, args);
			expect(fetch.mock.lastCall?.[0]).toContain('/session-1/execute');
			expect(fetch.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false);
		}
	);

	it.each(['saving disabled', 'cancelled', 'reset'])(
		'discards an upgrade without executing when %s during creation',
		async (change) => {
			vi.useFakeTimers();
			const fetch = remote().mockResolvedValueOnce(new Response('{}', { status: 409 }));
			const t = initConvexTest();
			const { asUser, runId, claimId, executionSecret } = await fixture(t);
			const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
			await interact(t, args);
			fetch.mockImplementationOnce(async () => {
				if (change === 'saving disabled')
					await asUser.mutation(api.browserProfiles.setSaving, { enabled: false });
				else if (change === 'reset') await asUser.mutation(api.browserProfiles.reset, {});
				else
					await t.run((ctx) =>
						ctx.db.patch('runs', runId, { cancellationRequestedAt: Date.now() })
					);
				return new Response(JSON.stringify({ success: true, id: 'unwanted-writer' }));
			});
			await expect(interact(t, { ...args, enforce_saving: true })).rejects.toThrow('No action ran');
			expect(await t.run((ctx) => ctx.db.query('browserSessions').unique())).toMatchObject({
				sessionId: 'session-1',
				saveChanges: false
			});
			await vi.advanceTimersByTimeAsync(0);
			await t.finishInProgressScheduledFunctions();
			expect(fetch.mock.calls.filter(([url]) => url.endsWith('/execute'))).toHaveLength(1);
			expect(
				fetch.mock.calls.some(
					([url, options]) => url.endsWith('/unwanted-writer') && options.method === 'DELETE'
				)
			).toBe(true);
		}
	);

	it('clears old live-view URLs and retries closing only the replaced provider session', async () => {
		vi.useFakeTimers();
		const fetch = remote().mockResolvedValueOnce(new Response('{}', { status: 409 }));
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
		await interact(t, args);
		fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, id: 'writer' })));
		await interact(t, { ...args, enforce_saving: true });
		const writer = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		expect(writer?.liveViewUrl).toBeUndefined();
		expect(writer?.interactiveLiveViewUrl).toBeUndefined();
		fetch.mockResolvedValueOnce(new Response('{}', { status: 429 }));
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		await vi.advanceTimersByTimeAsync(60_000);
		await t.finishInProgressScheduledFunctions();
		expect(
			fetch.mock.calls.filter(([, options]) => options.method === 'DELETE').map(([url]) => url)
		).toEqual([
			'https://api.firecrawl.dev/v2/interact/session-1',
			'https://api.firecrawl.dev/v2/interact/session-1'
		]);
		expect((await t.run((ctx) => ctx.db.query('browserSessions').unique()))?.sessionId).toBe(
			'writer'
		);
	});

	it.each([false, true])('fences a user stop during creation, replacing=%s', async (replacing) => {
		vi.useFakeTimers();
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser click @e1' };
		if (replacing) {
			fetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
			await interact(t, args);
		}
		fetch.mockImplementationOnce(async () => {
			const session = await t.run((ctx) => ctx.db.query('browserSessions').unique());
			await asUser.mutation(api.browserSessions.stop, {
				id: session!._id,
				providerSessionId: session!.sessionId ?? null
			});
			return new Response(JSON.stringify({ success: true, id: 'late-session' }));
		});
		await expect(interact(t, { ...args, enforce_saving: true })).rejects.toThrow('No action ran');
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		expect(fetch.mock.calls.filter(([url]) => url.endsWith('/execute'))).toHaveLength(
			replacing ? 1 : 0
		);
		expect(
			fetch.mock.calls.some(
				([url, options]) => url.endsWith('/late-session') && options.method === 'DELETE'
			)
		).toBe(true);
		expect(await t.run((ctx) => ctx.db.query('browserSessions').unique())).toBeNull();
		expect(
			(await t.run((ctx) => ctx.db.get('runs', runId)))?.cancellationRequestedAt
		).toBeUndefined();
	});

	it('stops an in-flight browser operation without cancelling the run and allows a later session', async () => {
		vi.useFakeTimers();
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
		await interact(t, args);
		const session = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		fetch.mockImplementationOnce(async () => {
			await asUser.mutation(api.browserSessions.stop, {
				id: session!._id,
				providerSessionId: session!.sessionId ?? null
			});
			throw new Error('Browser disconnected');
		});
		await expect(interact(t, args)).rejects.toThrow('Do not repeat purchases');
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.get('browserSessions', session!._id))).toBeNull();
		expect(
			(await t.run((ctx) => ctx.db.get('runs', runId)))?.cancellationRequestedAt
		).toBeUndefined();
		await interact(t, args);
		const next = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		expect(next?.sessionId).toBe('session-2');
		await asUser.mutation(api.browserSessions.stop, {
			id: session!._id,
			providerSessionId: session!.sessionId ?? null
		});
		expect((await t.run((ctx) => ctx.db.get('browserSessions', next!._id)))?.closing).toBe(false);
	});

	it.each(['initial attachment', 'saving upgrade'])(
		'ignores a delayed stop after %s on the same row',
		async (transition) => {
			vi.useFakeTimers();
			const fetch = remote();
			const t = initConvexTest();
			const { asUser, userId, threadId, runId, claimId, executionSecret } = await fixture(t);
			const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
			const replacing = transition === 'saving upgrade';
			if (replacing) {
				fetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
				await interact(t, args);
			} else {
				await t.mutation(internal.browserSessions.acquire, {
					userId,
					threadId,
					runId,
					claimId,
					operationId: 'creating'
				});
			}
			const displayed = await asUser.query(api.browserSessions.liveViewForThread, { threadId });
			expect(displayed!.providerSessionId).toBe(replacing ? 'session-1' : null);
			if (replacing) {
				await interact(t, { ...args, enforce_saving: true });
			} else {
				expect(
					await t.mutation(internal.browserSessions.attach, {
						id: displayed!.id,
						operationId: 'creating',
						claimId,
						sessionId: 'session-2',
						saveChanges: true,
						startedAt: displayed!.startedAt,
						expiresAt: displayed!.expiresAt
					})
				).toBe(true);
			}
			const attached = await t.run((ctx) => ctx.db.get('browserSessions', displayed!.id));
			expect(attached).toMatchObject({
				sessionId: 'session-2',
				saveChanges: true,
				closing: false,
				startedAt: displayed!.startedAt
			});
			await asUser.mutation(api.browserSessions.stop, {
				id: displayed!.id,
				providerSessionId: displayed!.providerSessionId
			});
			await vi.advanceTimersByTimeAsync(0);
			await t.finishInProgressScheduledFunctions();
			expect(await t.run((ctx) => ctx.db.get('browserSessions', displayed!.id))).toEqual(attached);
			expect(
				fetch.mock.calls.filter(([, options]) => options.method === 'DELETE').map(([url]) => url)
			).toEqual(replacing ? ['https://api.firecrawl.dev/v2/interact/session-1'] : []);
			const current = await asUser.query(api.browserSessions.liveViewForThread, { threadId });
			await asUser.mutation(api.browserSessions.stop, {
				id: current!.id,
				providerSessionId: current!.providerSessionId
			});
			await vi.advanceTimersByTimeAsync(0);
			await t.finishInProgressScheduledFunctions();
			expect(await t.run((ctx) => ctx.db.get('browserSessions', displayed!.id))).toBeNull();
			expect(fetch.mock.lastCall?.[0]).toBe('https://api.firecrawl.dev/v2/interact/session-2');
			expect(fetch.mock.lastCall?.[1].method).toBe('DELETE');
		}
	);

	it.each([
		'agent-browser help',
		'agent-browser --json screenshot',
		'agent-browser fill @e1 "$(touch /tmp/owned); echo secret"'
	])('forwards %s to Firecrawl unchanged', async (command) => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await interact(t, { runId, claimId, executionSecret, command });
		expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toMatchObject({
			code: command,
			language: 'bash'
		});
	});

	it('does not discard an attached session when its attachment acknowledgement is lost', async () => {
		vi.useFakeTimers();
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await interact(t, {
			runId,
			claimId,
			executionSecret,
			command: 'agent-browser get url'
		});
		const session = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		await t.mutation(internal.browserSessions.discardUnattached, {
			id: session!._id,
			sessionId: session!.sessionId!,
			expiresAt: session!.expiresAt
		});
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		expect(fetch).toHaveBeenCalledTimes(2);
		await t.mutation(internal.browserSessions.discardUnattached, {
			id: session!._id,
			sessionId: 'unattached',
			expiresAt: session!.expiresAt
		});
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		expect(fetch.mock.lastCall?.[0]).toContain('/unattached');
		expect(fetch.mock.lastCall?.[1].method).toBe('DELETE');
		expect((await t.run((ctx) => ctx.db.get('browserSessions', session!._id)))?.sessionId).toBe(
			session!.sessionId
		);
	});

	it('rejects cancellation before acquisition and before execution', async () => {
		const t = initConvexTest();
		const { userId, threadId, runId, claimId } = await fixture(t);
		const args = { userId, threadId, runId, claimId, operationId: 'cancelled' };
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { cancellationRequestedAt: Date.now() });
		});
		await expect(t.mutation(internal.browserSessions.acquire, args)).rejects.toThrow();
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { cancellationRequestedAt: undefined });
		});
		const session = await t.mutation(internal.browserSessions.acquire, args);
		await t.mutation(internal.browserSessions.attach, {
			id: session._id,
			operationId: args.operationId,
			claimId,
			sessionId: 'remote',
			saveChanges: true,
			startedAt: session.startedAt,
			expiresAt: Date.now() + 3_600_000
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { cancellationRequestedAt: Date.now() });
		});
		await expect(
			t.mutation(internal.browserSessions.beforeExecute, {
				id: session._id,
				operationId: args.operationId,
				runId,
				claimId
			})
		).rejects.toThrow();
	});

	it('shares one user profile across conversations but not live sessions', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const first = await fixture(t);
		const second = await fixture(t);
		for (const run of [first, second]) {
			const { runId, claimId, executionSecret } = run;
			expect(
				await interact(t, {
					runId,
					claimId,
					executionSecret,
					command: 'agent-browser get url'
				})
			).toEqual({ text: 'Done', truncated: false });
		}
		const rows = await t.run((ctx) => ctx.db.query('browserSessions').collect());
		expect(rows).toHaveLength(2);
		expect(rows[0].profileName).toBe(rows[1].profileName);
		expect(rows[0].sessionId).not.toBe(rows[1].sessionId);
		const createBodies = fetch.mock.calls
			.map(([, options]) => JSON.parse(String(options.body)))
			.filter((body) => body.profile);
		expect(createBodies).toHaveLength(2);
		expect(createBodies[0]).toMatchObject({
			ttl: 3600,
			activityTtl: 450,
			profile: { saveChanges: true }
		});
	});

	it('caps provider expiry at the reserved one-hour deadline', async () => {
		remote().mockResolvedValueOnce(
			new Response(JSON.stringify({ success: true, id: 'long-lived', expiresAt: '2099-01-01' }))
		);
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await interact(t, {
			runId,
			claimId,
			executionSecret,
			command: 'agent-browser get url'
		});
		const session = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		expect(session?.expiresAt).toBe((session?.startedAt ?? 0) + 3_600_000);
	});

	it('reports enforced writer contention without executing a command or falling back', async () => {
		const fetch = remote().mockResolvedValue(new Response('{}', { status: 409 }));
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await expect(
			interact(t, {
				runId,
				claimId,
				executionSecret,
				command: 'agent-browser click @e1',
				enforce_saving: true
			})
		).rejects.toThrow(
			"Saving can't be enforced currently as the main browser session is in use by another agent. Ask the user whether they want the cookies and login state saved for future use. If yes, they have to stop the other agent and its browser session."
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await t.run((ctx) => ctx.db.query('browserSessions').collect())).toEqual([]);
	});

	it('fixes saving mode for a session and applies preference only to new sessions', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
		await interact(t, args);
		await asUser.mutation(api.browserProfiles.setSaving, { enabled: false });
		await interact(t, args);
		await expect(interact(t, { ...args, enforce_saving: true })).rejects.toThrow(
			'browser saving is disabled in Settings'
		);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(await t.run((ctx) => ctx.db.query('browserSessions').first())).toMatchObject({
			saveChanges: true
		});
	});

	it('blocks agent operations during human control, then resumes the same session', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, threadId, runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
		await interact(t, args);
		await asUser.mutation(api.browserProfiles.setHumanControl, { threadId, enabled: true });
		await expect(interact(t, args)).rejects.toThrow(
			/^The user has control of this browser\. Ask them to give control back before browsing\.$/
		);
		expect(fetch).toHaveBeenCalledTimes(2);
		await asUser.mutation(api.browserProfiles.setHumanControl, { threadId, enabled: false });
		await interact(t, args);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('does not treat HTTP 200 with a failed command as success', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
		await interact(t, args);
		fetch.mockResolvedValue(
			new Response(JSON.stringify({ success: true, exitCode: 1, stderr: 'Command failed' }))
		);
		await expect(interact(t, args)).rejects.toThrow('Command failed');
	});

	it('fences in-flight creation when the profile is reset', async () => {
		const t = initConvexTest();
		const { asUser, userId, threadId, runId, claimId } = await fixture(t);
		const session = await t.mutation(internal.browserSessions.acquire, {
			userId,
			threadId,
			runId,
			claimId,
			operationId: 'creating'
		});
		await asUser.mutation(api.browserProfiles.reset, {});
		expect(
			await t.mutation(internal.browserSessions.attach, {
				id: session._id,
				operationId: 'creating',
				claimId,
				sessionId: 'late',
				saveChanges: true,
				startedAt: session.startedAt,
				expiresAt: Date.now() + 3_600_000
			})
		).toBe(false);
		expect(await t.run((ctx) => ctx.db.get('browserSessions', session._id))).toMatchObject({
			closing: true
		});
		expect(
			(await t.run((ctx) => ctx.db.get('browserSessions', session._id)))?.sessionId
		).toBeUndefined();
	});

	it('does not let stale reconciliation delete a newly attached session', async () => {
		const t = initConvexTest();
		const { userId, threadId, runId, claimId } = await fixture(t);
		const session = await t.mutation(internal.browserSessions.acquire, {
			userId,
			threadId,
			runId,
			claimId,
			operationId: 'new'
		});
		await t.mutation(internal.browserSessions.attach, {
			id: session._id,
			operationId: 'new',
			claimId,
			sessionId: 'remote-new',
			saveChanges: true,
			startedAt: session.startedAt,
			expiresAt: Date.now() + 3_600_000
		});
		await t.mutation(internal.browserSessions.release, { id: session._id, operationId: 'new' });
		const attached = await t.run((ctx) => ctx.db.get('browserSessions', session._id));
		await t.mutation(internal.browserSessions.reconcile, {
			ids: [session._id],
			before: attached!.attachedAt! - 1
		});
		expect(await t.run((ctx) => ctx.db.get('browserSessions', session._id))).not.toBeNull();
	});

	it('rejects takeover during an action and rejects another user', async () => {
		const t = initConvexTest();
		const { asUser, userId, threadId, runId, claimId } = await fixture(t);
		const session = await t.mutation(internal.browserSessions.acquire, {
			userId,
			threadId,
			runId,
			claimId,
			operationId: 'busy'
		});
		await t.mutation(internal.browserSessions.attach, {
			id: session._id,
			operationId: 'busy',
			claimId,
			sessionId: 'remote',
			saveChanges: true,
			startedAt: session.startedAt,
			expiresAt: Date.now() + 3_600_000
		});
		await expect(
			asUser.mutation(api.browserProfiles.setHumanControl, { threadId, enabled: true })
		).rejects.toThrow('current browser action');
		const stranger = t.withIdentity({ subject: 'stranger' });
		await expect(
			stranger.mutation(api.browserProfiles.setHumanControl, { threadId, enabled: true })
		).rejects.toThrow();
	});

	it('starts non-saving when the preference is disabled, without discarding the saved profile', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await fixture(t);
		await asUser.mutation(api.browserProfiles.setSaving, { enabled: false });
		const profile = await t.run((ctx) => ctx.db.query('browserProfiles').first());
		await interact(t, {
			runId,
			claimId,
			executionSecret,
			command: 'agent-browser get url'
		});
		expect(JSON.parse(String(fetch.mock.calls[0][1].body)).profile).toEqual({
			name: profile!.name,
			saveChanges: false
		});
	});

	it.each([68, 600_000, 600_001])(
		'writes screenshot JSON to captured stdout for a %i-byte image',
		async (byteLength) => {
			const fetch = remote();
			const t = initConvexTest();
			const { runId, claimId, executionSecret } = await fixture(t);
			const args = { runId, claimId, executionSecret };
			await interact(t, { ...args, command: 'agent-browser get url' });
			const image = Buffer.alloc(byteLength);
			image.set(Buffer.from('89504e470d0a1a0a', 'hex'));
			fetch.mockImplementation(async (_url, options) => {
				const { code, language } = JSON.parse(String(options.body));
				expect(language).toBe('node');
				let stdout = '';
				await runInNewContext(`(async () => { ${code} })()`, {
					page: {
						screenshot: async () => image,
						url: () => 'https://example.com/'
					},
					console: { log: vi.fn() },
					process: {
						stdout: {
							write: (text: string, callback?: () => void) => {
								setTimeout(() => {
									stdout += text;
									callback?.();
								}, 0);
								return false;
							}
						}
					}
				});
				return new Response(JSON.stringify({ success: true, stdout, result: '' }));
			});
			expect(await screenshot(t, args)).toEqual({
				byteLength,
				url: 'https://example.com/',
				dataBase64: byteLength <= 600_000 ? image.toString('base64') : '',
				mediaType: 'image/png',
				truncated: byteLength > 600_000
			});
		}
	);

	it('accepts screenshot JSON from stdout or a result with empty or absent stdout', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret };
		await interact(t, { ...args, command: 'agent-browser get url' });
		const dataBase64 =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBf8AAAAASUVORK5CYII=';
		const output = JSON.stringify({ dataBase64, byteLength: 68, url: 'https://example.com' });
		for (const response of [
			{ stdout: output, result: 'undefined' },
			{ result: output },
			{ stdout: null, result: output },
			{ stdout: '', result: output }
		]) {
			fetch.mockImplementation(
				async () => new Response(JSON.stringify({ success: true, ...response }))
			);
			expect(await screenshot(t, args)).toMatchObject({
				mediaType: 'image/png',
				dataBase64,
				truncated: false
			});
		}
	});

	it.each([
		['', 'Firecrawl returned empty screenshot output.'],
		[' \n', 'Firecrawl returned empty screenshot output.'],
		['{"byteLength":68,', 'Firecrawl returned malformed screenshot JSON.'],
		['{}', 'Firecrawl returned an invalid screenshot.']
	])(
		'rejects unusable screenshot output %j without replaying the capture',
		async (stdout, error) => {
			const fetch = remote();
			const t = initConvexTest();
			const { runId, claimId, executionSecret } = await fixture(t);
			const args = { runId, claimId, executionSecret };
			await interact(t, { ...args, command: 'agent-browser get url' });
			fetch.mockImplementation(async () => new Response(JSON.stringify({ success: true, stdout })));
			await expect(screenshot(t, args)).rejects.toThrow(error);
			expect(fetch).toHaveBeenCalledTimes(3);
		}
	);

	it('does not infer session death from an incomplete provider list', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await interact(t, {
			runId,
			claimId,
			executionSecret,
			command: 'agent-browser get url'
		});
		fetch.mockImplementation(
			async () => new Response(JSON.stringify({ success: true, sessions: [] }))
		);
		await t.action(internal.firecrawlBrowser.reconcile, {});
		expect(await t.run((ctx) => ctx.db.query('browserSessions').collect())).toHaveLength(1);
		const session = await t.run((ctx) => ctx.db.query('browserSessions').unique());
		await t.run((ctx) => ctx.db.patch('browserSessions', session!._id, { attachedAt: 0 }));
		fetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						sessions: [{ id: session!.sessionId, status: 'destroyed' }]
					})
				)
		);
		await t.action(internal.firecrawlBrowser.reconcile, {});
		expect(await t.run((ctx) => ctx.db.query('browserSessions').collect())).toHaveLength(0);
	});

	it('reports the provider concurrency limit without retrying creation or falling back to a reader', async () => {
		const detail = 'You have reached the maximum number of concurrent jobs (2).';
		const fetch = remote().mockResolvedValueOnce(
			new Response(JSON.stringify({ success: false, error: detail }), { status: 429 })
		);
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await expect(
			interact(t, { runId, claimId, executionSecret, command: 'agent-browser get url' })
		).rejects.toThrow(`Firecrawl request failed (HTTP 429). ${detail}`);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await t.run((ctx) => ctx.db.query('browserSessions').unique())).toBeNull();
	});

	it.each(['seconds', 'date'])(
		'keeps a rate-limited session open and reports Retry-After as %s without replaying the command',
		async (format) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
			const fetch = remote();
			const t = initConvexTest();
			const { runId, claimId, executionSecret } = await fixture(t);
			const args = {
				runId,
				claimId,
				executionSecret,
				command: 'agent-browser click @e1'
			};
			await interact(t, args);
			const session = await t.run((ctx) => ctx.db.query('browserSessions').unique());
			fetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: false, error: 'Rate limit exceeded.' }), {
					status: 429,
					headers: {
						'Retry-After': format === 'seconds' ? '30' : 'Thu, 10 Sep 2026 12:00:30 GMT'
					}
				})
			);
			await expect(interact(t, args)).rejects.toThrow(
				'Firecrawl request failed (HTTP 429). Rate limit exceeded. Wait at least 30 seconds before retrying. The command did not run.'
			);
			await vi.advanceTimersByTimeAsync(0);
			await t.finishInProgressScheduledFunctions();
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(await t.run((ctx) => ctx.db.query('browserSessions').unique())).toEqual(session);
			await interact(t, args);
			expect(fetch).toHaveBeenCalledTimes(4);
			expect(fetch.mock.lastCall?.[0]).toContain('/session-1/execute');
		}
	);

	it.each([
		['<html>Too many requests</html>', 'invalid'],
		[JSON.stringify({ success: false, error: { unexpected: true } }), '-1'],
		['', ''],
		['x'.repeat(2_000_001), 'Infinity']
	])('preserves the 429 status when error data is unusable, case %#', async (body, retryAfter) => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'agent-browser get url' };
		await interact(t, args);
		fetch.mockResolvedValueOnce(
			new Response(body, { status: 429, headers: { 'Retry-After': retryAfter } })
		);
		await expect(interact(t, args)).rejects.toThrow(
			/^Firecrawl request failed \(HTTP 429\)\. A request-rate or concurrency limit was reached\. The command did not run\.$/
		);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(await t.run((ctx) => ctx.db.query('browserSessions').unique())).toMatchObject({
			closing: false,
			operationExpiresAt: 0
		});
	});

	it.each(['connection reset', 503] as const)(
		'quarantines uncertain execution after %s without replaying it',
		async (failure) => {
			const fetch = remote();
			const t = initConvexTest();
			const { runId, claimId, executionSecret } = await fixture(t);
			const args = {
				runId,
				claimId,
				executionSecret,
				command: 'agent-browser click @e1'
			};
			await interact(t, args);
			if (failure === 'connection reset') fetch.mockRejectedValue(new Error('Connection reset'));
			else
				fetch.mockResolvedValue(
					new Response(JSON.stringify({ success: false, error: 'Unavailable' }), {
						status: failure
					})
				);
			await expect(interact(t, args)).rejects.toThrow(
				/^The provider did not confirm whether the command completed\. The session is closing\. Do not repeat purchases, messages, or other actions without checking their outcome first\.$/
			);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(await t.run((ctx) => ctx.db.query('browserSessions').first())).toMatchObject({
				closing: true
			});
			await expect(interact(t, args)).rejects.toThrow(/^The browser is closing\. Retry shortly\.$/);
			await expect(screenshot(t, { runId, claimId, executionSecret })).rejects.toThrow(
				/^The browser is closing\. Retry shortly\.$/
			);
			expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(3);
		}
	);
});
