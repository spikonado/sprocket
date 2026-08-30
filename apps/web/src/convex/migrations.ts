import { Migrations } from '@convex-dev/migrations';
import { components, internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import { pickPrimaryUser } from '@convex/lib/auth';
import schema from '@convex/schema';

export const migrations = new Migrations(components.migrations, {
	schema,
	internalMutation
});

// `run` targets the currently live migration(s). Each deploy's cron calls it
// with no args; the runner picks up the pinned migration refs itself. Swap in
// the next migration when a future cleanup lands.
export const run = migrations.runner([
	internal.migrations.clearResponseMessageParts,
	internal.migrations.rewriteBillingCustomerOwners,
	internal.migrations.rewriteSubscriptionOwners,
	internal.migrations.rewriteUiPreferenceOwners,
	internal.migrations.rewriteProjectOwners,
	internal.migrations.rewriteProjectConnectionOwners,
	internal.migrations.rewriteThreadRecordOwners,
	internal.migrations.rewriteThreadUsageOwners,
	internal.migrations.rewriteThreadUsageEventOwners,
	internal.migrations.rewriteRunOwners,
	internal.migrations.rewriteThreadMessageOwners,
	internal.migrations.rewriteTranscriptStateOwners,
	internal.migrations.rewriteTranscriptPartOwners,
	internal.migrations.rewriteCompletionStreamStateOwners,
	internal.migrations.rewriteImageUploadOwners,
	internal.migrations.rewriteArtifactOwners,
	internal.migrations.rewriteArtifactVersionOwners,
	internal.migrations.rewriteMandateOwners,
	internal.migrations.rewriteMandateChargeOwners,
	internal.migrations.rewriteBrowserSessionOwners
]);

/**
 * Clears the response-half payloads (`text`, `parts`) that runs wrote to
 * `threadMessages` before the local-transcript cleanup. Once every remaining
 * row is rewritable this way, `runs.responseMessageId` and
 * `threadMessages.parts` can be dropped from the schema. Run via:
 *   npx convex run migrations:clearResponseMessageParts '{ dryRun: true }'
 *
 * Scoped to `type === 'response'` rows so prompts are not re-read on every
 * cron tick while the compatibility gate is still open.
 */
export const clearResponseMessageParts = migrations.define({
	table: 'threadMessages',
	customRange: (query) => query.withIndex('by_type_runId', (range) => range.eq('type', 'response')),
	migrateOne: async (ctx, message) => {
		if (message.text === '' && message.parts.length === 0) {
			return;
		}
		// Reads/writes the whole document on purpose: this migration's success
		// is part of the gate for deleting the oversized `parts` field, which
		// requires every stored row to survive a patch transaction.
		const current = await ctx.db.get('threadMessages', message._id);
		if (!current) {
			return;
		}
		await ctx.db.patch('threadMessages', message._id, { text: '', parts: [] });
	}
});

/**
 * Owner-key transition: owned tables move from storing the WorkOS JWT
 * subject in `userId` to the canonical `identity.tokenIdentifier`. Rows
 * written before the switch stay reachable through the caller's subject
 * (kept on `users.subject`) until a later unset rewrite removes the shims.
 */
type OwnedTable = Exclude<
	Parameters<typeof migrations.define>[0]['table'],
	// Tables without an owning userId handle ownership transitively.
	'users' | 'executorJobs' | 'agentQuestions' | 'sessionCredentials'
>;

function rewriteOwnerKey(table: OwnedTable) {
	return migrations.define({
		table,
		batchSize: 25,
		migrateOne: async (ctx, doc) => {
			const user = pickPrimaryUser(
				await ctx.db
					.query('users')
					.withIndex('by_subject', (query) => query.eq('subject', doc.userId))
					.collect()
			);
			if (user && user.tokenIdentifier !== doc.userId) {
				return { userId: user.tokenIdentifier };
			}
		}
	});
}

export const rewriteBillingCustomerOwners = rewriteOwnerKey('billingCustomers');
export const rewriteSubscriptionOwners = rewriteOwnerKey('subscriptions');
export const rewriteUiPreferenceOwners = rewriteOwnerKey('uiPreferences');
export const rewriteProjectOwners = rewriteOwnerKey('projects');
export const rewriteProjectConnectionOwners = rewriteOwnerKey('projectConnections');
export const rewriteThreadRecordOwners = rewriteOwnerKey('threadRecords');
export const rewriteThreadUsageOwners = rewriteOwnerKey('threadUsage');
export const rewriteThreadUsageEventOwners = rewriteOwnerKey('threadUsageEvents');
export const rewriteRunOwners = rewriteOwnerKey('runs');
export const rewriteThreadMessageOwners = rewriteOwnerKey('threadMessages');
export const rewriteTranscriptStateOwners = rewriteOwnerKey('threadTranscriptStates');
export const rewriteTranscriptPartOwners = rewriteOwnerKey('threadTranscriptParts');
export const rewriteCompletionStreamStateOwners = rewriteOwnerKey('completionStreamStates');
export const rewriteImageUploadOwners = rewriteOwnerKey('imageUploads');
export const rewriteArtifactOwners = rewriteOwnerKey('artifacts');
export const rewriteArtifactVersionOwners = rewriteOwnerKey('artifactVersions');
export const rewriteMandateOwners = rewriteOwnerKey('mandates');
export const rewriteMandateChargeOwners = rewriteOwnerKey('mandateCharges');
export const rewriteBrowserSessionOwners = rewriteOwnerKey('browserSessions');
