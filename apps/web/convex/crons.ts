import { cronJobs } from 'convex/server';
import { internal } from '@convex/_generated/api';

const crons = cronJobs();

crons.interval(
	'backfill legacy stored fields',
	{ hours: 1 },
	internal.migrations.runLegacyCompatBackfillAutomatically,
	{}
);

crons.interval(
	'backfill terminal transcript readiness',
	{ hours: 1 },
	internal.migrations.runTerminalJobBackfill,
	{}
);

crons.interval(
	'promote legacy thread artifacts to projects',
	{ hours: 1 },
	internal.migrations.runProjectArtifactBackfillAutomatically,
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
	'retire cloud-held ChatGPT credentials',
	{ hours: 1 },
	internal.providerCredentials.retireChatGptCloudCredentials,
	{ cursor: null, vaultAfter: null, tableScanDone: false }
);

export default crons;
