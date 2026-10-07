import { v } from 'convex/values';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import schema from './schema';
import { executionSecretHash, getUserId } from './lib/auth';
import { getOwnedThreadRecord } from './lib/access';
import { getOwnedMachine, isMachineActive, MAX_ACTIVE_MACHINE_RUNS } from './lib/machineRuns';
import {
	areStorageIdsEqual,
	getOwnedImageUploadsByStorageIds,
	imageUploadByStorageId
} from './lib/imageUploads';
import { getPromptPart } from './lib/transcriptParts';
import { isRunFinalStatus, vCompletionProvider, vReasoningEffort } from './lib/validators';
import {
	headActionablePendingQuestion,
	hasAnsweredQuestionContinuation
} from './lib/agentQuestions';
import { submissionReadiness } from './lib/runCreate';
import { questionContinuation } from './agentQuestions';
import { getRunWithExecution } from './lib/runExecution';
import { isClaimedRunStatus, isRunClaimLeaseActive } from './lib/runLease';
import {
	deleteQueuedMessage,
	isQueuedAttachment,
	MESSAGE_QUEUE_LEASE_MS,
	MESSAGE_QUEUE_LIMIT,
	queuedSubmission
} from './lib/messageQueue';

const vMessageSummary = v.object({
	id: v.string(),
	userId: v.string(),
	threadId: v.id('threadRecords'),
	prompt: v.string(),
	attachmentNames: v.array(v.string()),
	status: v.union(v.literal('queued'), v.literal('sending'), v.literal('failed')),
	error: v.optional(v.string())
});

export const list = query({
	args: {},
	returns: v.array(vMessageSummary),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);

		const messages = await ctx.db
			.query('queuedMessages')
			.withIndex('by_userId_submissionId', (q) => q.eq('userId', userId))
			.take(MESSAGE_QUEUE_LIMIT);

		return messages
			.sort((a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id))
			.map((message) => ({
				id: message.submissionId,
				userId,
				threadId: message.threadId,
				prompt: message.prompt,
				attachmentNames: message.attachmentNames,
				status: message.status,
				error: message.error
			}));
	}
});

export const enqueue = mutation({
	args: {
		machineId: v.string(),
		credential: v.string(),
		threadId: v.id('threadRecords'),
		submissionId: v.string(),
		executionSecret: v.string(),
		workspacePath: v.string(),
		prompt: v.string(),
		storageIds: v.array(v.id('_storage')),
		selectedModel: v.string(),
		completionProvider: vCompletionProvider,
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean()
	},
	returns: v.null(),
	handler: async (ctx, { credential, ...args }) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const machine = await getOwnedMachine(ctx, userId, args.machineId);

		if (
			!machine ||
			!isMachineActive(machine) ||
			machine.credentialHash !== (await executionSecretHash(credential))
		) {
			throw new Error('Machine is not active.');
		}

		const existing = await ownedMessage(ctx, userId, args.submissionId);

		if (existing) {
			// SAFETY: the validator restricts args to the fields of this request type.
			for (const key of Object.keys(args) as (keyof typeof args)[]) {
				if (JSON.stringify(existing[key]) !== JSON.stringify(args[key])) {
					throw new Error('Queued submission does not match the original message.');
				}
			}

			return null;
		}

		// A retried enqueue can arrive after the worker has already delivered it.
		const run = await ctx.db
			.query('runs')
			.withIndex('by_userId_submissionId', (q) =>
				q.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();

		if (run) {
			const prompt = await getPromptPart(ctx, run.threadId, run._id);

			if (
				run.threadId !== args.threadId ||
				run.executionSecretHash !== (await executionSecretHash(args.executionSecret)) ||
				run.machineId !== args.machineId ||
				run.selectedModel !== args.selectedModel ||
				(run.completionProvider ?? 'spikonado') !== args.completionProvider ||
				run.reasoningEffort !== args.reasoningEffort ||
				run.fastMode !== args.fastMode ||
				prompt?.prompt?.text !== args.prompt.trim() ||
				!areStorageIdsEqual(
					prompt.prompt.imageUploads.map((upload) => upload.storageId),
					args.storageIds
				)
			) {
				throw new Error('Submission belongs to a different run.');
			}

			return null;
		}

		const pending = await ctx.db
			.query('queuedMessages')
			.withIndex('by_userId_submissionId', (q) => q.eq('userId', userId))
			.take(MESSAGE_QUEUE_LIMIT);

		if (pending.length >= MESSAGE_QUEUE_LIMIT) throw new Error('Message queue is full.');

		if (args.storageIds.length > 32) throw new Error('Too many queued attachments.');
		const uploads = await getOwnedImageUploadsByStorageIds(ctx, userId, args.storageIds);
		const attachmentNames = uploads.map((upload) => upload.name);
		const encoder = new TextEncoder();

		const pendingBytes = pending.reduce(
			(total, entry) => total + encoder.encode(JSON.stringify(entry)).byteLength,
			0
		);

		if (
			pendingBytes + encoder.encode(JSON.stringify({ ...args, attachmentNames })).byteLength >
			4 * 1024 * 1024
		) {
			throw new Error('Message queue is full.');
		}

		if (!args.prompt.trim() && uploads.length === 0) throw new Error('Message cannot be empty.');

		for (const upload of uploads) {
			if (upload.storageDeletedAt !== undefined || !(await ctx.storage.getUrl(upload.storageId))) {
				throw new Error('Queued attachment is unavailable.');
			}
		}

		const messageId = await ctx.db.insert('queuedMessages', {
			...args,
			userId,
			attachmentNames,
			status: 'queued'
		});

		for (const storageId of args.storageIds) {
			await ctx.db.insert('queuedMessageAttachments', { messageId, storageId });
		}

		return null;
	}
});

