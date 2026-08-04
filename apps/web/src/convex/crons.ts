import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'clean up abandoned image uploads',
	{ hours: 1 },
	internal.imageUploads.cleanupOrphans
);

// Temporary backstop for the threadUsage migration; delete with the legacy fields.
crons.interval(
	'migrate legacy thread usage counters',
	{ hours: 1 },
	internal.threads.migrateLegacyUsageBatch,
	{}
);

export default crons;
