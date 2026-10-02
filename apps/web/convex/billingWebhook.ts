import { Workpool, vOnCompleteArgs, type WorkId } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { components, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import {
	env,
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx
} from '@convex/_generated/server';
import { z } from 'zod';
import { classifyBillingInterval, readDodoEnvironment } from '@convex/lib/dodoProducts';

// Dedicated pool so webhook processing never competes with web-search or
// scrape work; bounded parallelism keeps projection writes predictable.
export const billingWebhookWorkpool = new Workpool(components.billingWebhookWorkpool, {
	maxParallelism: 4
});

// Provider retry horizon is ~28h with manual bulk replay over two weeks;
// dedup retention must cover the replay horizon.
const DEDUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

// Payloads are replayable for 48h; compact identity/outcome rows persist
// for the full dedup retention after payload cleanup.
const PAYLOAD_RETENTION_MS = 48 * 60 * 60 * 1_000;

// Signed payloads beyond this size are rejected before persistence.
const MAX_PAYLOAD_BYTES = 256 * 1_024;

const MAX_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 30 * 1_000;

const MAX_BACKOFF_MS = 10 * 60 * 1_000;

const RETRY_BATCH_SIZE = 10;

const CLEANUP_BATCH_SIZE = 50;

const subscriptionDataSchema = z.object({
	payload_type: z.literal('Subscription'),
	subscription_id: z.string(),
	product_id: z.string(),
	status: z.enum([
		'pending',
		'active',
		'on_hold',
		'paused',
		'cancelled',
		'failed',
		'expired',
		'past_due'
	]),
	previous_billing_date: z.string(),
	next_billing_date: z.string(),
	cancel_at_next_billing_date: z.boolean(),
	payment_frequency_count: z.number(),
	payment_frequency_interval: z.string(),
	customer: z.object({ customer_id: z.string() }),
	metadata: z
		.object({
			userId: z.string().optional(),
			tierId: z.string().optional(),
			checkoutAttemptId: z.string().optional()
		})
		.optional(),
	scheduled_change: z
		.object({
			id: z.string(),
			product_id: z.string(),
			effective_at: z.string()
		})
		.nullable()
		.optional()
});

const eventEnvelopeSchema = z.object({
	business_id: z.string().optional(),
	type: z.string(),
	timestamp: z.string().optional(),
	data: z.unknown()
});

// Storage schema for compaction: identical allowlist to the strict
// processing schema, but `status` is a plain string so an unrecognized
// provider status stays durable and replayable after a repair that teaches
// the projection about it. `applyEvent` still gates on the strict enum, so
// this never causes an unknown status to be applied.
const compactSubscriptionDataSchema = subscriptionDataSchema.extend({
	status: z.string()
});

function toEpochMs(timestamp: string | undefined, field: string): number {
	if (!timestamp) throw new Error(`Dodo webhook is missing ${field}.`);

	const ms = Date.parse(timestamp);

	if (!Number.isFinite(ms)) throw new Error(`Dodo webhook has an invalid ${field}.`);

	return ms;
}

function verifiedEnvironment(): string {
	return readDodoEnvironment(env);
}

function backoffMs(attempts: number): number {
	const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));

	return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Compact, privacy-allowlisted, replayable payload: the provider envelope
 * with subscription data reduced to the fields the projection consumes.
 * Customer details beyond the id, billing address, add-ons, amounts, and
 * other provider extras never reach durable storage or logs.
 */
function compactPayload(raw: string): string {
	const envelope = eventEnvelopeSchema.parse(JSON.parse(raw));
	const data = compactSubscriptionDataSchema.safeParse(envelope.data);

	if (!data.success)
		return JSON.stringify({ type: envelope.type, timestamp: envelope.timestamp, data: null });

	const subscription = data.data;

	return JSON.stringify({
		type: envelope.type,
		timestamp: envelope.timestamp,
		data: {
			payload_type: subscription.payload_type,
			subscription_id: subscription.subscription_id,
			product_id: subscription.product_id,
			status: subscription.status,
			previous_billing_date: subscription.previous_billing_date,
			next_billing_date: subscription.next_billing_date,
			cancel_at_next_billing_date: subscription.cancel_at_next_billing_date,
			payment_frequency_count: subscription.payment_frequency_count,
			payment_frequency_interval: subscription.payment_frequency_interval,
			customer: { customer_id: subscription.customer.customer_id },
			metadata: subscription.metadata,
			scheduled_change: subscription.scheduled_change ?? null
		}
	});
}

