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
	'reconcile Firecrawl browser sessions',
	{ minutes: 1 },
	internal.firecrawlBrowser.reconcile
);

export default crons;
