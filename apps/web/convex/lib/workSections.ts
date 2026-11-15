import { v } from 'convex/values';

export const workRange = v.object({
	start: v.number(),
	end: v.number(),
	sectionKey: v.string()
});

export const workMembership = v.object({
	ranges: v.array(workRange),
	sectionKey: v.optional(v.string()),
	toolInvocations: v.optional(v.array(v.object({ item: v.number(), toolInvocationId: v.string() })))
});

export const sectionOrder = v.object({
	sectionKey: v.string(),
	sectionOrdinal: v.number(),
	closed: v.boolean()
});
