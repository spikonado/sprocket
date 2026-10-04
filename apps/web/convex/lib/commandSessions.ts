import { v } from 'convex/values';
import { vCommandStdinResult } from '@convex/lib/validators';

export const commandSnapshot = v.object({
	command: v.string(),
	workdir: v.string(),
	machineId: v.string(),
	result: vCommandStdinResult.omit('command', 'workdir', 'completeLogPath', 'eventsPath')
});
