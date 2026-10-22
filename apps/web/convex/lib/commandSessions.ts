import { v } from 'convex/values';

export const commandSnapshot = v.object({
	command: v.string(),
	workdir: v.string(),
	machineId: v.string(),
	result: v.object({
		output: v.string(),
		exitCode: v.optional(v.number()),
		success: v.boolean(),
		running: v.boolean(),
		timedOut: v.boolean(),
		error: v.optional(v.string())
	})
});
