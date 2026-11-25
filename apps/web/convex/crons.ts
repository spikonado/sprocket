import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval('delete abandoned draft files', { hours: 1 }, internal.files.cleanupDrafts, {});

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

crons.interval('sync Dodo prices onto tiers', { minutes: 30 }, internal.dodo.syncPrices, {});

crons.daily(
	'send daily usage to PostHog',
	{ hourUTC: 0, minuteUTC: 15 },
	internal.analytics.sendDailyUsage,
	{}
);

export default crons;