/**
 * Durable ingestion entry point. The signature over the raw request body is
 * verified first; the verified event is then persisted and enqueued to the
 * workpool in one atomic mutation, so an acknowledged event is always
 * durably queued and a partial failure surfaces as a 500 for provider retry.
 */
export const ingest = internalAction({
	args: {
		body: v.string(),
		webhookId: v.string(),
		webhookSignature: v.string(),
		webhookTimestamp: v.string()
	},
	returns: v.object({ stored: v.boolean(), duplicate: v.boolean() }),
	handler: async (ctx, args): Promise<{ stored: boolean; duplicate: boolean }> => {
		if (new TextEncoder().encode(args.body).length > MAX_PAYLOAD_BYTES) {
			throw new Error('Dodo webhook payload exceeds the size limit.');
		}

		const verified = await ctx.runAction(internal.pricing.verifyWebhookSignature, {
			body: args.body,
			webhookId: args.webhookId,
			webhookSignature: args.webhookSignature,
			webhookTimestamp: args.webhookTimestamp
		});

		return await ctx.runMutation(internal.billingWebhook.recordEvent, {
			environment: verifiedEnvironment(),
			webhookId: args.webhookId,
			eventType: verified.eventType,
			eventAt: verified.eventAt,
			subscriptionId: verified.subscriptionId,
			productId: verified.productId,
			customerId: verified.customerId,
			// recordEvent owns compaction at the persistence boundary.
			payload: args.body
		});
	}
});

export const recordEvent = internalMutation({
	args: {
		environment: v.string(),
		webhookId: v.string(),
		eventType: v.string(),
		eventAt: v.optional(v.number()),
		subscriptionId: v.optional(v.string()),
		productId: v.optional(v.string()),
		customerId: v.optional(v.string()),
		payload: v.string()
	},
	returns: v.object({ stored: v.boolean(), duplicate: v.boolean() }),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('dodoWebhookEvents')
			.withIndex('by_environment_and_webhookId', (query) =>
				query.eq('environment', args.environment).eq('webhookId', args.webhookId)
			)
			.unique();

		if (existing) {
			// Preserve the original processing outcome; redelivery only bumps the
			// duplicate counter so incident/replay lookup keeps the real result.
			await ctx.db.patch('dodoWebhookEvents', existing._id, {
				duplicateCount: (existing.duplicateCount ?? 0) + 1
			});

			return { stored: true, duplicate: true };
		}

		// Backfill safety for rows inserted before `seq` existed: the backfill
		// stamps seq = -_creationTime, so live inserts always sort after them.
		const newest = await ctx.db
			.query('dodoWebhookEvents')
			.withIndex('by_seq')
			.order('desc')
			.first();

		const seq = Math.max(0, (newest?.seq ?? -1) + 1);

		const eventId = await ctx.db.insert('dodoWebhookEvents', {
			...args,
			payload: compactPayload(args.payload),
			seq,
			receivedAt: Date.now(),
			attempts: 0,
			outcome: 'pending'
		});

		// Enqueue in the same transaction as the insert: a committed event is
		// always queued, and an enqueue failure rolls the insert back.
		const workId = await billingWebhookWorkpool.enqueueMutation(
			ctx,
			internal.billingWebhook.processEvent,
			{ eventId },
			{
				onComplete: internal.billingWebhook.completeProcessing,
				context: { eventId }
			}
		);

		await ctx.db.patch('dodoWebhookEvents', eventId, { workId });

		return { stored: true, duplicate: false };
	}
});

// Subscription lifecycle events whose signed payloads we apply. The payload's
// own status is authoritative; other event types stay durable but unsupported.
const SUPPORTED_SUBSCRIPTION_EVENTS = new Set([
	'subscription.active',
	'subscription.renewed',
	'subscription.plan_changed',
	'subscription.updated',
	'subscription.on_hold',
	'subscription.past_due',
	'subscription.update_payment_method',
	'subscription.cancelled',
	'subscription.expired',
	'subscription.failed'
]);

