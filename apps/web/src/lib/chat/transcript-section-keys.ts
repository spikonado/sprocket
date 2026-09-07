import { assistantTimelinePartKey, type AssistantTimelineSection } from './assistant-timeline';

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
		const previous = this.messages.get(messageId);
		const next = new Map<string, string>();
		const claimed = new Set<string>();
		const keyed = sections.map((section) => {
			if (section.type === 'text') {
				return { ...section, renderKey: assistantTimelinePartKey(section) };
			}
			const members = section.blocks.flatMap((block) =>
				block.type === 'reasoning'
					? [assistantTimelinePartKey(block)]
					: block.tools.map((tool) => `tool:${tool.callId}`)
			);
			// Parts can arrive at either end; a split must not reuse one key for both sections.
			const existing = members
				.map((member) => previous?.get(member))
				.find((key) => key !== undefined && !claimed.has(key));
			const renderKey = existing ?? `work:${this.nextId++}`;
			claimed.add(renderKey);
			for (const member of members) next.set(member, renderKey);
			return { ...section, renderKey };
		});
		this.messages.set(messageId, next);
		return keyed;
	}
}
