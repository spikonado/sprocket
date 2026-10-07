import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, type MutationCtx } from '@convex/_generated/server';
import { bumpRegistry } from '@convex/lib/artifactRegistry';
import type { FunctionReference } from 'convex/server';
import schema from '@convex/schema';
import { v } from 'convex/values';
import { z } from 'zod';
import { isRunFinalStatus } from '@convex/lib/validators';
import { reconcileTerminalRun } from '@convex/lib/runTerminal';
import { refreshThreadHierarchyActivity } from '@convex/lib/threadHierarchy';
import { commandToolDisplayInput } from '@convex/lib/transcriptWrites';
import { isCommandToolKind } from '@convex/lib/commandToolKinds';
import { computeAccess } from '@convex/lib/subscriptionProjection';
import { scheduleSubscriptionExpiry } from '@convex/subscriptionExpiry';

// Backfills for legacy stored fields that predate their validators. Current
// code never writes these fields, so the migrations need no start delay and
// are safe to trigger from the CLI as soon as they deploy:
//
//   bunx convex run migrations:runLegacyCompatBackfill '{"dryRun":true}'
//   bunx convex run migrations:runLegacyCompatBackfill
//
// The hourly cron runs the same set automatically. `migrateToolPartJobIds`
// must run after `backfillExecutorJobToolInvocationId` because it resolves
// each part's job to compute the invocation id.

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

export const reconcileLegacyTerminalJobs = migrations.define({
	table: 'runExecutionStates',
	batchSize: 1,
	migrateOne: async (ctx, state) => {
		if (state.terminalJobsReconciled !== undefined) return;
		const run = await ctx.db.get('runs', state.runId);

		if (!run || !isRunFinalStatus(run.status)) return;

		await reconcileTerminalRun(ctx, run, {
			completedAt: run.completedAt ?? Date.now(),
			jobCursor: -1,
			questionCursor: -1
		});
	}
});

export const runTerminalJobBackfill = migrations.runner([
	internal.migrations.reconcileLegacyTerminalJobs
]);

export const backfillThreadHierarchyWorkingCounts = migrations.define({
	table: 'threadRecords',
	batchSize: 1,
	migrateOne: async (ctx, thread) => {
		await refreshThreadHierarchyActivity(ctx, thread._id);
	}
});

// Keep the former entrypoint for migration batches scheduled before this deploy.
export const backfillThreadHierarchyStatuses = backfillThreadHierarchyWorkingCounts;

const threadHierarchyWorkingMigrations: FunctionReference<'mutation', 'internal'>[] = [
	internal.migrations.backfillThreadHierarchyWorkingCounts
];

export const runThreadHierarchyStatusBackfill = migrations.runner(threadHierarchyWorkingMigrations);

export const backfillSubscriptionExpiry = migrations.define({
	table: 'subscriptions',
	migrateOne: async (ctx, subscription) => {
		if (!subscription.dodoSubscriptionId) return;

		await scheduleSubscriptionExpiry(ctx, subscription);
	}
});

export const runSubscriptionExpiryBackfill = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await migrations.runOne(ctx, internal.migrations.backfillSubscriptionExpiry);

		return null;
	}
});

/**
 * Backfill access phase/deadline, projection revision, and payload watermark
 * for subscriptions written before those fields existed. Idempotent: rows
 * that already carry every field are skipped. Kept off the automatic hourly
 * run so an operator can verify a dry run first:
 *
 *   bunx convex run migrations:runSubscriptionAccessBackfill '{"dryRun":true}'
 *   bunx convex run migrations:runSubscriptionAccessBackfill
 */
export const backfillSubscriptionAccess = migrations.define({
	table: 'subscriptions',
	migrateOne: async (ctx, subscription) => {
		const hasRevision = subscription.projectionRevision !== undefined;
		const hasPayloadWatermark = subscription.payloadEventAt !== undefined;
		const hasAccess = subscription.accessPhase !== undefined;
		const hasGeneration = subscription.quotaGeneration !== undefined;

		if (
			hasRevision &&
			hasPayloadWatermark &&
			hasAccess &&
			hasGeneration &&
			subscription.scheduleEventAt !== undefined
		)
			return;

		// Long-expired terms must not gain fresh grace: clamp the backfilled
		// clock so a stale term never materializes a renewal-processing window.
		const now = Date.now();

		const access = computeAccess(
			{
				status: subscription.status,
				dodoSubscriptionId: subscription.dodoSubscriptionId,
				billingPeriodStart: subscription.billingPeriodStart,
				billingPeriodEnd: subscription.billingPeriodEnd,
				cancelAtNextBillingDate: subscription.cancelAtNextBillingDate
			},
			now
		);

		// Derive the monotonic usage generation from the legacy timestamp key:
		// bucket keys keep moving with the same value they already used, so the
		// migration itself neither resets usage nor mints extra allowance. The
		// legacy key is preserved only on rows that already carry it; a legacy
		// row without quotaResetAt never gains one, so its original
		// rate-limiter bucket key stays untouched.
		const quotaGeneration = subscription.quotaGeneration ?? subscription.quotaResetAt ?? 0;

		const patch = {
			projectionRevision: subscription.projectionRevision ?? 1,
			payloadEventAt: subscription.payloadEventAt ?? subscription.eventAt,
			termEventAt: subscription.termEventAt ?? subscription.eventAt,
			scheduleEventAt:
				subscription.scheduleEventAt ?? subscription.payloadEventAt ?? subscription.eventAt,
			providerStatus: subscription.providerStatus ?? subscription.status,
			accessPhase: subscription.accessPhase ?? access.accessPhase,
			accessEndsAt: subscription.accessEndsAt ?? access.accessEndsAt,
			quotaGeneration,
			quotaTransitionAt: subscription.quotaTransitionAt ?? subscription.quotaResetAt,
			quotaResetAt: subscription.quotaResetAt
		};

		await ctx.db.patch('subscriptions', subscription._id, patch);
		await scheduleSubscriptionExpiry(ctx, { ...subscription, ...patch });
	}
});

