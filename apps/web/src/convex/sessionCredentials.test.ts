import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { api, internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread, subjectTokenIdentifier } from '@convex/test.setup';

describe('sessionCredentials', () => {
	it('issues a credential for the authenticated user', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const credential = await asUser.mutation(api.sessionCredentials.issue, {});
		expect(credential.userId).toBe(subjectTokenIdentifier('user_alice'));
		expect(credential.current).not.toBe(credential.next);
		expect(credential.refreshAfterMs).toBe(5 * 60_000);

		const row = await t.run(async (ctx) =>
			ctx.db
				.query('sessionCredentials')
				.withIndex('by_userId', (query) => query.eq('userId', credential.userId))
				.first()
		);
		expect(row).not.toBeNull();
	});

	it('keeps two sessions for the same user independently valid', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const first = await asUser.mutation(api.sessionCredentials.issue, {});
		const second = await asUser.mutation(api.sessionCredentials.issue, {});
		expect(second.sessionId).not.toBe(first.sessionId);

		const firstTicket = {
			sessionId: first.sessionId,
			userId: first.userId,
			current: first.current,
			next: first.next
		};
		const secondTicket = {
			sessionId: second.sessionId,
			userId: second.userId,
			current: second.current,
			next: second.next
		};
		await t.mutation(api.sessionCredentials.rotate, { ticket: firstTicket });

		await expect(
			t.query(internal.sessionCredentials.resolveOwner, { ticket: secondTicket })
		).resolves.toMatchObject({ userId: second.userId });
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('sessionCredentials')
				.withIndex('by_userId', (query) => query.eq('userId', first.userId))
				.collect()
		);
		expect(rows).toHaveLength(2);
	});

	it('rotates with the issued pair and makes the old pair invalid', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const issued = await asUser.mutation(api.sessionCredentials.issue, {});
		const ticket = {
			sessionId: issued.sessionId,
			userId: issued.userId,
			current: issued.current,
			next: issued.next
		};

		// The issued pair verifies before any rotation.
		const owner = await t.query(internal.sessionCredentials.resolveOwner, { ticket });
		expect(owner).toEqual({
			userId: subjectTokenIdentifier('user_alice'),
			subject: 'user_alice'
		});

		// Rotation 1 advances the chain to the issued next element.
		const rotated = await t.mutation(api.sessionCredentials.rotate, { ticket });
		expect(rotated.refreshAfterMs).toBe(5 * 60_000);

		// The new current verifies; the old pair remains valid as the
		// previous element (in-flight rotation tolerance) but cannot rotate.
		const updatedTicket = {
			sessionId: issued.sessionId,
			userId: issued.userId,
			current: issued.next,
			next: crypto.randomUUID()
		};
		const ownerAfter = await t.query(internal.sessionCredentials.resolveOwner, {
			ticket: updatedTicket
		});
		expect(ownerAfter?.userId).toBe(subjectTokenIdentifier('user_alice'));
		expect((await t.query(internal.sessionCredentials.resolveOwner, { ticket }))?.userId).toBe(
			subjectTokenIdentifier('user_alice')
		);

		// Rotation 2 ratchets further, proving the client generates each next.
		const freshNext = crypto.randomUUID();
		const secondRotation = {
			sessionId: issued.sessionId,
			userId: issued.userId,
			current: issued.next,
			next: freshNext
		};
		await expect(
			t.mutation(api.sessionCredentials.rotate, { ticket: secondRotation })
		).resolves.toMatchObject({ refreshAfterMs: 5 * 60_000 });

		const rotatedOwn = await t.query(internal.sessionCredentials.resolveOwner, {
			ticket: {
				sessionId: issued.sessionId,
				userId: issued.userId,
				current: freshNext,
				next: crypto.randomUUID()
			}
		});
		expect(rotatedOwn?.userId).toBe(subjectTokenIdentifier('user_alice'));

		// Now the original pair has aged out of the chain entirely.
		await expect(t.query(internal.sessionCredentials.resolveOwner, { ticket })).rejects.toThrow(
			'Invalid session credential.'
		);
	});

	it('rejects rotation of a bogus pair and keeps the chain intact', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const issued = await asUser.mutation(api.sessionCredentials.issue, {});

		await expect(
			t.mutation(api.sessionCredentials.rotate, {
				ticket: {
					sessionId: issued.sessionId,
					userId: issued.userId,
					current: 'wrong',
					next: 'also-wrong'
				}
			})
		).rejects.toThrow('Invalid session credential.');

		// The real pair still verifies.
		const owner = await t.query(internal.sessionCredentials.resolveOwner, {
			ticket: {
				sessionId: issued.sessionId,
				userId: issued.userId,
				current: issued.current,
				next: issued.next
			}
		});
		expect(owner?.userId).toBe(subjectTokenIdentifier('user_alice'));
	});

	it('rejects a valid secret paired with a different user id', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const issued = await asUser.mutation(api.sessionCredentials.issue, {});
		const ticket = {
			sessionId: issued.sessionId,
			userId: subjectTokenIdentifier('user_mallory'),
			current: issued.current,
			next: issued.next
		};

		await expect(t.mutation(api.sessionCredentials.rotate, { ticket })).rejects.toThrow(
			'Invalid session credential.'
		);
		await expect(t.query(internal.sessionCredentials.resolveOwner, { ticket })).rejects.toThrow(
			'Invalid session credential.'
		);
	});

	it('expires credentials that missed two refresh marks', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const issued = await asUser.mutation(api.sessionCredentials.issue, {});
		const ticket = {
			sessionId: issued.sessionId,
			userId: issued.userId,
			current: issued.current,
			next: issued.next
		};

		// One refresh mark (5 minutes): still valid.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('sessionCredentials')
				.withIndex('by_userId', (query) => query.eq('userId', ticket.userId))
				.first();
			if (!row) throw new Error('credential row missing');
			await ctx.db.patch('sessionCredentials', row._id, {
				lastRefreshTime: Date.now() - 5 * 60_000
			});
		});
		expect(await t.query(internal.sessionCredentials.resolveOwner, { ticket })).not.toBeNull();

		// A second refresh mark (10 minutes total): expired.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('sessionCredentials')
				.withIndex('by_userId', (query) => query.eq('userId', ticket.userId))
				.first();
			if (!row) throw new Error('credential row missing');
			await ctx.db.patch('sessionCredentials', row._id, {
				lastRefreshTime: Date.now() - 10 * 60_000 - 1
			});
		});
		await expect(t.query(internal.sessionCredentials.resolveOwner, { ticket })).rejects.toThrow(
			'Invalid session credential.'
		);
	});

	describe('createGatewayRun', () => {
		beforeEach(() => {
			process.env.MODEL_GATEWAY_URL = 'https://preview.gateway.example';
			process.env.MODEL_GATEWAY_TOKEN_SECRET = 'test-gateway-token-secret';
		});

		afterEach(() => {
			delete process.env.MODEL_GATEWAY_URL;
			delete process.env.MODEL_GATEWAY_TOKEN_SECRET;
		});

		it('binds a run with a credential and no identity', async () => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const issued = await asUser.mutation(api.sessionCredentials.issue, {});

			const created = await t.action(api.agentRuntime.createGatewayRun, {
				submissionId: 'credential-bound-run',
				threadId,
				prompt: 'Run with a session credential',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				executionSecret: 'credential-bound-secret',
				sessionTicket: {
					sessionId: issued.sessionId,
					userId: issued.userId,
					current: issued.current
				}
			});

			expect(created.created).toBe(true);
			const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
			expect(run?.userId).toBe(subjectTokenIdentifier('user_alice'));
			expect(run?.executionSecretHash).toBeTruthy();
		});

		it('does not bind a credential to another user’s thread', async () => {
			const t = initConvexTest();
			const alice = await seedOwnedThread(t);
			const issued = await alice.asUser.mutation(api.sessionCredentials.issue, {});
			const bob = await seedOwnedThread(t, 'user_bob');

			await expect(
				t.action(api.agentRuntime.createGatewayRun, {
					submissionId: 'cross-user-credential-run',
					threadId: bob.threadId,
					prompt: 'Run on another user’s thread',
					imageUploadIds: [],
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					serviceTier: 'standard',
					executionSecret: 'cross-user-secret',
					sessionTicket: {
						sessionId: issued.sessionId,
						userId: issued.userId,
						current: issued.current
					}
				})
			).rejects.toThrow();
		});
	});
});
