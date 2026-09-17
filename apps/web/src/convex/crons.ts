import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'migrate transcript work memberships',
	{ hours: 1 },
	internal.migrations.runTranscriptMembershipMigration,
	{}
);

crons.interval(
	'backfill inbox working rank',
	{ hours: 1 },
	internal.migrations.runInboxWorkingMigration,
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

export default crons;
