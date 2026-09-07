import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { executionSecretHash } from '@convex/lib/auth';
import {
	MACHINE_REQUEST_CLAIM_EXPIRED,
	MACHINE_REQUEST_CLAIM_TTL_MS,
	MACHINE_REQUEST_EXPIRED,
	MACHINE_REQUEST_NOT_CAPABLE,
	MACHINE_REQUEST_STOPPED,
	MACHINE_REQUEST_TERMINAL_RETENTION_MS,
	MACHINE_REQUEST_TTL_MS,
	MAX_MACHINE_REQUEST_ERROR_CHARS,
	MAX_MACHINE_REQUEST_ID_LENGTH,
	MAX_MACHINE_REQUEST_PROMPT_CHARS,
	MAX_MACHINE_REQUEST_RESULT_BYTES,
	MAX_MACHINE_REQUESTS_IN_FLIGHT
} from '@convex/lib/machineRequests';
import { MACHINE_ONLINE_THRESHOLD_MS } from '@convex/lib/machineRuns';
import {
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

const machine = {
	machineId: 'machine-a',
	friendlyName: 'Workshop',
	platform: 'linux',
	architecture: 'x86_64',
	appVersion: '0.3.2'
};

const listProjects = { kind: 'listProjects' as const };
const credential = 'credential-a';
const processArgs = { machineId: machine.machineId, credential };

afterEach(() => vi.useRealTimers());

async function staleOwnedMachine(t: ConvexTestInstance, machineId: string, userId = 'user_alice') {
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query('machines')
			.withIndex('by_userId_and_machineId', (query) =>
				query.eq('userId', userId).eq('machineId', machineId)
			)
			.unique();
		if (!row) throw new Error('Machine was not found.');
		await ctx.db.patch('machines', row._id, {
			lastSeenAt: Date.now() - MACHINE_ONLINE_THRESHOLD_MS - 1
		});
	});
}

async function registerCapable(
	asUser: Awaited<ReturnType<typeof seedOwnedThread>>['asUser'],
	secret = credential
) {
	await asUser.mutation(api.machines.register, {
		...machine,
		remoteProtocolVersion: 1,
		credentialHash: await executionSecretHash(secret)
	});
}

