import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'clean up abandoned image uploads',
	{ hours: 1 },
	internal.imageUploads.cleanupOrphans
);

crons.interval('run convex component migrations', { minutes: 10 }, internal.migrations.run, {});

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

export default crons;
