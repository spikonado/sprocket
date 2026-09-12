import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'backfill transcript display history',
	{ hours: 1 },
	internal.migrations.runTranscriptDisplayBackfillAutomatically,
	{}
);

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
	'backfill Fast mode',
	{ hours: 1 },
	internal.migrations.runFastModeBackfillAutomatically,
	{}
);

crons.interval(
	'backfill run execution state',
	{ hours: 1 },
	internal.migrations.runExecutionBackfillAutomatically,
	{}
);

crons.interval(
	'reconcile Firecrawl browser sessions',
	{ minutes: 1 },
	internal.firecrawlBrowser.reconcile
);

crons.interval(
	'remove obsolete completion stream state',
	{ hours: 1 },
	internal.migrations.runCompletionStreamCleanupAutomatically,
	{}
);

crons.interval(
	'migrate run lifecycle scheduling',
	{ hours: 1 },
	internal.migrations.runNativeRunLifecycleMigrationAutomatically,
	{}
);

export default crons;
