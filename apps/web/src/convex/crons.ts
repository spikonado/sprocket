import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'clean up abandoned image uploads',
	{ hours: 1 },
	internal.imageUploads.cleanupOrphans
);

crons.interval(
	'rewrite dropped max reasoning efforts onto supported defaults',
	{ hours: 1 },
	internal.migrations.rewriteDroppedMaxReasoning
);

export default crons;