const vLedgerOutcome = v.union(
	v.literal('applied'),
	v.literal('stale'),
	v.literal('noop'),
	v.literal('unsupported'),
	v.literal('unresolved'),
	v.literal('competing')
);

type LedgerOutcome = 'applied' | 'stale' | 'noop' | 'unsupported' | 'unresolved' | 'competing';

async function applyEvent(
	ctx: MutationCtx,
	event: Doc<'dodoWebhookEvents'>
): Promise<{ outcome: LedgerOutcome; detail?: string }> {
	const envelope = eventEnvelopeSchema.parse(JSON.parse(event.payload!));

	if (!SUPPORTED_SUBSCRIPTION_EVENTS.has(envelope.type)) {
		// Includes subscription.paused/unpaused, payment.*, refund/dispute, and
		// anything else we do not handle: durable and observable, never applied.
		return { outcome: 'unsupported', detail: `Unhandled event type ${envelope.type}.` };
	}

	const parsed = subscriptionDataSchema.safeParse(envelope.data);

	if (!parsed.success) {
		return {
			outcome: 'unsupported',
			detail: `Unrecognized subscription payload for ${envelope.type}.`
		};
	}

	const data = parsed.data;

	if (data.status === 'paused' || data.status === 'pending') {
		return {
			outcome: 'unsupported',
			detail: `Unsupported subscription status "${data.status}".`
		};
	}

	const interval = classifyBillingInterval(
		data.payment_frequency_count,
		data.payment_frequency_interval
	);

	if (!interval) {
		return { outcome: 'unresolved', detail: 'Unsupported billing interval on subscription.' };
	}

	const eventAt = toEpochMs(envelope.timestamp, 'timestamp');

	const result = await ctx.runMutation(internal.billing.upsertDodoSubscription, {
		userId: data.metadata?.userId,
		tier: data.metadata?.tierId,
		checkoutAttemptId: data.metadata?.checkoutAttemptId,
		dodoSubscriptionId: data.subscription_id,
		dodoProductId: data.product_id,
		dodoCustomerId: data.customer.customer_id,
		// The payload's actual status is authoritative; lifecycle events
		// (plan_changed, updated) still carry it.
		status: data.status,
		eventAt,
		billingInterval: interval,
		billingPeriodStart: toEpochMs(data.previous_billing_date, 'previous_billing_date'),
		billingPeriodEnd: toEpochMs(data.next_billing_date, 'next_billing_date'),
		cancelAtNextBillingDate: data.cancel_at_next_billing_date,
		scheduledChange: data.scheduled_change
			? {
					id: data.scheduled_change.id,
					productId: data.scheduled_change.product_id,
					effectiveAt: toEpochMs(
						data.scheduled_change.effective_at,
						'scheduled_change.effective_at'
					)
				}
			: null
	});

	switch (result.outcome) {
		case 'applied':
			return { outcome: 'applied' };
		case 'stale':
			return { outcome: 'stale', detail: result.detail };
		case 'competing':
			return { outcome: 'competing', detail: result.detail };
		case 'unresolved':
			return { outcome: 'unresolved', detail: result.detail };
		default:
			return { outcome: 'noop', detail: result.detail };
	}
}

/**
 * Workpool worker. Applies the projection and records the ledger outcome in
 * one mutation; when the projection upsert throws, Convex rolls the whole
 * mutation back so no partial projection commits beside a failed ledger, and
 * the workpool reports the failure to `completeProcessing` for bounded retry
 * bookkeeping. Payload-less events (payload already pruned by retention) can
 * never be re-applied; their identity/outcome row is the durable record.
 */
export const processEvent = internalMutation({
	args: { eventId: v.id('dodoWebhookEvents') },
	returns: vLedgerOutcome,
	handler: async (ctx, { eventId }): Promise<LedgerOutcome> => {
		const event = await ctx.db.get('dodoWebhookEvents', eventId);

		if (!event || event.outcome !== 'pending') return 'noop';

		if (!event.payload) throw new Error('Webhook event payload has been pruned.');

		const applied = await applyEvent(ctx, event);

		await ctx.db.patch('dodoWebhookEvents', eventId, {
			attempts: event.attempts + 1,
			outcome: applied.outcome,
			outcomeDetail: applied.detail,
			processedAt: Date.now(),
			nextAttemptAt: undefined
		});

		return applied.outcome;
	}
});

