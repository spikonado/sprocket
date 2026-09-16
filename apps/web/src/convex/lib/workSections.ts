import { v } from 'convex/values';

export const workPosition = v.object({ part: v.number(), item: v.number() });
export const workSectionFields = {
	key: v.string(),
	runId: v.id('runs'),
	first: workPosition,
	end: workPosition,
	closed: v.boolean(),
	provisional: v.boolean(),
	itemCount: v.number(),
	pendingTools: v.number(),
	startedAt: v.optional(v.number()),
	completedAt: v.optional(v.number())
};
export const workSection = v.object(workSectionFields);
export const workRange = v.object({
	start: v.number(),
	end: v.number(),
	sectionKey: v.string()
});
export const workMembership = v.object({
	processed: v.number(),
	ranges: v.array(workRange),
	sectionKey: v.optional(v.string())
});
export const workAssignment = workMembership.extend({ number: v.number() });
export const workBatch = v.object({
	finishedRunId: v.optional(v.id('runs')),
	expected: workPosition,
	through: workPosition,
	sections: v.array(workSection),
	removed: v.array(v.string()),
	memberships: v.array(workAssignment)
});

export function checkPosition(position: { part: number; item: number }) {
	if (
		!Number.isSafeInteger(position.part) ||
		position.part < 0 ||
		position.part > 0xffffffff ||
		!Number.isInteger(position.item) ||
		position.item < 0 ||
		position.item > 8192
	)
		throw new Error('Invalid transcript position.');
}
