import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import type { MutationCtx } from '@convex/_generated/server';
import type { TableNames } from '@convex/_generated/dataModel';
import { getUserBySubject } from '@convex/lib/auth';
import { transcriptContext } from '@convex/lib/contextHandoff';
import { getOrCreateTranscriptState, withToolInvocationIds } from '@convex/lib/transcriptParts';
import { isRunFinalStatus } from '@convex/lib/validators';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, { schema, internalMutation });

// Spreads the resync's Dodo list calls so up to ~14k customers stay under Dodo's 240 requests a minute.
const DODO_RESYNC_SPREAD_MS = 60 * 60 * 1_000;

async function moveGrants(ctx: MutationCtx, userId: string): Promise<void> {
	const rows = await ctx.db
		.query('subscriptions')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.collect();

	const grants = rows.filter((row) => !row.dodoSubscriptionId && row.tier && row.tier !== 'free');

	if (grants.length === 0) return;

	const winner = grants.reduce((best, row) => {
		const [rowAt, bestAt] = [row.eventAt ?? 0, best.eventAt ?? 0];

		return rowAt > bestAt || (rowAt === bestAt && row.status === 'active') ? row : best;
	});

	if (winner.status === 'active') {
		const user = await getUserBySubject(ctx.db, userId);

		if (!user) {
			console.error(`Tier grant ${winner._id} has no users row; leaving it in place.`);

			return;
		}

		await ctx.db.patch('users', user._id, { grantedTier: user.grantedTier ?? winner.tier });
	}

	for (const grant of grants) await ctx.db.delete('subscriptions', grant._id);
}

function deleteEveryRow(table: TableNames, batchSize?: number) {
	return migrations.define({
		table,
		batchSize,
		migrateOne: async (ctx, row) => {
			await ctx.db.delete(table, row._id);
		}
	});
}

export const backfillToolInvocationIds = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: (_ctx, part) => {
		if (!part.tool || part.tool.toolInvocationId !== undefined) return;

		return { tool: { ...part.tool, toolInvocationId: part.sourceKey } };
	}
});

export const backfillCompletionToolInvocationIds = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: (_ctx, part) => {
		const { completion, work } = part;

		if (!completion || !work.toolInvocations?.length) return;

		const items = withToolInvocationIds(completion.items, work.toolInvocations);

		if (items.some((item, index) => item !== completion.items[index])) {
			return { completion: { ...completion, items } };
		}
	}
});

export const removeArtifactTypes = migrations.define({
	table: 'artifacts',
	migrateOne: (_ctx, artifact) => {
		if (artifact.type === undefined) return;

		return { type: undefined };
	}
});

export const moveTranscriptContext = migrations.define({
	table: 'threadRecords',
	migrateOne: async (ctx, thread) => {
		if (Object.values(transcriptContext(null, thread)).every((value) => value === undefined)) {
			return;
		}

		const state = await getOrCreateTranscriptState(ctx, thread._id);
		await ctx.db.patch('threadTranscriptStates', state._id, transcriptContext(state, thread));

		return {
			contextSummary: undefined,
			contextSummaryPartCount: undefined,
			contextSummaryHandoffKey: undefined,
			reasoningStrippedThroughPartNumber: undefined
		};
	}
});

export const dropQuestionAnsweredAt = migrations.define({
	table: 'agentQuestions',
	migrateOne: (_ctx, question) => {
		if (question.answeredAt !== undefined) return { answeredAt: undefined };
	}
});

export const migrateSubscriptionRows = migrations.define({
	table: 'subscriptions',
	migrateOne: async (ctx, row) => {
		if (row.billingPeriodCheckId) {
			const check = await ctx.db.system.get('_scheduled_functions', row.billingPeriodCheckId);

			if (check?.state.kind === 'pending') await ctx.scheduler.cancel(check._id);
		}

		if (!row.dodoSubscriptionId) {
			if (row.tier && row.tier !== 'free') await moveGrants(ctx, row.userId);
			else await ctx.db.delete('subscriptions', row._id);

			return;
		}

		if (row.syncedAt !== undefined) return;

		await ctx.db.replace('subscriptions', row._id, {
			userId: row.userId,
			dodoSubscriptionId: row.dodoSubscriptionId,
			dodoProductId: row.dodoProductId,
			status: row.status,
			billingPeriodStart: row.billingPeriodStart,
			billingPeriodEnd: row.billingPeriodEnd,
			cancelAtNextBillingDate: row.cancelAtNextBillingDate,
			quotaResetAt: row.quotaResetAt,
			syncedAt: 0
		});
	}
});

