import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'backfill subscription expiry checks',
	{ hours: 1 },
	internal.migrations.runSubscriptionExpiryBackfill,
	{}
);

crons.interval(
	'backfill legacy stored fields',
	{ hours: 1 },
	internal.migrations.runLegacyCompatBackfillAutomatically,
	{}
);

crons.interval(
	'backfill terminal transcript readiness',
	{ hours: 1 },
	internal.migrations.runTerminalJobBackfill,
	{}
);

crons.interval(
	'promote legacy thread artifacts to projects',
	{ hours: 1 },
	internal.migrations.runProjectArtifactBackfillAutomatically,
	{}
);

crons.interval(
	'backfill descendant thread status counts',
	{ hours: 1 },
	internal.migrations.runThreadHierarchyStatusBackfillAutomatically,
	{}
);

crons.interval(
	'clean up abandoned image uploads',
	{ hours: 1 },
	internal.imageUploads.cleanupOrphans,
	{}
);

crons.interval(
	'delete inactive attached file bytes',
	{ hours: 1 },
	internal.imageUploads.cleanupExpired,
	{}
);

crons.interval(
	'expire hosted parse temporaries',
	{ hours: 1 },
	internal.hostedParse.cleanupExpired
);

crons.interval(
	'delete unregistered file bytes',
	{ hours: 1 },
	internal.storageCleanup.cleanupUnregistered,
	{}
);

crons.interval(
	'retire cloud-held ChatGPT credentials',
	{ hours: 1 },
	internal.providerCredentials.retireChatGptCloudCredentials,
	{ cursor: null, vaultAfter: null, tableScanDone: false }
);

crons.interval(
	'expire completed usage windows',
	{ hours: 24 },
	internal.lib.rateLimits.cleanupUsageWindows,
	{}
);

crons.interval(
	'retry failed Dodo webhook processing',
	{ minutes: 15 },
	internal.billingWebhook.retryPending,
	{}
);

crons.interval(
	'backfill Dodo webhook ingestion sequences',
	{ hours: 1 },
	internal.billingWebhook.backfillSequences,
	{}
);

crons.interval(
	'prune Dodo webhook payloads and expired dedup rows',
	{ hours: 12 },
	internal.billingWebhook.cleanupEvents,
	{}
);

crons.interval(
	'compact terminal Dodo checkout history',
	{ hours: 24 },
	internal.billing.cleanupCheckoutHistory,
	{}
);

export default crons;
