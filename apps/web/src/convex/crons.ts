import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval('maintain thread inbox', { minutes: 5 }, internal.inbox.maintain, {});
crons.interval(
	'migrate thread inbox',
	{ minutes: 1 },
	internal.migrations.runInboxMigrationAutomatically,
	{}
);
crons.interval('wake snoozed threads', { minutes: 1 }, internal.inbox.wakeDue, {});

crons.interval(
	'clean up abandoned image uploads',
	{ hours: 1 },
	internal.imageUploads.cleanupOrphans
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
	'run production rollout cleanup migrations',
	{ hours: 1 },
	internal.migrations.runProductionRolloutCleanupAutomatically,
	{}
);

crons.interval(
	'reconcile Firecrawl browser sessions',
	{ minutes: 1 },
	internal.firecrawlBrowser.reconcile
);

export default crons;