export const runSubscriptionAccessBackfill = internalMutation({
	args: { dryRun: v.optional(v.boolean()) },
	returns: v.null(),
	handler: async (ctx, { dryRun }) => {
		await migrations.runOne(ctx, internal.migrations.backfillSubscriptionAccess, {
			dryRun: dryRun ?? false
		});

		return null;
	}
});

export const removeTranscriptStateWorkThrough = migrations.define({
	table: 'threadTranscriptStates',
	migrateOne: async (_ctx, state) => {
		if (state.workThrough === undefined) return;

		return { workThrough: undefined };
	}
});

const mandateSetupPayloadSchema = z.object({ userEmail: z.unknown().optional() }).passthrough();

export const removeMandateSetupUserEmail = migrations.define({
	table: 'executorJobs',
	migrateOne: async (_ctx, job) => {
		if (job.kind !== 'mandate_setup') return;
		const parsed = mandateSetupPayloadSchema.safeParse(job.payload);

		if (!parsed.success || parsed.data.userEmail === undefined) return;
		const rest = { ...parsed.data };
		delete rest.userEmail;

		return { payload: rest };
	}
});

// Keep in sync with DEFAULT_SCRAPE_SUMMARY in webTools.ts (a 'use node'
// module, so it cannot be imported here).
const SCRAPE_SUMMARY_FALLBACK = 'No summary was returned for this page.';

const scrapeUrlResultSchema = z.object({
	url: z.string(),
	markdown: z.string(),
	summary: z.string().optional(),
	images: z.array(z.string()).optional(),
	truncated: z.unknown().optional()
});

export const normalizeScrapeUrlResults = migrations.define({
	table: 'executorJobs',
	migrateOne: async (_ctx, job) => {
		if (job.kind !== 'scrape_url') return;
		const parsed = scrapeUrlResultSchema.safeParse(job.result);

		if (!parsed.success) return;
		const { url, markdown, summary, images, truncated } = parsed.data;

		if (truncated === undefined && summary !== undefined && images !== undefined) return;

		return {
			result: {
				url,
				markdown,
				summary: summary ?? SCRAPE_SUMMARY_FALLBACK,
				images: images ?? []
			}
		};
	}
});

export const backfillExecutorJobToolInvocationId = migrations.define({
	table: 'executorJobs',
	migrateOne: async (_ctx, job) => {
		if (job.toolInvocationId !== undefined) return;

		return { toolInvocationId: job._id };
	}
});

export const migrateToolPartJobIds = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: async (ctx, part) => {
		if (part.kind !== 'tool' || !part.tool?.jobId) return;
		const job = await ctx.db.get('executorJobs', part.tool.jobId);

		if (!job) return;
		const tool = { ...part.tool };
		tool.toolInvocationId = job.toolInvocationId ?? job._id;
		delete tool.jobId;

		return { tool };
	}
});

export const backfillCommandToolInputs = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: async (ctx, part) => {
		const tool = part.tool;

		if (
			part.kind !== 'tool' ||
			!tool ||
			tool.input !== undefined ||
			!tool.toolInvocationId ||
			!isCommandToolKind(tool.name)
		) {
			return;
		}

		const toolInvocationId = tool.toolInvocationId;

		const job = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_and_toolInvocationId', (q) =>
				q.eq('runId', part.runId).eq('toolInvocationId', toolInvocationId)
			)
			.unique();

		if (!job || job.threadId !== part.threadId || job.kind !== tool.name) return;

		return { tool: { ...tool, input: commandToolDisplayInput(job.kind, job.payload) } };
	}
});

