import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'clean up abandoned image uploads',
	{ hours: 1 },
	internal.imageUploads.cleanupOrphans
);

// Temporary: convergence backstop for the threadUsage lazy migration. Delete
// once the legacy on-thread counters are removed from the schema.
crons.interval(
	'migrate legacy thread usage counters',
	{ hours: 1 },
	internal.threads.migrateLegacyUsageBatch,
	{}
);

export default crons;
