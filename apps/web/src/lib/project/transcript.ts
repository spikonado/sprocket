import { joinAssistantTextParts, type AssistantPart } from '$convex/lib/assistantParts';
import type { LiveCompletionOverlay, LiveTranscriptMessage } from '$lib/types/sprocket';

function partKey(part: AssistantPart): string {
	return part.type === 'tool-call' || part.type === 'tool-result'
		? `${part.type}:${part.callId}`
		: `${part.type}:${part.turnId ?? ''}:${part.id}`;
}

export function mergeLiveOverlays(overlays: LiveCompletionOverlay[]): LiveTranscriptMessage[] {
	const runs = new Map<
		string,
		{ live: LiveCompletionOverlay; parts: Map<string, AssistantPart> }
	>();
	for (const live of overlays) {
		const parts = runs.get(live.runId)?.parts ?? new Map<string, AssistantPart>();
		for (const part of live.parts) parts.set(partKey(part), part);
		runs.set(live.runId, { live, parts });
	}
	return [...runs.values()].map(({ live, parts: indexed }) => {
		const parts = [...indexed.values()];
		return {
			kind: 'live',
			id: `response:${live.runId}`,
			threadId: live.threadId,
			runId: live.runId,
			runStatus: live.runStatus,
			runStartedAt: live.runStartedAt,
			text: joinAssistantTextParts(parts),
			parts
		};
	});
}
