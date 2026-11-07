import { v } from 'convex/values';
import { z } from 'zod';
import { internal } from '@convex/_generated/api';
import { internalMutation, internalQuery, type QueryCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { getUserBySubject } from '@convex/lib/auth';

const LIVE_STATUSES = ['active', 'on_hold', 'past_due', 'paused', 'pending'] as const;

const AUDIT_LIMIT = 1_000;

const legacyPayload = z.object({
	data: z.object({ metadata: z.object({ userId: z.string().optional() }).optional() }).optional()
});

async function ownerOf(ctx: QueryCtx, event: Doc<'dodoWebhookEvents'>) {
	const byCustomer = event.customerId
		? await ctx.db
				.query('users')
				.withIndex('by_dodoCustomerId', (query) => query.eq('dodoCustomerId', event.customerId))
				.unique()
		: null;

	if (byCustomer) return byCustomer;

	const metadataUserId = event.payload
		? legacyPayload.safeParse(JSON.parse(event.payload)).data?.data?.metadata?.userId
		: undefined;

	return metadataUserId ? await getUserBySubject(ctx.db, metadataUserId) : null;
}

/**
 * Lists Dodo deliveries the old webhook ledger refused and users the mirror shows with more
 * than one live subscription, so an operator can refund double charges.
 */
export const listDoubleCharges = internalQuery({
	args: {},
	returns: v.object({
		rejectedEvents: v.array(
			v.object({
				webhookId: v.string(),
				eventType: v.string(),
				outcome: v.string(),
				outcomeDetail: v.optional(v.string()),
				receivedAt: v.number(),
				dodoSubscriptionId: v.optional(v.string()),
				dodoCustomerId: v.optional(v.string()),
				user: v.union(v.object({ subject: v.string(), email: v.string() }), v.null())
			})
		),
		usersWithSeveralLiveSubscriptions: v.array(
			v.object({
				userId: v.string(),
				email: v.optional(v.string()),
				dodoSubscriptionIds: v.array(v.string())
			})
		)
	}),
	handler: async (ctx) => {
		const events = (
			await Promise.all(
				(['competing', 'unresolved'] as const).map((outcome) =>
					ctx.db
						.query('dodoWebhookEvents')
						.withIndex('by_outcome_and_nextAttemptAt', (query) => query.eq('outcome', outcome))
						.take(AUDIT_LIMIT)
				)
			)
		).flat();

		const rejectedEvents = await Promise.all(
			events.map(async (event) => {
				const user = await ownerOf(ctx, event);

				return {
					webhookId: event.webhookId,
					eventType: event.eventType,
					outcome: event.outcome,
					outcomeDetail: event.outcomeDetail,
					receivedAt: event.receivedAt,
					dodoSubscriptionId: event.subscriptionId,
					dodoCustomerId: event.customerId,
					user: user ? { subject: user.subject, email: user.email } : null
				};
			})
		);

		const liveByUser = new Map<string, string[]>();

		for (const status of LIVE_STATUSES) {
			const rows = await ctx.db
				.query('subscriptions')
				.withIndex('by_status_and_billingPeriodEnd', (query) => query.eq('status', status))
				.take(AUDIT_LIMIT);

			for (const row of rows) {
				if (!row.dodoSubscriptionId) continue;
				liveByUser.set(row.userId, [...(liveByUser.get(row.userId) ?? []), row.dodoSubscriptionId]);
			}
		}

		const usersWithSeveralLiveSubscriptions = [];

		for (const [userId, dodoSubscriptionIds] of liveByUser) {
			if (dodoSubscriptionIds.length < 2) continue;
			const email = (await getUserBySubject(ctx.db, userId))?.email;
			usersWithSeveralLiveSubscriptions.push({ userId, email, dodoSubscriptionIds });
		}

		return { rejectedEvents, usersWithSeveralLiveSubscriptions };
	}
});

/** Deletes the retired webhook ledger once `listDoubleCharges` has been reviewed. */
export const deleteWebhookEvents = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query('dodoWebhookEvents')
			.paginate({ cursor: cursor ?? null, numItems: 200 });

		for (const event of page.page) await ctx.db.delete('dodoWebhookEvents', event._id);

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.billingAudit.deleteWebhookEvents, {
				cursor: page.continueCursor
			});
		}

		return null;
	}
});
