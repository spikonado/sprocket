import { v } from 'convex/values';

export const displayRowFields = {
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	sequence: v.number(),
	kind: v.union(v.literal('prompt'), v.literal('text'), v.literal('work'), v.literal('approval')),
	text: v.optional(v.string()),
	attachments: v.optional(
		v.array(
			v.object({
				storageId: v.id('_storage'),
				name: v.string(),
				mediaType: v.string(),
				size: v.number()
			})
		)
	),
	mandateId: v.optional(v.string()),
	approvalUrl: v.optional(v.string()),
	itemCount: v.number(),
	pendingTools: v.number(),
	provisional: v.optional(v.boolean()),
	startedAt: v.optional(v.number()),
	completedAt: v.optional(v.number()),
	closed: v.boolean(),
	revision: v.number()
};

export const displayRowValidator = v.object({
	id: v.string(),
	...displayRowFields
});