export const normalizeTranscriptCompletionTiming = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: async (_ctx, part) => {
		if (part.kind !== 'completion' || !part.completion) return;

		if (
			part.completion.items.every(
				(item) => item.startedAt !== undefined && item.completedAt !== undefined
			)
		) {
			return;
		}

		return {
			completion: {
				...part.completion,
				items: part.completion.items.map((item) => ({
					...item,
					startedAt: item.startedAt ?? null,
					completedAt: item.completedAt ?? null
				}))
			}
		};
	}
});

export const stripStoredAttachmentImageUploadIds = migrations.define({
	table: 'threadTranscriptParts',
	migrateOne: async (_ctx, part) => {
		if (!part.prompt || part.prompt.imageUploads.length === 0) return;

		if (part.prompt.imageUploads.every((upload) => upload.imageUploadId === undefined)) return;

		return {
			prompt: {
				...part.prompt,
				imageUploads: part.prompt.imageUploads.map((upload) => {
					const current = { ...upload };
					delete current.imageUploadId;

					return current;
				})
			}
		};
	}
});

export const removeSectionLinkedParts = migrations.define({
	table: 'threadTranscriptWorkSections',
	migrateOne: async (_ctx, section) => {
		if (section.linkedParts === undefined) return;

		return { linkedParts: undefined };
	}
});

export const removeArtifactRegistryRekeyTargets = migrations.define({
	table: 'artifactRegistries',
	migrateOne: async (_ctx, registry) => {
		if (registry.rekeyTo === undefined) return;

		return { rekeyTo: undefined };
	}
});

// Project ownership is available immediately through artifact readers; this
// backfill removes historical confinement without changing artifact identities
// or content revisions. Registry invalidation refreshes installed-client caches.
export const promoteThreadArtifacts = migrations.define({
	table: 'artifacts',
	batchSize: 8,
	migrateOne: async (ctx, artifact) => {
		if (artifact.scope === 'project' && artifact.threadId === undefined) return;

		await bumpRegistry(ctx, artifact.userId, artifact.repositoryKey);

		return { scope: 'project' as const, threadId: undefined };
	}
});

const legacyCompatBackfillMigrations: FunctionReference<'mutation', 'internal'>[] = [
	internal.migrations.removeTranscriptStateWorkThrough,
	internal.migrations.removeMandateSetupUserEmail,
	internal.migrations.normalizeScrapeUrlResults,
	internal.migrations.backfillExecutorJobToolInvocationId,
	internal.migrations.migrateToolPartJobIds,
	internal.migrations.backfillCommandToolInputs,
	internal.migrations.normalizeTranscriptCompletionTiming,
	internal.migrations.stripStoredAttachmentImageUploadIds,
	internal.migrations.removeSectionLinkedParts,
	internal.migrations.removeArtifactRegistryRekeyTargets
];

export const runLegacyCompatBackfill = migrations.runner(legacyCompatBackfillMigrations);

const LEGACY_COMPAT_BACKFILL = 'legacy-compat-backfill-2026-10-command-inputs';

const projectArtifactMigrations: FunctionReference<'mutation', 'internal'>[] = [
	internal.migrations.promoteThreadArtifacts
];

export const runProjectArtifactBackfill = migrations.runner(projectArtifactMigrations);

async function runBackfillAutomatically(
	ctx: MutationCtx,
	name: string,
	backfills: FunctionReference<'mutation', 'internal'>[]
): Promise<null> {
	const schedule = await ctx.db
		.query('migrationSchedules')
		.withIndex('by_name', (q) => q.eq('name', name))
		.unique();

	if (schedule?.completedAt !== undefined) return null;
	let scheduleId = schedule?._id;

	if (!schedule) {
		scheduleId = await ctx.db.insert('migrationSchedules', {
			name,
			notBefore: Date.now(),
			startedAt: Date.now()
		});
	} else if (schedule.startedAt === undefined) {
		await ctx.db.patch('migrationSchedules', schedule._id, { startedAt: Date.now() });
	}

	const statuses = await migrations.getStatus(ctx, { migrations: backfills });

	if (statuses.every((status) => status.isDone)) {
		await ctx.db.patch('migrationSchedules', scheduleId!, { completedAt: Date.now() });

		return null;
	}

	await migrations.runSerially(ctx, backfills);

	return null;
}

export const runLegacyCompatBackfillAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: (ctx): Promise<null> =>
		runBackfillAutomatically(ctx, LEGACY_COMPAT_BACKFILL, legacyCompatBackfillMigrations)
});

export const runProjectArtifactBackfillAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: (ctx): Promise<null> =>
		runBackfillAutomatically(ctx, 'project-artifacts-2026-10', projectArtifactMigrations)
});

export const runThreadHierarchyStatusBackfillAutomatically = internalMutation({
	args: {},
	returns: v.null(),
	handler: (ctx): Promise<null> =>
		runBackfillAutomatically(
			ctx,
			'thread-hierarchy-working-counts-2026-10',
			threadHierarchyWorkingMigrations
		)
});
