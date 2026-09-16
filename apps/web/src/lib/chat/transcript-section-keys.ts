import {
	assistantTimelinePartKey,
	type AssistantTimelineSection,
	type AssistantTimelineWorkBlock
} from './assistant-timeline';

function blockMembers(block: AssistantTimelineWorkBlock) {
	return block.type === 'reasoning'
		? [assistantTimelinePartKey(block)]
		: block.tools.map((tool) => `tool:${tool.callId}`);
}

export class TranscriptSectionKeys {
	private messages = new Map<string, Map<string, string>>();
	private nextId = 0;

	retain(messageIds: string[]) {
		const retained = new Set(messageIds);
		for (const id of this.messages.keys()) {
			if (!retained.has(id)) this.messages.delete(id);
		}
	}

	reconcile(messageId: string, sections: AssistantTimelineSection[]) {
		const keys = this.reconcileMembers(
			messageId,
			sections.map((section) =>
				section.type === 'text'
					? [assistantTimelinePartKey(section)]
					: section.blocks.flatMap(blockMembers)
			)
		);
		return sections.map((section, index) => ({
			...section,
			renderKey: section.type === 'text' ? assistantTimelinePartKey(section) : keys[index]
		}));
	}

	reconcileBlocks(messageId: string, blocks: AssistantTimelineWorkBlock[]) {
		const keys = this.reconcileMembers(messageId, blocks.map(blockMembers));
		return blocks.map((block, index) => ({ block, renderKey: keys[index] }));
	}

	private reconcileMembers(messageId: string, groups: string[][]) {
		const previous = this.messages.get(messageId);
		const next = new Map<string, string>();
		const claimed = new Set<string>();
		const keyed = groups.map((members) => {
			// Parts can arrive at either end; a split must not reuse one key for both sections.
			const existing = members
				.map((member) => previous?.get(member))
				.find((key) => key !== undefined && !claimed.has(key));
			const renderKey = existing ?? `work:${this.nextId++}`;
			claimed.add(renderKey);
			for (const member of members) next.set(member, renderKey);
			return renderKey;
		});
		this.messages.set(messageId, next);
		return keyed;
	}
}