describe('machineRequests', () => {
	it('recovers a launched run when its machine acknowledgement is lost', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await registerCapable(asUser);
		const submissionId = 'lost-ack';
		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: submissionId,
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: {
				kind: 'runAgent',
				submissionId,
				threadId,
				prompt: 'Hello',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				workspacePath: '/work'
			}
		});
		await asUser.mutation(api.machineRequests.claim, { ...processArgs, id });
		const run = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId,
			executionSecret: 'local-only-secret',
			machineId: machine.machineId,
			prompt: 'Hello'
		});
		const recovered = {
			status: 'completed',
			result: JSON.stringify({ runId: run.runId, threadId })
		};
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual(recovered);
		vi.advanceTimersByTime(MACHINE_REQUEST_CLAIM_TTL_MS + 1);
		await t.mutation(internal.machineRequests.expireClaim, { id });
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual(recovered);
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', run.runId, { machineId: 'another-machine' });
		});
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual({
			status: 'failed',
			error: MACHINE_REQUEST_CLAIM_EXPIRED
		});
	});

	it('enqueues, claims once, completes idempotently, and hides the row after retention', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await registerCapable(asUser);

		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'req-1',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		const pending = await asUser.query(api.machineRequests.next, processArgs);
		expect(pending).toMatchObject({
			_id: id,
			userId: 'user_alice',
			command: listProjects
		});
		expect(pending?.expiresAt).toBeGreaterThan(Date.now());

		const claimed = await asUser.mutation(api.machineRequests.claim, { ...processArgs, id });
		expect(claimed).toMatchObject({ _id: id, command: listProjects, userId: 'user_alice' });
		expect(await asUser.mutation(api.machineRequests.claim, { ...processArgs, id })).toBeNull();
		expect(await asUser.query(api.machineRequests.next, processArgs)).toBeNull();
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual({ status: 'claimed' });
		await expect(t.query(api.machineRequests.get, { id })).rejects.toThrow(
			'Authentication required.'
		);
		await expect(
			asUser.mutation(api.machineRequests.complete, { ...processArgs, id })
		).rejects.toThrow('Machine request completion requires exactly one of result or error.');
		await expect(
			asUser.mutation(api.machineRequests.complete, {
				...processArgs,
				id,
				result: '{}',
				error: 'nope'
			})
		).rejects.toThrow('Machine request completion requires exactly one of result or error.');

		const result = '{"projects":[]}';
		await asUser.mutation(api.machineRequests.complete, { ...processArgs, id, result });
		await asUser.mutation(api.machineRequests.complete, { ...processArgs, id, result });
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual({
			status: 'completed',
			result
		});
		await expect(
			asUser.mutation(api.machineRequests.complete, {
				...processArgs,
				id,
				result: '{"projects":[1]}'
			})
		).rejects.toThrow('Machine request was already completed.');

		await t.finishAllScheduledFunctions(() => {
			vi.advanceTimersByTime(MACHINE_REQUEST_TERMINAL_RETENTION_MS + 1);
		});
		await expect(asUser.query(api.machineRequests.get, { id })).rejects.toThrow('Not found.');
	});

	it('rejects cross-account enqueue, get, next, and claim', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		const { asUser: asOther } = await seedOwnedThread(t, 'other-user');
		await registerCapable(asUser);
		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'owned',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});

		await expect(
			asOther.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'stolen',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).rejects.toThrow('Machine is not active.');
		await expect(asOther.query(api.machineRequests.get, { id })).rejects.toThrow('Not found.');
		await expect(asOther.query(api.machineRequests.next, processArgs)).rejects.toThrow(
			'Machine is not active.'
		);
		await expect(
			asOther.mutation(api.machineRequests.claim, { ...processArgs, id })
		).rejects.toThrow('Machine is not active.');
		await expect(
			asOther.mutation(api.machineRequests.complete, { ...processArgs, id, result: '{}' })
		).rejects.toThrow('Machine is not active.');
	});

	it('rejects expired, offline, old-protocol, and wrong-process machines', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);

		await asUser.mutation(api.machines.register, {
			...machine,
			credentialHash: await executionSecretHash(credential)
		});
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'old-protocol',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).rejects.toThrow(MACHINE_REQUEST_NOT_CAPABLE);
		expect((await asUser.query(api.machines.listMine, {}))[0]).not.toHaveProperty(
			'remoteProtocolVersion'
		);

		await registerCapable(asUser);
		vi.advanceTimersByTime(90_001);
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'offline',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).rejects.toThrow('Machine is not active.');

		await registerCapable(asUser);
		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'live',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		await expect(
			asUser.query(api.machineRequests.next, { machineId: machine.machineId, credential: 'wrong' })
		).rejects.toThrow('Machine is not active.');

		await staleOwnedMachine(t, machine.machineId);
		await expect(asUser.query(api.machineRequests.next, processArgs)).rejects.toThrow(
			'Machine is not active.'
		);
		await expect(
			asUser.mutation(api.machineRequests.claim, { ...processArgs, id })
		).rejects.toThrow('Machine is not active.');

		const previousHash = await executionSecretHash(credential);
		await asUser.mutation(api.machines.register, {
			...machine,
			remoteProtocolVersion: 1,
			credentialHash: await executionSecretHash('credential-b')
		});
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual({
			status: 'failed',
			error: MACHINE_REQUEST_STOPPED
		});
		await expect(asUser.query(api.machineRequests.next, processArgs)).rejects.toThrow(
			'Machine is not active.'
		);
		expect(
			await asUser.query(api.machineRequests.next, {
				machineId: machine.machineId,
				credential: 'credential-b'
			})
		).toBeNull();

		const nextId = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'new-process',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		await t.mutation(internal.machineRequests.failOpenPage, {
			userId: 'user_alice',
			machineId: machine.machineId,
			credentialHash: previousHash,
			error: MACHINE_REQUEST_STOPPED
		});
		expect(await asUser.query(api.machineRequests.get, { id: nextId })).toEqual({
			status: 'pending'
		});
	});

	it('dedupes identical request IDs and rejects an altered payload or target', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await registerCapable(asUser);
		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'same',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		expect(
			await asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'same',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).toBe(id);
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'same',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: { kind: 'listWorkspaceSkills', workspacePath: '/work' }
			})
		).rejects.toThrow('A request with this ID already exists with a different command or machine.');

		await asUser.mutation(api.machines.register, {
			...machine,
			machineId: 'machine-b',
			remoteProtocolVersion: 1,
			credentialHash: await executionSecretHash(credential)
		});
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: 'machine-b',
				requestId: 'same',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).rejects.toThrow('A request with this ID already exists with a different command or machine.');
	});

	it('does not execute stale queued requests and does not requeue expired claims', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await registerCapable(asUser);

		const expiredId = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'expires',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		vi.advanceTimersByTime(MACHINE_REQUEST_TTL_MS + 1);
		expect(await asUser.query(api.machineRequests.next, processArgs)).toBeNull();
		expect(
			await asUser.mutation(api.machineRequests.claim, { ...processArgs, id: expiredId })
		).toBeNull();
		expect(await asUser.query(api.machineRequests.get, { id: expiredId })).toEqual({
			status: 'failed',
			error: MACHINE_REQUEST_EXPIRED
		});

		const claimedId = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'claimed',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		expect(
			await asUser.mutation(api.machineRequests.claim, { ...processArgs, id: claimedId })
		).not.toBeNull();
		vi.advanceTimersByTime(MACHINE_REQUEST_CLAIM_TTL_MS + 1);
		await expect(
			asUser.mutation(api.machineRequests.complete, {
				...processArgs,
				id: claimedId,
				result: '{}'
			})
		).rejects.toThrow('Machine request claim expired.');
		expect(await asUser.query(api.machineRequests.get, { id: claimedId })).toEqual({
			status: 'failed',
			error: MACHINE_REQUEST_CLAIM_EXPIRED
		});
		await t.mutation(internal.machineRequests.expireClaim, { id: claimedId });
		expect(await asUser.query(api.machineRequests.get, { id: claimedId })).toEqual({
			status: 'failed',
			error: MACHINE_REQUEST_CLAIM_EXPIRED
		});
		await t.mutation(api.machines.heartbeat, {
			userId: 'user_alice',
			machineId: machine.machineId,
			credential
		});
		expect(await asUser.query(api.machineRequests.next, processArgs)).toBeNull();
		await expect(
			asUser.mutation(api.machineRequests.complete, {
				...processArgs,
				id: claimedId,
				result: '{}'
			})
		).rejects.toThrow('Machine request was already completed.');
		await asUser.mutation(api.machineRequests.complete, {
			...processArgs,
			id: claimedId,
			error: MACHINE_REQUEST_CLAIM_EXPIRED
		});
	});

	it('fails in-flight requests when the machine ends', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await registerCapable(asUser);
		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'ending',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		await t.mutation(api.machines.end, {
			userId: 'user_alice',
			machineId: machine.machineId,
			credential
		});
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual({
			status: 'failed',
			error: MACHINE_REQUEST_STOPPED
		});
		await expect(asUser.query(api.machineRequests.next, processArgs)).rejects.toThrow(
			'Machine is not active.'
		);
	});

	it('bounds request input, results, errors, and in-flight queue depth', async () => {
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await registerCapable(asUser);

		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'x'.repeat(MAX_MACHINE_REQUEST_ID_LENGTH + 1),
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).rejects.toThrow(/Request ID cannot exceed/);
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'prompt',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: {
					kind: 'runAgent',
					submissionId: 'submission',
					prompt: 'x'.repeat(MAX_MACHINE_REQUEST_PROMPT_CHARS + 1),
					imageUploadIds: [],
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					serviceTier: 'standard',
					workspacePath: '/work'
				}
			})
		).rejects.toThrow(/Prompt cannot exceed/);

		const ids = [];
		for (let index = 0; index < MAX_MACHINE_REQUESTS_IN_FLIGHT; index += 1) {
			ids.push(
				await asUser.mutation(api.machineRequests.enqueue, {
					machineId: machine.machineId,
					requestId: `cap-${index}`,
					expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
					command: listProjects
				})
			);
		}
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'cap-overflow',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).rejects.toThrow('This machine already has too many hosted commands in flight.');
		expect(
			await asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'cap-0',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).toBe(ids[0]);

		const claimed = await asUser.mutation(api.machineRequests.claim, {
			...processArgs,
			id: ids[0]
		});
		expect(claimed?._id).toBe(ids[0]);
		await expect(
			asUser.mutation(api.machineRequests.complete, {
				...processArgs,
				id: ids[0],
				result: 'a'.repeat(MAX_MACHINE_REQUEST_RESULT_BYTES + 1)
			})
		).rejects.toThrow(/Machine response cannot exceed/);
		await expect(
			asUser.mutation(api.machineRequests.complete, {
				...processArgs,
				id: ids[0],
				error: 'e'.repeat(MAX_MACHINE_REQUEST_ERROR_CHARS + 1)
			})
		).rejects.toThrow(/Machine error cannot exceed/);
	});

	it('requires authentication for enqueue, next, and get', async () => {
		const t = initConvexTest();
		await expect(
			t.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'anon',
				expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
				command: listProjects
			})
		).rejects.toThrow('Authentication required.');
		await expect(t.query(api.machineRequests.next, processArgs)).rejects.toThrow(
			'Authentication required.'
		);
	});

	it('rejects expired or non-finite enqueue deadlines and clamps ones past the server TTL', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await registerCapable(asUser);

		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'already-expired',
				expiresAt: Date.now(),
				command: listProjects
			})
		).rejects.toThrow('This hosted command expired before it was queued.');
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'non-finite',
				expiresAt: Number.POSITIVE_INFINITY,
				command: listProjects
			})
		).rejects.toThrow('Hosted command expiresAt must be a finite timestamp.');
		await expect(
			asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'non-finite',
				expiresAt: Number.NaN,
				command: listProjects
			})
		).rejects.toThrow('Hosted command expiresAt must be a finite timestamp.');

		const now = Date.now();
		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'clamped',
			expiresAt: now + MACHINE_REQUEST_TTL_MS * 10,
			command: listProjects
		});
		expect(await asUser.query(api.machineRequests.next, processArgs)).toMatchObject({
			_id: id,
			expiresAt: now + MACHINE_REQUEST_TTL_MS
		});
		vi.advanceTimersByTime(MACHINE_REQUEST_TTL_MS + 1);
		expect(await asUser.query(api.machineRequests.next, processArgs)).toBeNull();
		expect(await asUser.mutation(api.machineRequests.claim, { ...processArgs, id })).toBeNull();
		expect(await asUser.query(api.machineRequests.get, { id })).toEqual({
			status: 'failed',
			error: MACHINE_REQUEST_EXPIRED
		});
	});

	it('returns an existing receipt when a delayed retry sends an expired deadline', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const t = initConvexTest();
		const { asUser } = await seedOwnedThread(t);
		await registerCapable(asUser);
		const id = await asUser.mutation(api.machineRequests.enqueue, {
			machineId: machine.machineId,
			requestId: 'retry-later',
			expiresAt: Date.now() + MACHINE_REQUEST_TTL_MS,
			command: listProjects
		});
		vi.advanceTimersByTime(MACHINE_REQUEST_TTL_MS + 1);
		expect(
			await asUser.mutation(api.machineRequests.enqueue, {
				machineId: machine.machineId,
				requestId: 'retry-later',
				expiresAt: Date.now() - 1,
				command: listProjects
			})
		).toBe(id);
	});
});