export const retry = mutation({
	args: { submissionId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const message = await ownedMessage(ctx, await getUserId(ctx), args.submissionId);

		if (message?.status === 'failed') {
			await ctx.db.patch('queuedMessages', message._id, { status: 'queued', error: undefined });
		}

		return null;
	}
});

export const remove = mutation({
	args: { submissionId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const message = await ownedMessage(ctx, await getUserId(ctx), args.submissionId);

		if (!message) return null;

		if (message.status === 'sending') throw new Error('Message is being sent.');
		await deleteQueuedMessage(ctx, message);

		for (const storageId of message.storageIds) {
			const upload = await imageUploadByStorageId(ctx, storageId);

			if (upload && !upload.attached && !(await isQueuedAttachment(ctx, storageId))) {
				await ctx.storage.delete(storageId);
				await ctx.db.delete('imageUploads', upload._id);
			}
		}

		return null;
	}
});

export const candidates = query({
	args: { machineId: v.string() },
	returns: v.array(v.id('queuedMessages')),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);

		const messages = await ctx.db
			.query('queuedMessages')
			.withIndex('by_userId_machineId', (q) =>
				q.eq('userId', userId).eq('machineId', args.machineId)
			)
			.take(MESSAGE_QUEUE_LIMIT);

		const threads = new Set<Id<'threadRecords'>>();

		return messages.flatMap((message) => {
			if (threads.has(message.threadId)) return [];
			threads.add(message.threadId);

			return [message._id];
		});
	}
});

