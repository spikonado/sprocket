import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

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
	'resync Dodo subscriptions past their billing period',
	{ hours: 1 },
	internal.dodo.syncOverdue,
	{}
);

crons.interval(
	'prune expired Dodo checkout history',
	{ hours: 24 },
	internal.billing.cleanupCheckoutHistory,
	{}
);

crons.daily(
	'send daily usage to PostHog',
	{ hourUTC: 0, minuteUTC: 15 },
	internal.analytics.sendDailyUsage,
	{}
);

export default crons;