export const clearSubscriptionReconciliations = deleteEveryRow('subscriptionReconciliations');

export const clearSupersededSubscriptions = deleteEveryRow('supersededSubscriptions');

export const clearCheckoutSessions = deleteEveryRow('billingCheckoutSessions');

export const clearCheckoutAttempts = deleteEveryRow('billingCheckoutAttempts');

export const clearPricingCache = deleteEveryRow('dodoPricingCache');

export const clearCommandSessions = deleteEveryRow('commandSessions');

// Each chunk holds up to 128 KiB, so the default 100-row batch nears the 16 MiB read limit.
export const clearCommandLogChunks = deleteEveryRow('commandLogChunks', 20);

export const resyncDodoCustomers = migrations.define({
	table: 'users',
	customRange: (query) =>
		query.withIndex('by_dodoCustomerId', (index) => index.gte('dodoCustomerId', '')),
	migrateOne: async (ctx, user) => {
		if (!user.dodoCustomerId) return;

		await ctx.scheduler.runAfter(
			Math.floor(Math.random() * DODO_RESYNC_SPREAD_MS),
			internal.dodo.syncCustomer,
			{ dodoCustomerId: user.dodoCustomerId }
		);
	}
});

export const backfillThreadCompletionProviders = migrations.define({
	table: 'threadRecords',
	migrateOne: (_ctx, thread) => {
		if (thread.completionProvider === undefined)
			return { completionProvider: 'spikonado' as const };
	}
});

export const backfillRunCompletionProviders = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.completionProvider === undefined) return { completionProvider: 'spikonado' as const };
	}
});

export const clearUsageLimitFailureKinds = migrations.define({
	table: 'runs',
	migrateOne: (_ctx, run) => {
		if (run.failureKind === 'usage_limit') return { failureKind: undefined };
	}
});

export const dropShareConversationContent = migrations.define({
	table: 'uiPreferences',
	migrateOne: (_ctx, preferences) => {
		if (preferences.shareConversationContent !== undefined) {
			return { shareConversationContent: undefined };
		}
	}
});

export const deleteToolImages = migrations.define({
	table: 'imageUploads',
	migrateOne: async (ctx, upload) => {
		if (upload.sha256 === undefined) return;

		// Released agents reuse a tool image's URL until their run ends.
		const thread = upload.threadId && (await ctx.db.get('threadRecords', upload.threadId));

		if (thread && !isRunFinalStatus(thread.status)) return;

		if (upload.storageDeletedAt === undefined) await ctx.storage.delete(upload.storageId);
		await ctx.db.delete('imageUploads', upload._id);
	}
});

export const run = migrations.runner([
	internal.migrations.backfillToolInvocationIds,
	internal.migrations.backfillCompletionToolInvocationIds,
	internal.migrations.removeArtifactTypes,
	internal.migrations.moveTranscriptContext,
	internal.migrations.dropQuestionAnsweredAt,
	internal.migrations.migrateSubscriptionRows,
	internal.migrations.clearSubscriptionReconciliations,
	internal.migrations.clearSupersededSubscriptions,
	internal.migrations.clearCheckoutSessions,
	internal.migrations.clearCheckoutAttempts,
	internal.migrations.clearPricingCache,
	internal.migrations.clearCommandSessions,
	internal.migrations.clearCommandLogChunks,
	internal.migrations.resyncDodoCustomers,
	internal.migrations.backfillThreadCompletionProviders,
	internal.migrations.backfillRunCompletionProviders,
	internal.migrations.clearUsageLimitFailureKinds,
	internal.migrations.dropShareConversationContent,
	internal.migrations.deleteToolImages
]);