export const claim = mutation({
	args: {
		messageId: v.id('queuedMessages'),
		machineId: v.string(),
		credential: v.string(),
		claimId: v.string(),
		continuationSubmissionId: v.string(),
		continuationExecutionSecret: v.string()
	},
	returns: v.union(schema.doc('queuedMessages'), v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const message = await ctx.db.get('queuedMessages', args.messageId);

		if (!message || message.userId !== userId || message.machineId !== args.machineId) return null;
		const machine = await getOwnedMachine(ctx, userId, args.machineId);

		if (
			!machine ||
			!isMachineActive(machine) ||
			machine.credentialHash !== (await executionSecretHash(args.credential))
		) {
			throw new Error('Machine is not active.');
		}

		const head = await ctx.db
			.query('queuedMessages')
			.withIndex('by_threadId', (q) => q.eq('threadId', message.threadId))
			.first();

		if (head?._id !== message._id) return null;

		if ((message.claimExpiresAt ?? 0) > Date.now()) return null;
		const existingRun = await queuedSubmission(ctx, message);

		// The transcript and run commit together. A lost launch acknowledgement
		// must never insert or execute the same user message again.
		if (existingRun && existingRun.status !== 'queued') {
			await deleteQueuedMessage(ctx, message);

			return null;
		}

		const latest = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', message.threadId))
			.order('desc')
			.first();

		const continuationRun = message.continuation
			? await queuedSubmission(ctx, { userId, submissionId: message.continuation.submissionId })
			: null;

		if (
			message.continuation &&
			((continuationRun && continuationRun.status !== 'queued') ||
				(!continuationRun &&
					(latest?._id !== message.continuation.continuationOfRunId ||
						latest.status === 'cancelled' ||
						latest.cancellationRequestedAt !== undefined)))
		) {
			await clearContinuation(ctx, message);

			return null;
		}

		if (message.status === 'failed') return null;

		if (!existingRun && !continuationRun) {
			if (machine.runIds.length >= MAX_ACTIVE_MACHINE_RUNS) return null;

			const execution = latest ? await getRunWithExecution(ctx.db, latest._id) : null;

			if (
				latest &&
				!isRunFinalStatus(latest.status) &&
				(!execution ||
					!isClaimedRunStatus(execution.status) ||
					isRunClaimLeaseActive(execution, Date.now()))
			) {
				return null;
			}

			if (!(await submissionReadiness(ctx, message.threadId))) return null;

			if (await headActionablePendingQuestion(ctx.db, message.threadId)) return null;

			if (latest && (await hasAnsweredQuestionContinuation(ctx.db, latest._id))) {
				const continuation = await questionContinuation(ctx, {
					threadId: message.threadId,
					runId: latest._id
				});

				if (continuation && !message.continuation) {
					if (
						!args.continuationSubmissionId.trim() ||
						!args.continuationExecutionSecret.trim() ||
						args.continuationExecutionSecret === message.executionSecret ||
						(await ownedMessage(ctx, userId, args.continuationSubmissionId)) ||
						(await queuedSubmission(ctx, {
							userId,
							submissionId: args.continuationSubmissionId
						}))
					) {
						throw new Error('Question continuation requires a fresh submission and capability.');
					}

					// Commit the recovery inputs with the lease before the worker launches.
					// The follow-up and its attachments remain untouched until this run finishes.
					await ctx.db.patch('queuedMessages', message._id, {
						continuation: {
							submissionId: args.continuationSubmissionId,
							executionSecret: args.continuationExecutionSecret,
							continuationOfRunId: latest._id,
							prompt: continuation.prompt,
							selectedModel: latest.selectedModel,
							completionProvider: latest.completionProvider ?? 'spikonado',
							reasoningEffort: latest.reasoningEffort,
							fastMode: latest.fastMode
						}
					});
				}
			}
		}

		await ctx.db.patch('queuedMessages', message._id, {
			status: 'sending',
			claimId: args.claimId,
			claimExpiresAt: Date.now() + MESSAGE_QUEUE_LEASE_MS,
			error: undefined
		});

		return await ctx.db.get('queuedMessages', message._id);
	}
});

export const finishAttempt = mutation({
	args: {
		messageId: v.id('queuedMessages'),
		claimId: v.string(),
		error: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const message = await ctx.db.get('queuedMessages', args.messageId);

		if (!message || message.userId !== userId || message.claimId !== args.claimId) return null;

		const run = await queuedSubmission(ctx, {
			userId,
			submissionId: message.continuation?.submissionId ?? message.submissionId
		});

		if (run && run.status !== 'queued') {
			if (message.continuation) await clearContinuation(ctx, message);
			else await deleteQueuedMessage(ctx, message);
		} else if (args.error && !run) {
			await ctx.db.patch('queuedMessages', message._id, {
				status: 'failed',
				error: args.error.slice(0, 2_000),
				claimId: undefined,
				claimExpiresAt: undefined
			});
		}

		// If startup or its response is still uncertain, keep the lease and
		// capability. The next worker recovers it after the lease expires.
		return null;
	}
});

async function clearContinuation(ctx: MutationCtx, message: Doc<'queuedMessages'>) {
	await ctx.db.patch('queuedMessages', message._id, {
		continuation: undefined,
		status: 'queued',
		claimId: undefined,
		claimExpiresAt: undefined,
		error: undefined
	});
}

async function ownedMessage(ctx: MutationCtx, userId: string, submissionId: string) {
	return await ctx.db
		.query('queuedMessages')
		.withIndex('by_userId_submissionId', (q) =>
			q.eq('userId', userId).eq('submissionId', submissionId)
		)
		.unique();
}