/**
 * Workpool completion callback, separate from the projection mutation. Only
 * thrown runs land here as failures; they are retried with bounded backoff
 * until attempts are exhausted, after which the event stays 'failed' for
 * operator replay.
 */
export const completeProcessing = internalMutation({
	args: vOnCompleteArgs(v.object({ eventId: v.id('dodoWebhookEvents') })),
	returns: v.null(),
	handler: async (ctx, { context, result, workId }) => {
		const event = await ctx.db.get('dodoWebhookEvents', context.eventId);

		if (!event || event.outcome !== 'pending' || event.workId !== workId) return null;

		if (result.kind === 'success') return null;

		const attempts = event.attempts + 1;

		if (result.kind === 'canceled' || attempts >= MAX_ATTEMPTS) {
			await ctx.db.patch('dodoWebhookEvents', context.eventId, {
				attempts,
				outcome: 'failed',
				outcomeDetail:
					result.kind === 'canceled'
						? 'Processing was canceled.'
						: 'Processing failed; operator replay required.',
				processedAt: Date.now(),
				nextAttemptAt: undefined
			});

			return null;
		}

		const nextAttemptAt = Date.now() + backoffMs(attempts);

		await ctx.db.patch('dodoWebhookEvents', context.eventId, {
			attempts,
			outcomeDetail: 'Processing failed; retry scheduled.',
			nextAttemptAt
		});

		const nextWorkId = await billingWebhookWorkpool.enqueueMutation(
			ctx,
			internal.billingWebhook.processEvent,
			{ eventId: context.eventId },
			{
				runAt: nextAttemptAt,
				onComplete: internal.billingWebhook.completeProcessing,
				context: { eventId: context.eventId }
			}
		);

		await ctx.db.patch('dodoWebhookEvents', context.eventId, { workId: nextWorkId });

		return null;
	}
});

/** Cron-driven pump re-enqueues events whose scheduled retry was lost. */
export const retryPending = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();

		const stuck = await ctx.db
			.query('dodoWebhookEvents')
			.withIndex('by_outcome_and_nextAttemptAt', (query) =>
				query.eq('outcome', 'pending').lte('nextAttemptAt', now)
			)
			.take(RETRY_BATCH_SIZE);

		for (const event of stuck) {
			if (event.attempts >= MAX_ATTEMPTS) continue;

			if (event.workId) {
				// SAFETY: only workpool enqueue results populate this stored field.
				const status = await billingWebhookWorkpool.status(ctx, event.workId as WorkId);

				if (status.state !== 'finished') continue;
			}

			const workId = await billingWebhookWorkpool.enqueueMutation(
				ctx,
				internal.billingWebhook.processEvent,
				{ eventId: event._id },
				{
					onComplete: internal.billingWebhook.completeProcessing,
					context: { eventId: event._id }
				}
			);

			await ctx.db.patch('dodoWebhookEvents', event._id, { workId });
		}

		return null;
	}
});

/** Operator replay after configuration repair; requires a retained payload. */
export const replayEvent = internalMutation({
	args: { eventId: v.id('dodoWebhookEvents') },
	returns: v.null(),
	handler: async (ctx, { eventId }) => {
		const event = await ctx.db.get('dodoWebhookEvents', eventId);

		if (!event) throw new Error('Unknown webhook event.');

		if (event.outcome === 'pending') return null;

		if (!event.payload) {
			throw new Error('Webhook event payload has been pruned; replay from the provider instead.');
		}

		await ctx.db.patch('dodoWebhookEvents', eventId, {
			outcome: 'pending',
			attempts: 0,
			outcomeDetail: undefined,
			nextAttemptAt: undefined
		});

		const workId = await billingWebhookWorkpool.enqueueMutation(
			ctx,
			internal.billingWebhook.processEvent,
			{ eventId },
			{
				onComplete: internal.billingWebhook.completeProcessing,
				context: { eventId }
			}
		);

		await ctx.db.patch('dodoWebhookEvents', eventId, { workId });

		return null;
	}
});

