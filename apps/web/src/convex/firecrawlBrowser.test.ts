import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import '@convex/browserAgent';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from '@convex/test.setup';

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
	process.env.FIRECRAWL_API_KEY = 'test-key';
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
	delete process.env.FIRECRAWL_API_KEY;
});

describe('Firecrawl browser lifecycle', () => {
	it('rejects cancellation before acquisition and before execution', async () => {
		const t = initConvexTest();
		const { userId, threadId, runId, claimId } = await fixture(t);
		const args = { userId, threadId, runId, claimId, operationId: 'cancelled' };
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { cancellationRequestedAt: Date.now() });
		});
		await expect(t.mutation(internal.firecrawlSessions.acquire, args)).rejects.toThrow();
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { cancellationRequestedAt: undefined });
		});
		const session = await t.mutation(internal.firecrawlSessions.acquire, args);
		await t.mutation(internal.firecrawlSessions.attach, {
			id: session._id,
			operationId: args.operationId,
			sessionId: 'remote',
			expiresAt: Date.now() + 3_600_000
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { cancellationRequestedAt: Date.now() });
		});
		await expect(
			t.mutation(internal.firecrawlSessions.beforeExecute, {
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
				await t.action(api.browserAgent.interact, {
					runId,
					claimId,
					executionSecret,
					command: 'get url',
					disable_saving: true
				})
			).toEqual({ text: 'Done', truncated: false });
		}
		const rows = await t.run((ctx) => ctx.db.query('firecrawlSessions').collect());
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
			profile: { saveChanges: false }
		});
	});

	it('reports writer contention without executing a command or falling back', async () => {
		const fetch = remote().mockResolvedValue(new Response('{}', { status: 409 }));
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await expect(
			t.action(api.browserAgent.interact, { runId, claimId, executionSecret, command: 'click @e1' })
		).rejects.toThrow('profile_in_use');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await t.run((ctx) => ctx.db.query('firecrawlSessions').collect())).toEqual([]);
	});

	it('fixes saving mode for a session and applies preference only to new sessions', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'get url' };
		await t.action(api.browserAgent.interact, args);
		await asUser.mutation(api.browserProfiles.setSaving, { enabled: false });
		await t.action(api.browserAgent.interact, args);
		await expect(
			t.action(api.browserAgent.interact, { ...args, disable_saving: true })
		).rejects.toThrow('saving_mode_fixed');
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(await t.run((ctx) => ctx.db.query('firecrawlSessions').first())).toMatchObject({
			saveChanges: true
		});
	});

	it('blocks agent operations during human control, then resumes the same session', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, threadId, runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'get url' };
		await t.action(api.browserAgent.interact, args);
		await asUser.mutation(api.browserProfiles.setHumanControl, { threadId, enabled: true });
		await expect(t.action(api.browserAgent.interact, args)).rejects.toThrow('browser_in_use');
		expect(fetch).toHaveBeenCalledTimes(2);
		await asUser.mutation(api.browserProfiles.setHumanControl, { threadId, enabled: false });
		await t.action(api.browserAgent.interact, args);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('does not treat HTTP 200 with a failed command as success', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'get url' };
		await t.action(api.browserAgent.interact, args);
		fetch.mockResolvedValue(
			new Response(JSON.stringify({ success: true, exitCode: 1, stderr: 'Command failed' }))
		);
		await expect(t.action(api.browserAgent.interact, args)).rejects.toThrow('Command failed');
	});

	it('fences in-flight creation when the profile is reset', async () => {
		const t = initConvexTest();
		const { asUser, userId, threadId, runId, claimId } = await fixture(t);
		const session = await t.mutation(internal.firecrawlSessions.acquire, {
			userId,
			threadId,
			runId,
			claimId,
			operationId: 'creating'
		});
		await asUser.mutation(api.browserProfiles.reset, {});
		expect(
			await t.mutation(internal.firecrawlSessions.attach, {
				id: session._id,
				operationId: 'creating',
				sessionId: 'late',
				expiresAt: Date.now() + 3_600_000
			})
		).toBe(false);
		expect(await t.run((ctx) => ctx.db.get('firecrawlSessions', session._id))).toMatchObject({
			sessionId: 'late',
			closing: true
		});
	});

	it('does not let stale reconciliation delete a newly attached session', async () => {
		const t = initConvexTest();
		const { userId, threadId, runId, claimId } = await fixture(t);
		const session = await t.mutation(internal.firecrawlSessions.acquire, {
			userId,
			threadId,
			runId,
			claimId,
			operationId: 'new'
		});
		await t.mutation(internal.firecrawlSessions.attach, {
			id: session._id,
			operationId: 'new',
			sessionId: 'remote-new',
			expiresAt: Date.now() + 3_600_000
		});
		await t.mutation(internal.firecrawlSessions.release, { id: session._id, operationId: 'new' });
		const attached = await t.run((ctx) => ctx.db.get('firecrawlSessions', session._id));
		await t.mutation(internal.firecrawlSessions.reconcile, {
			ids: [session._id],
			before: attached!.attachedAt! - 1
		});
		expect(await t.run((ctx) => ctx.db.get('firecrawlSessions', session._id))).not.toBeNull();
	});

	it('rejects takeover during an action and rejects another user', async () => {
		const t = initConvexTest();
		const { asUser, userId, threadId, runId, claimId } = await fixture(t);
		const session = await t.mutation(internal.firecrawlSessions.acquire, {
			userId,
			threadId,
			runId,
			claimId,
			operationId: 'busy'
		});
		await t.mutation(internal.firecrawlSessions.attach, {
			id: session._id,
			operationId: 'busy',
			sessionId: 'remote',
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

	it('keeps commands shell-quoted and does not execute shell substitutions', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await t.action(api.browserAgent.interact, {
			runId,
			claimId,
			executionSecret,
			command: 'fill @e1 "$(touch /tmp/owned); echo secret"'
		});
		expect(JSON.parse(String(fetch.mock.calls[1][1].body)).code).toBe(
			"'agent-browser' 'fill' '@e1' '$(touch /tmp/owned); echo secret'"
		);
	});

	it('starts non-saving when the preference is disabled, without discarding the saved profile', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await fixture(t);
		await asUser.mutation(api.browserProfiles.setSaving, { enabled: false });
		const profile = await t.run((ctx) => ctx.db.query('browserProfiles').first());
		await t.action(api.browserAgent.interact, {
			runId,
			claimId,
			executionSecret,
			command: 'get url',
			disable_saving: false
		});
		expect(JSON.parse(String(fetch.mock.calls[0][1].body)).profile).toEqual({
			name: profile!.name,
			saveChanges: false
		});
	});

	it('rejects global options with or without the CLI prefix before creating a session', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		for (const command of ['--help', 'agent-browser --help', 'agent-browser --json screenshot']) {
			await expect(
				t.action(api.browserAgent.interact, { runId, claimId, executionSecret, command })
			).rejects.toThrow('without global options');
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it('returns screenshot image data only within the serialized-value budget', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret };
		await t.action(api.browserAgent.interact, { ...args, command: 'get url' });
		const dataBase64 =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBf8AAAAASUVORK5CYII=';
		fetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						stdout: JSON.stringify({ dataBase64, byteLength: 68, url: 'https://example.com' })
					})
				)
		);
		expect(await t.action(api.browserAgent.screenshot, args)).toMatchObject({
			mediaType: 'image/png',
			dataBase64,
			truncated: false
		});
		fetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						stdout: JSON.stringify({
							dataBase64: '',
							byteLength: 700_000,
							url: 'https://example.com'
						})
					})
				)
		);
		expect(await t.action(api.browserAgent.screenshot, args)).toMatchObject({
			dataBase64: '',
			truncated: true
		});
	});

	it('does not infer session death from an incomplete provider list', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		await t.action(api.browserAgent.interact, {
			runId,
			claimId,
			executionSecret,
			command: 'get url'
		});
		fetch.mockImplementation(
			async () => new Response(JSON.stringify({ success: true, sessions: [] }))
		);
		await t.action(internal.firecrawlBrowser.reconcile, {});
		expect(await t.run((ctx) => ctx.db.query('firecrawlSessions').collect())).toHaveLength(1);
		const session = await t.run((ctx) => ctx.db.query('firecrawlSessions').unique());
		await t.run((ctx) => ctx.db.patch('firecrawlSessions', session!._id, { attachedAt: 0 }));
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
		expect(await t.run((ctx) => ctx.db.query('firecrawlSessions').collect())).toHaveLength(0);
	});

	it('quarantines uncertain execution without replaying it', async () => {
		const fetch = remote();
		const t = initConvexTest();
		const { runId, claimId, executionSecret } = await fixture(t);
		const args = { runId, claimId, executionSecret, command: 'click @e1' };
		await t.action(api.browserAgent.interact, args);
		fetch.mockRejectedValue(new Error('Connection reset'));
		await expect(t.action(api.browserAgent.interact, args)).rejects.toThrow(
			'browser_outcome_unknown'
		);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(await t.run((ctx) => ctx.db.query('firecrawlSessions').first())).toMatchObject({
			closing: true
		});
	});
});
