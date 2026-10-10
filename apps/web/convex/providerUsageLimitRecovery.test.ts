import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FunctionArgs } from 'convex/server';
import { api, internal } from '@convex/_generated/api';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { executionSecretHash } from '@convex/lib/auth';
import { AUTOMATIC_RECOVERY_SUBMISSION_PREFIX } from '@convex/lib/runRecovery';
import { initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

const NOW = Date.parse('2026-07-18T12:00:00Z');

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const WINDOW = 8 * 24 * HOUR;

const QUOTA_ERROR = 'ChatGPT connected-app usage limit reached.';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

async function setup(
	options: {
		completionProvider?: 'spikonado' | 'openai' | 'chatgpt';
		machineId?: string;
	} = { completionProvider: 'chatgpt', machineId: 'quota-machine' }
) {
	const t = initConvexTest();
	const { asUser, threadId, subject } = await seedOwnedThread(t);
	const machineId = options.machineId ?? 'quota-machine';
	const credentialHash = await executionSecretHash('machine-secret');

	const registerMachine = (id = machineId) =>
		asUser.mutation(api.machines.tryRegister, {
			machineId: id,
			credentialHash,
			friendlyName: 'Workstation',
			platform: 'linux',
			platformVersion: 'test',
			architecture: 'x86_64',
			hostname: 'workstation',
			appVersion: 'test'
		});

	await registerMachine();

	const refreshMachine = () =>
		asUser.mutation(api.machines.heartbeat, {
			userId: subject,
			machineId,
			credential: 'machine-secret'
		});

	await asUser.mutation(api.threads.setCompletionSettings, {
		threadId,
		selectedModel: 'gpt-5.6-sol',
		completionProvider: options.completionProvider ?? 'spikonado'
	});

	const { runId } = await insertQueuedRun(t, asUser, {
		threadId,
		submissionId: 'quota-submission',
		executionSecret: 'run-secret',
		prompt: 'Build it',
		...options
	});

	const queryArgs = {
		submissionId: 'quota-submission',
		machineId,
		supportsUsageLimitResume: true
	};

	const recoveryArgs = {
		threadId,
		submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}next`,
		executionSecret: 'next-secret',
		prompt: '',
		completionProvider: 'chatgpt' as const,
		machineId,
		continuationOfRunId: runId
	};

	const finalize = (
		overrides: Partial<FunctionArgs<typeof api.agentRuntime.finalizeExecutorRun>> = {}
	) =>
		asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'run-secret',
			text: QUOTA_ERROR,
			status: 'failed',
			lastError: QUOTA_ERROR,
			providerUsageLimit: {},
			...overrides
		});

	const readRun = (id = runId) => t.run((ctx) => ctx.db.get('runs', id));
	const lifecycle = () => asUser.query(api.chat.selectedThreadLifecycle, { threadId });

	const switchProvider = (completionProvider: 'spikonado' | 'openai' | 'chatgpt') =>
		asUser.mutation(api.threads.setCompletionSettings, {
			threadId,
			selectedModel: 'gpt-5.6-sol',
			completionProvider
		});

	return {
		t,
		asUser,
		threadId,
		subject,
		runId,
		queryArgs,
		recoveryArgs,
		finalize,
		readRun,
		lifecycle,
		registerMachine,
		refreshMachine,
		switchProvider
	};
}

describe('provider usage-limit detection', () => {
	it('schedules a failed ChatGPT machine run from structured metadata, not error text', async () => {
		const { finalize, readRun, lifecycle } = await setup();
		await finalize({ text: 'opaque provider failure', lastError: 'opaque provider failure' });
		expect(await readRun()).toMatchObject({
			status: 'failed',
			usageLimit: { retryAt: NOW + 15 * MINUTE, attempts: 0, deadlineAt: NOW + WINDOW }
		});
		expect(await lifecycle()).toMatchObject({
			phase: 'failed',
			run: { usageLimitRetryAt: NOW + 15 * MINUTE }
		});
	});

	it.each(['spikonado', 'openai', undefined] as const)(
		'does not schedule a %s provider run',
		async (completionProvider) => {
			const { finalize, readRun, asUser, queryArgs } = await setup({
				completionProvider,
				machineId: 'quota-machine'
			});

			await finalize();
			expect((await readRun())?.usageLimit).toBeUndefined();
			expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
		}
	);

	it('does not schedule a ChatGPT run without a machine', async () => {
		const { finalize, readRun } = await setup({ completionProvider: 'chatgpt' });
		await finalize();
		expect((await readRun())?.usageLimit).toBeUndefined();
	});

	it.each(['completed', 'cancelled'] as const)('does not schedule a %s result', async (status) => {
		const { finalize, readRun } = await setup();
		await finalize({ status });
		expect(await readRun()).toMatchObject({ status });
		expect((await readRun())?.usageLimit).toBeUndefined();
	});

	it('leaves an unstructured quota-looking failure terminal', async () => {
		const { finalize, readRun, asUser, queryArgs } = await setup();
		await finalize({ providerUsageLimit: undefined });
		expect((await readRun())?.usageLimit).toBeUndefined();
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
	});

	it('uses the resolved cancelled status when cancellation races with a quota failure', async () => {
		const { finalize, readRun, asUser, runId } = await setup();
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId });
		await finalize();
		expect(await readRun()).toMatchObject({ status: 'cancelled', cancellationRequestedAt: NOW });
		expect((await readRun())?.usageLimit).toBeUndefined();
	});

	it('does not add a schedule when a late report repeats an ordinary finalization', async () => {
		const { finalize, readRun } = await setup();
		await finalize({ providerUsageLimit: undefined });
		vi.setSystemTime(NOW + HOUR);
		await finalize();
		expect((await readRun())?.usageLimit).toBeUndefined();
	});

	it('keeps the original schedule and deadline when finalization is retried', async () => {
		const { finalize, readRun } = await setup();
		await finalize();
		const original = (await readRun())?.usageLimit;
		vi.setSystemTime(NOW + MINUTE);
		await finalize({ providerUsageLimit: { resetsAt: NOW + HOUR } });
		expect((await readRun())?.usageLimit).toEqual(original);
	});

	it('does not schedule when the thread switches providers before the executor reports failure', async () => {
		const { finalize, readRun, switchProvider } = await setup();
		await switchProvider('openai');
		await finalize();
		expect((await readRun())?.usageLimit).toBeUndefined();
	});
});

describe('usage-limit retry timing and durable budgets', () => {
	it('starts the eight-day budget at the first quota failure, not at run creation', async () => {
		const { finalize, readRun } = await setup();
		vi.setSystemTime(NOW + HOUR);
		await finalize();
		expect((await readRun())?.usageLimit).toEqual({
			retryAt: NOW + HOUR + 15 * MINUTE,
			attempts: 0,
			deadlineAt: NOW + HOUR + WINDOW
		});
	});

	it.each([
		{ name: 'future Unix milliseconds', resetsAt: NOW + HOUR, delay: HOUR + 5_000 },
		{ name: 'reset in one millisecond', resetsAt: NOW + 1, delay: 15_000 },
		{ name: 'minimum boundary', resetsAt: NOW + 10_000, delay: 15_000 },
		{ name: 'above minimum', resetsAt: NOW + 10_001, delay: 15_001 },
		{
			name: 'future reset above fallback cap',
			resetsAt: NOW + 12 * HOUR,
			delay: 12 * HOUR + 5_000
		},
		{ name: 'missing reset', resetsAt: undefined, delay: 15 * MINUTE },
		{ name: 'reset at now', resetsAt: NOW, delay: 15 * MINUTE },
		{ name: 'past reset', resetsAt: NOW - 1, delay: 15 * MINUTE },
		{ name: 'Unix seconds are past', resetsAt: NOW / 1000 + 3600, delay: 15 * MINUTE },
		{ name: 'NaN reset', resetsAt: Number.NaN, delay: 15 * MINUTE },
		{ name: 'infinite reset', resetsAt: Number.POSITIVE_INFINITY, delay: 15 * MINUTE },
		{ name: 'negative infinite reset', resetsAt: Number.NEGATIVE_INFINITY, delay: 15 * MINUTE }
	])('schedules $name', async ({ resetsAt, delay }) => {
		const { finalize, readRun } = await setup();
		await finalize({ providerUsageLimit: { resetsAt } });
		expect((await readRun())?.usageLimit).toEqual({
			retryAt: NOW + delay,
			attempts: 0,
			deadlineAt: NOW + WINDOW
		});
	});

	it('allows a buffered reset exactly at the deadline', async () => {
		const { finalize, readRun } = await setup();
		await finalize({ providerUsageLimit: { resetsAt: NOW + WINDOW - 5_000 } });
		expect((await readRun())?.usageLimit).toEqual({
			retryAt: NOW + WINDOW,
			attempts: 0,
			deadlineAt: NOW + WINDOW
		});
	});

	it.each([NOW + WINDOW - 4_999, NOW + WINDOW + HOUR])(
		'does not schedule a buffered reset beyond the deadline (%s)',
		async (resetsAt) => {
			const { t, finalize, readRun, asUser, queryArgs, recoveryArgs } = await setup();
			await finalize({ providerUsageLimit: { resetsAt } });
			expect((await readRun())?.usageLimit).toEqual({ attempts: 0, deadlineAt: NOW + WINDOW });
			expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
			vi.setSystemTime(NOW + 1);

			const child = await insertQueuedRun(t, asUser, {
				...recoveryArgs,
				submissionId: 'manual-out-of-window'
			});

			expect((await readRun())?.usageLimit).toBeUndefined();
			expect((await readRun(child.runId))?.usageLimit).toEqual({
				attempts: 0,
				deadlineAt: NOW + WINDOW
			});
			await finalize({
				runId: child.runId,
				executionSecret: 'next-secret',
				providerUsageLimit: { resetsAt }
			});
			expect((await readRun(child.runId))?.usageLimit).toEqual({
				attempts: 0,
				deadlineAt: NOW + WINDOW
			});
		}
	);

	it('carries one deadline through eight automatic quota retries and caps fallback at six hours', async () => {
		const {
			t,
			asUser,
			threadId,
			runId,
			recoveryArgs,
			finalize,
			readRun,
			refreshMachine,
			lifecycle
		} = await setup();

		await finalize();
		let parentId = runId;

		const delays = [
			15 * MINUTE,
			30 * MINUTE,
			HOUR,
			2 * HOUR,
			4 * HOUR,
			6 * HOUR,
			6 * HOUR,
			6 * HOUR
		];

		for (let attempt = 1; attempt <= 8; attempt++) {
			const parent = await readRun(parentId);
			expect(parent?.usageLimit).toEqual({
				retryAt: Date.now() + delays[attempt - 1]!,
				attempts: attempt - 1,
				deadlineAt: NOW + WINDOW
			});
			vi.setSystemTime(parent!.usageLimit!.retryAt!);
			await refreshMachine();

			const args = {
				...recoveryArgs,
				submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}${attempt}`,
				executionSecret: `attempt-${attempt}`,
				continuationOfRunId: parentId
			};

			const child = await insertQueuedRun(t, asUser, args);
			expect(child.created).toBe(true);
			expect(child.promptPart).toBeUndefined();
			expect((await readRun(parentId))?.usageLimit).toBeUndefined();
			expect((await readRun(child.runId))?.usageLimit).toEqual({
				attempts: attempt,
				deadlineAt: NOW + WINDOW
			});
			expect(await insertQueuedRun(t, asUser, args)).toMatchObject({
				created: false,
				runId: child.runId
			});
			expect((await readRun(child.runId))?.usageLimit?.attempts).toBe(attempt);
			expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
			await asUser.mutation(api.agentRuntime.start, {
				runId: child.runId,
				executionSecret: args.executionSecret,
				claimId: `claim-${attempt}`
			});
			expect((await readRun(child.runId))?.usageLimit).toEqual({
				attempts: attempt,
				deadlineAt: NOW + WINDOW
			});
			expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
			await finalize({ runId: child.runId, executionSecret: args.executionSecret });
			parentId = child.runId;
		}

		expect((await readRun(parentId))?.usageLimit).toEqual({
			attempts: 8,
			deadlineAt: NOW + WINDOW
		});
		expect(
			await asUser.query(api.runRecovery.state, {
				submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}8`,
				machineId: recoveryArgs.machineId,
				supportsUsageLimitResume: true
			})
		).toEqual({ state: 'discard' });
		await expect(
			insertQueuedRun(t, asUser, {
				...recoveryArgs,
				submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}9`,
				continuationOfRunId: parentId
			})
		).rejects.toThrow();
		vi.setSystemTime(Date.now() + 1);

		const manual = await insertQueuedRun(t, asUser, {
			...recoveryArgs,
			submissionId: 'manual-after-eight-retries',
			continuationOfRunId: parentId
		});

		expect((await readRun(parentId))?.usageLimit).toBeUndefined();
		expect((await readRun(manual.runId))?.usageLimit).toEqual({
			attempts: 8,
			deadlineAt: NOW + WINDOW
		});
		await finalize({ runId: manual.runId, executionSecret: 'next-secret' });
		expect((await readRun(manual.runId))?.usageLimit).toEqual({
			attempts: 8,
			deadlineAt: NOW + WINDOW
		});
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts).toHaveLength(1);
		expect(parts.parts[0]?.runId).toBe(runId);
	});

	it('allows manual continuation before due without spending an automatic retry', async () => {
		const { t, asUser, finalize, readRun, recoveryArgs, lifecycle } = await setup();
		await finalize();
		vi.setSystemTime(NOW + 1);

		const child = await insertQueuedRun(t, asUser, {
			...recoveryArgs,
			submissionId: 'manual-continuation'
		});

		expect((await readRun())?.usageLimit).toBeUndefined();
		expect((await readRun(child.runId))?.usageLimit).toEqual({
			attempts: 0,
			deadlineAt: NOW + WINDOW
		});
		expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
		await finalize({ runId: child.runId, executionSecret: 'next-secret' });
		expect((await readRun(child.runId))?.usageLimit).toEqual({
			retryAt: Date.now() + 15 * MINUTE,
			attempts: 0,
			deadlineAt: NOW + WINDOW
		});
	});

	it('preserves the budget across an abandoned continuation without counting abandonment as quota recovery', async () => {
		const { t, asUser, finalize, readRun, recoveryArgs, refreshMachine, lifecycle } = await setup();
		await finalize();
		vi.setSystemTime(NOW + 15 * MINUTE);
		await refreshMachine();
		const child = await insertQueuedRun(t, asUser, recoveryArgs);
		await finalize({
			runId: child.runId,
			executionSecret: 'next-secret',
			providerUsageLimit: undefined,
			lastError: RUN_ABANDONED_BY_AGENT
		});
		expect((await readRun(child.runId))?.usageLimit).toEqual({
			attempts: 1,
			deadlineAt: NOW + WINDOW
		});
		expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
		expect(
			await asUser.query(api.runRecovery.state, {
				submissionId: recoveryArgs.submissionId,
				machineId: recoveryArgs.machineId
			})
		).toEqual({ state: 'recover', runId: child.runId, threadId: recoveryArgs.threadId });
		vi.setSystemTime(Date.now() + 1);

		const recovered = await insertQueuedRun(t, asUser, {
			...recoveryArgs,
			submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}abandoned`,
			executionSecret: 'abandoned-secret',
			continuationOfRunId: child.runId
		});

		expect((await readRun(child.runId))?.usageLimit).toBeUndefined();
		expect((await readRun(recovered.runId))?.usageLimit).toEqual({
			attempts: 1,
			deadlineAt: NOW + WINDOW
		});
		await finalize({ runId: recovered.runId, executionSecret: 'abandoned-secret' });
		expect((await readRun(recovered.runId))?.usageLimit).toEqual({
			retryAt: Date.now() + 30 * MINUTE,
			attempts: 1,
			deadlineAt: NOW + WINDOW
		});
	});

	it.each(['failed', 'completed', 'cancelled'] as const)(
		'handles inherited budget on a nonquota %s finalization',
		async (status) => {
			const { t, asUser, finalize, readRun, recoveryArgs, lifecycle } = await setup();
			await finalize();
			vi.setSystemTime(NOW + 1);

			const child = await insertQueuedRun(t, asUser, {
				...recoveryArgs,
				submissionId: 'manual-continuation'
			});

			await finalize({
				runId: child.runId,
				executionSecret: 'next-secret',
				status,
				providerUsageLimit: undefined,
				lastError: 'ordinary result'
			});
			expect((await readRun(child.runId))?.usageLimit).toEqual(
				status === 'failed' ? { attempts: 0, deadlineAt: NOW + WINDOW } : undefined
			);
			expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
		}
	);

	it.each(['too little fallback time', 'deadline reached', 'deadline passed'] as const)(
		'keeps the inherited deadline terminal with %s',
		async (boundary) => {
			const { t, asUser, finalize, readRun, recoveryArgs } = await setup();
			await finalize();
			vi.setSystemTime(NOW + 1);

			const child = await insertQueuedRun(t, asUser, {
				...recoveryArgs,
				submissionId: 'manual-continuation'
			});

			const offsets = {
				'too little fallback time': -15 * MINUTE + 1,
				'deadline reached': 0,
				'deadline passed': 1
			};

			vi.setSystemTime(NOW + WINDOW + offsets[boundary]);
			await finalize({ runId: child.runId, executionSecret: 'next-secret' });
			expect((await readRun(child.runId))?.usageLimit).toEqual({
				attempts: 0,
				deadlineAt: NOW + WINDOW
			});
			expect(
				await asUser.query(api.runRecovery.state, {
					submissionId: 'manual-continuation',
					machineId: recoveryArgs.machineId,
					supportsUsageLimitResume: true
				})
			).toEqual({ state: 'discard' });
		}
	);
});

describe('usage-limit recovery query and client opt-in', () => {
	it.each([false, true])(
		'waits until the exact due time, missing submission: %s',
		async (missing) => {
			const { asUser, finalize, runId, threadId, queryArgs, recoveryArgs } = await setup();
			await finalize();

			const args = missing
				? { ...queryArgs, submissionId: recoveryArgs.submissionId, continuationOfRunId: runId }
				: queryArgs;

			const retryAt = NOW + 15 * MINUTE;
			expect(await asUser.query(api.runRecovery.state, args)).toEqual({
				state: 'waiting',
				retryAt
			});
			vi.setSystemTime(retryAt - 1);
			expect(await asUser.query(api.runRecovery.state, args)).toEqual({
				state: 'waiting',
				retryAt
			});
			vi.setSystemTime(retryAt);
			expect(await asUser.query(api.runRecovery.state, args)).toEqual(
				missing
					? { state: 'missing' }
					: { state: 'recover', runId, threadId, providerUsageLimit: true }
			);
		}
	);

	it.each([undefined, false] as const)(
		'discards quota recovery without true opt-in (%s)',
		async (supportsUsageLimitResume) => {
			const { asUser, finalize, runId, queryArgs, recoveryArgs } = await setup();
			await finalize();

			for (const submissionId of [queryArgs.submissionId, recoveryArgs.submissionId]) {
				const args = {
					...queryArgs,
					submissionId,
					continuationOfRunId: runId,
					supportsUsageLimitResume
				};

				expect(await asUser.query(api.runRecovery.state, args)).toEqual({ state: 'discard' });
				vi.setSystemTime(NOW + 15 * MINUTE);
				expect(await asUser.query(api.runRecovery.state, args)).toEqual({ state: 'discard' });
				vi.setSystemTime(NOW);
			}
		}
	);

	it('does not recover a missing submission without a parent', async () => {
		const { asUser, finalize, queryArgs } = await setup();
		await finalize();
		expect(
			await asUser.query(api.runRecovery.state, { ...queryArgs, submissionId: 'never-submitted' })
		).toEqual({ state: 'discard' });
	});

	it.each([
		'machine',
		'run owner',
		'thread owner',
		'archived root',
		'provider',
		'latest run'
	] as const)(
		'applies %s eligibility to waiting and due states, including missing submissions',
		async (condition) => {
			const { t, asUser, finalize, runId, threadId, queryArgs, recoveryArgs } = await setup();
			await finalize();
			let caller = asUser;
			let machineId = queryArgs.machineId;

			if (condition === 'machine') machineId = 'other-machine';

			if (condition === 'run owner') caller = t.withIdentity({ subject: 'other-user' });

			if (condition === 'thread owner') {
				await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { userId: 'other-user' }));
			}

			if (condition === 'archived root') {
				const root = await seedOwnedThread(t);
				await t.run(async (ctx) => {
					await ctx.db.patch('threadRecords', threadId, { parentThreadId: root.threadId });
					await ctx.db.patch('threadRecords', root.threadId, { archivedAt: NOW });
				});
			}

			if (condition === 'provider') {
				await t.run((ctx) =>
					ctx.db.patch('threadRecords', threadId, { completionProvider: 'openai' })
				);
			}

			if (condition === 'latest run') {
				vi.setSystemTime(NOW + 1);
				await insertQueuedRun(t, asUser, { ...recoveryArgs, submissionId: 'manual-continuation' });
			}

			for (const now of [NOW + 1, NOW + 15 * MINUTE]) {
				vi.setSystemTime(now);

				for (const missing of [false, true]) {
					expect(
						await caller.query(api.runRecovery.state, {
							...queryArgs,
							machineId,
							submissionId: missing ? recoveryArgs.submissionId : queryArgs.submissionId,
							continuationOfRunId: missing ? runId : undefined
						})
					).toEqual({ state: 'discard' });
				}
			}
		}
	);

	it('stops offering recovery after the deadline even when retryAt has passed', async () => {
		const { asUser, finalize, queryArgs, runId, recoveryArgs } = await setup();
		await finalize();
		vi.setSystemTime(NOW + WINDOW + 1);

		for (const submissionId of [queryArgs.submissionId, recoveryArgs.submissionId]) {
			expect(
				await asUser.query(api.runRecovery.state, {
					...queryArgs,
					submissionId,
					continuationOfRunId: runId
				})
			).toEqual({ state: 'discard' });
		}
	});
});

describe('usage-limit cancellation, new work, and provider changes', () => {
	it('cancels a waiting failed run before due and prevents a late executor report from restoring it', async () => {
		const {
			t,
			asUser,
			finalize,
			runId,
			readRun,
			lifecycle,
			queryArgs,
			recoveryArgs,
			refreshMachine
		} = await setup();

		await finalize();
		vi.setSystemTime(NOW + MINUTE);
		expect(await asUser.mutation(api.agentRuntime.requestCancellation, { runId })).toBe(true);
		expect(await readRun()).toMatchObject({
			status: 'failed',
			cancellationRequestedAt: NOW + MINUTE
		});
		expect((await readRun())?.usageLimit).toBeUndefined();
		expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
		await finalize();
		expect((await readRun())?.usageLimit).toBeUndefined();

		for (const now of [NOW + MINUTE, NOW + 15 * MINUTE]) {
			vi.setSystemTime(now);
			await refreshMachine();

			for (const submissionId of [queryArgs.submissionId, recoveryArgs.submissionId]) {
				expect(
					await asUser.query(api.runRecovery.state, {
						...queryArgs,
						submissionId,
						continuationOfRunId: runId
					})
				).toEqual({ state: 'discard' });
			}

			await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow();
		}
	});

	it('clears the previous schedule when new work starts without inheriting its budget', async () => {
		const { t, asUser, finalize, readRun, threadId, queryArgs, lifecycle } = await setup();
		await finalize();
		vi.setSystemTime(NOW + 1);

		const newer = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'new-work',
			executionSecret: 'new-secret',
			prompt: 'Do this instead',
			completionProvider: 'chatgpt',
			machineId: queryArgs.machineId
		});

		expect((await readRun())?.usageLimit).toBeUndefined();
		expect((await readRun(newer.runId))?.usageLimit).toBeUndefined();
		expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
		await finalize({ runId: newer.runId, executionSecret: 'new-secret' });
		expect((await readRun(newer.runId))?.usageLimit).toEqual({
			retryAt: NOW + 1 + 15 * MINUTE,
			attempts: 0,
			deadlineAt: NOW + 1 + WINDOW
		});
	});

	it.each([false, true])(
		'clears waiting metadata on a provider switch, switchback: %s',
		async (switchback) => {
			const {
				t,
				asUser,
				finalize,
				readRun,
				queryArgs,
				switchProvider,
				lifecycle,
				recoveryArgs,
				refreshMachine
			} = await setup();

			await finalize();
			await switchProvider('openai');
			expect((await readRun())?.usageLimit).toBeUndefined();

			if (switchback) await switchProvider('chatgpt');
			expect((await lifecycle()).run?.usageLimitRetryAt).toBeUndefined();
			vi.setSystemTime(NOW + 15 * MINUTE);
			await refreshMachine();
			expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({ state: 'discard' });
			await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow();
		}
	);

	it('keeps the schedule when only the selected model changes', async () => {
		const { asUser, finalize, readRun, threadId } = await setup();
		await finalize();
		const original = (await readRun())?.usageLimit;
		await asUser.mutation(api.threads.setCompletionSettings, {
			threadId,
			selectedModel: 'another-model',
			completionProvider: 'chatgpt'
		});
		expect((await readRun())?.usageLimit).toEqual(original);
	});

	it('clears an unscheduled child budget on provider change', async () => {
		const { t, asUser, finalize, readRun, recoveryArgs, switchProvider } = await setup();
		await finalize();
		vi.setSystemTime(NOW + 1);

		const child = await insertQueuedRun(t, asUser, {
			...recoveryArgs,
			submissionId: 'manual-continuation'
		});

		expect((await readRun(child.runId))?.usageLimit).toEqual({
			attempts: 0,
			deadlineAt: NOW + WINDOW
		});
		await switchProvider('openai');
		await switchProvider('chatgpt');
		expect((await readRun(child.runId))?.usageLimit).toBeUndefined();
	});
});

describe('automatic quota recovery mutation guards', () => {
	it('creates one continuation when two workers submit the same recovery concurrently', async () => {
		const {
			t,
			asUser,
			finalize,
			runId,
			threadId,
			subject,
			recoveryArgs,
			registerMachine,
			readRun
		} = await setup();

		await finalize();
		vi.setSystemTime(NOW + 15 * MINUTE);
		await registerMachine();

		const request: FunctionArgs<typeof internal.agentRuntime.insertGatewayRun> = {
			...recoveryArgs,
			userId: subject,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			fastMode: false,
			imageUploadIds: [],
			protocolVersion: 1
		};

		const results = await Promise.all([
			t.mutation(internal.agentRuntime.insertGatewayRun, request),
			t.mutation(internal.agentRuntime.insertGatewayRun, request)
		]);

		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(results[0]!.runId).toBe(results[1]!.runId);
		expect((await readRun(results[0]!.runId))?.usageLimit).toEqual({
			attempts: 1,
			deadlineAt: NOW + WINDOW
		});
		expect((await readRun(runId))?.usageLimit).toBeUndefined();
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts).toHaveLength(1);
	});

	it('rejects automatic continuation before due without consuming or clearing the budget', async () => {
		const { t, asUser, finalize, readRun, recoveryArgs } = await setup();
		await finalize();
		const original = (await readRun())?.usageLimit;
		await expect(insertQueuedRun(t, asUser, recoveryArgs)).rejects.toThrow();
		expect((await readRun())?.usageLimit).toEqual(original);
	});

	it.each([
		'cancelled',
		'newer work',
		'archived root',
		'provider switched',
		'provider switched back',
		'thread provider mismatch',
		'run provider mismatch',
		'request provider mismatch',
		'machine mismatch',
		'run owner mismatch',
		'thread owner mismatch',
		'deadline expired',
		'retry postponed'
	] as const)('rechecks %s after a stale recover query', async (race) => {
		const {
			t,
			asUser,
			finalize,
			runId,
			threadId,
			subject,
			recoveryArgs,
			queryArgs,
			registerMachine,
			refreshMachine,
			switchProvider
		} = await setup();

		await finalize();
		vi.setSystemTime(NOW + 15 * MINUTE);
		expect(await asUser.query(api.runRecovery.state, queryArgs)).toEqual({
			state: 'recover',
			runId,
			threadId,
			providerUsageLimit: true
		});
		await refreshMachine();

		const request: FunctionArgs<typeof internal.agentRuntime.insertGatewayRun> = {
			...recoveryArgs,
			userId: subject,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			fastMode: false,
			imageUploadIds: [],
			protocolVersion: 1
		};

		if (race === 'cancelled')
			await asUser.mutation(api.agentRuntime.requestCancellation, { runId });

		if (race === 'newer work') {
			vi.setSystemTime(Date.now() + 1);

			const newer = await insertQueuedRun(t, asUser, {
				...recoveryArgs,
				submissionId: 'newer-work',
				executionSecret: 'newer-secret',
				continuationOfRunId: undefined,
				prompt: 'Do this instead'
			});

			await finalize({
				runId: newer.runId,
				executionSecret: 'newer-secret',
				providerUsageLimit: undefined
			});
		}

		if (race === 'archived root') {
			const root = await seedOwnedThread(t);
			await t.run(async (ctx) => {
				await ctx.db.patch('threadRecords', threadId, { parentThreadId: root.threadId });
				await ctx.db.patch('threadRecords', root.threadId, { archivedAt: Date.now() });
			});
		}

		if (race === 'provider switched' || race === 'provider switched back') {
			await switchProvider('openai');

			if (race === 'provider switched back') await switchProvider('chatgpt');
		}

		if (race === 'thread provider mismatch') {
			await t.run((ctx) =>
				ctx.db.patch('threadRecords', threadId, { completionProvider: 'openai' })
			);
		}

		if (race === 'request provider mismatch') request.completionProvider = 'openai';

		if (race === 'run provider mismatch') {
			await t.run((ctx) => ctx.db.patch('runs', runId, { completionProvider: 'openai' }));
		}

		if (race === 'machine mismatch') {
			await registerMachine('other-machine');
			request.machineId = 'other-machine';
		}

		if (race === 'run owner mismatch') {
			await t.run((ctx) => ctx.db.patch('runs', runId, { userId: 'other-user' }));
		}

		if (race === 'thread owner mismatch') {
			await t.run((ctx) => ctx.db.patch('threadRecords', threadId, { userId: 'other-user' }));
		}

		if (race === 'deadline expired') {
			vi.setSystemTime(NOW + WINDOW + 1);
			await refreshMachine();
		}

		if (race === 'retry postponed') {
			await t.run((ctx) =>
				ctx.db.patch('runs', runId, {
					usageLimit: { retryAt: Date.now() + MINUTE, attempts: 0, deadlineAt: NOW + WINDOW }
				})
			);
		}

		const before = await t.run((ctx) => ctx.db.query('runs').collect());
		await expect(t.mutation(internal.agentRuntime.insertGatewayRun, request)).rejects.toThrow();
		const after = await t.run((ctx) => ctx.db.query('runs').collect());
		expect(after).toEqual(before);
	});
});