/** Protected lookup for unresolved/competing/exhausted processing. */
export const listProblemEvents = internalQuery({
	args: { limit: v.optional(v.number()) },
	returns: v.array(
		v.object({
			eventId: v.id('dodoWebhookEvents'),
			webhookId: v.string(),
			eventType: v.string(),
			outcome: v.string(),
			outcomeDetail: v.optional(v.string()),
			attempts: v.number(),
			receivedAt: v.number(),
			subscriptionId: v.optional(v.string())
		})
	),
	handler: async (ctx, { limit }) => {
		const boundedLimit = Math.min(50, Math.max(1, Math.floor(limit ?? 50)));
		const outcomes = ['unresolved', 'competing', 'failed', 'unsupported'] as const;
		const events: Doc<'dodoWebhookEvents'>[] = [];

		for (const outcome of outcomes) {
			const rows = await ctx.db
				.query('dodoWebhookEvents')
				.withIndex('by_outcome_and_nextAttemptAt', (query) => query.eq('outcome', outcome))
				.take(boundedLimit);

			events.push(...rows);
		}

		return events
			.sort((a, b) => b.receivedAt - a.receivedAt)
			.slice(0, boundedLimit)
			.map((event) => ({
				eventId: event._id,
				webhookId: event.webhookId,
				eventType: event.eventType,
				outcome: event.outcome,
				outcomeDetail: event.outcomeDetail,
				attempts: event.attempts,
				receivedAt: event.receivedAt,
				subscriptionId: event.subscriptionId
			}));
	}
});

/**
 * Finite retention driven by a persisted cursor over the ingestion sequence.
 * Payloads are pruned after PAYLOAD_RETENTION_MS while compact
 * identity/outcome rows are kept for DEDUP_RETENTION_MS, so dedup and
 * incident lookup survive payload cleanup. The cursor prevents rescanning
 * the newest rows on every run, which would starve the older remainder.
 */
export const cleanupEvents = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();

		const state = await ctx.db
			.query('dodoWebhookCleanup')
			.withIndex('by_key', (query) => query.eq('key', 'cleanup'))
			.unique();

		let cursor = state?.cursor ?? -Number.MAX_VALUE;

		let batch = await ctx.db
			.query('dodoWebhookEvents')
			.withIndex('by_seq', (query) => query.gt('seq', cursor))
			.take(CLEANUP_BATCH_SIZE);

		if (batch.length === 0) {
			cursor = -Number.MAX_VALUE;
			batch = await ctx.db
				.query('dodoWebhookEvents')
				.withIndex('by_seq', (query) => query.gt('seq', cursor))
				.take(CLEANUP_BATCH_SIZE);
		}

		for (const event of batch) {
			if (event.receivedAt < now - DEDUP_RETENTION_MS) {
				await ctx.db.delete('dodoWebhookEvents', event._id);
			} else if (event.payload !== undefined && event.receivedAt < now - PAYLOAD_RETENTION_MS) {
				await ctx.db.patch('dodoWebhookEvents', event._id, { payload: undefined });
			}
		}

		const lastSeq = batch.at(-1)?.seq ?? cursor;

		if (state) {
			await ctx.db.patch('dodoWebhookCleanup', state._id, { cursor: lastSeq });
		} else {
			await ctx.db.insert('dodoWebhookCleanup', { key: 'cleanup', cursor: lastSeq });
		}

		return null;
	}
});

/** Backfill `seq` for rows inserted before the ingestion sequence existed. */
export const backfillSequences = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const missing = await ctx.db
			.query('dodoWebhookEvents')
			// eslint-disable-next-line @convex-dev/no-filter-in-query -- One-off bounded backfill for legacy rows without the indexed sequence.
			.filter((query) => query.eq(query.field('seq'), undefined))
			.take(CLEANUP_BATCH_SIZE);

		for (const event of missing) {
			// Negative creation-time ordering keeps backfilled rows before live
			// inserts while preserving their original arrival order.
			await ctx.db.patch('dodoWebhookEvents', event._id, { seq: -event._creationTime });
		}

		return null;
	}
});
