import type { Doc, Id } from '@convex/_generated/dataModel';
import type { ThreadTranscriptMessage } from '@convex/lib/threadTranscript';
import type { AgentHistoryMessage } from '@convex/lib/validators';
import { isRunFinalStatus } from '@convex/lib/validators';
import {
	ensureAssistantToolPartsFromJobs,
	type AssistantPart
} from '@web-lib/assistant-tool-parts';

function buildAgentHistoryFromAssistantMessage(args: {
	message: ThreadTranscriptMessage;
	jobs: Doc<'executorJobs'>[];
}): AgentHistoryMessage[] {
	const persistedParts = (args.message.parts ?? []) as AssistantPart[];
	const parts = ensureAssistantToolPartsFromJobs(
		args.message.runStatus === 'completed'
			? persistedParts
			: persistedParts.filter((part) => part.type === 'text' || part.type === 'reasoning'),
		args.jobs
			.filter((job) => !job.hidden)
			.sort((left, right) => left.sequence - right.sequence)
			.map((job) => ({
				id: job._id,
				kind: job.kind,
				payload: job.payload,
				status: job.status,
				result: job.result,
				error: job.error
			}))
	);
	const history: AgentHistoryMessage[] = [];
	let assistantContents: AgentHistoryMessage['contents'] = [];
	let sawAssistantText = false;

	const flushAssistantContents = () => {
		if (assistantContents.length === 0) {
			return;
		}
		history.push({
			role: 'assistant',
			contents: assistantContents
		});
		assistantContents = [];
	};

	for (const part of parts) {
		if (part.type === 'text') {
			const text = part.text.trim();
			if (!text) {
				continue;
			}
			sawAssistantText = true;
			assistantContents.push({
				type: 'text',
				text: part.text
			});
			continue;
		}

		if (part.type === 'reasoning') {
			continue;
		}

		if (part.type === 'tool-call') {
			assistantContents.push({
				type: 'toolCall',
				callId: part.callId,
				name: part.name,
				argumentsJson: JSON.stringify(part.input)
			});
			continue;
		}

		flushAssistantContents();
		history.push({
			role: 'user',
			contents: [
				{
					type: 'toolResult',
					callId: part.callId,
					items: [
						{
							type: 'text',
							text: JSON.stringify(part.output)
						}
					]
				}
			]
		});
	}

	if (!sawAssistantText && args.message.text.trim().length > 0) {
		assistantContents.push({
			type: 'text',
			text: args.message.text
		});
	}

	flushAssistantContents();
	return history;
}

export function buildCanonicalAgentHistory(args: {
	messages: ThreadTranscriptMessage[];
	jobs: Doc<'executorJobs'>[];
}): AgentHistoryMessage[] {
	const jobsByRunId = new Map<Id<'runs'>, Doc<'executorJobs'>[]>();
	for (const job of args.jobs) {
		const runJobs = jobsByRunId.get(job.runId) ?? [];
		runJobs.push(job);
		jobsByRunId.set(job.runId, runJobs);
	}

	const history: AgentHistoryMessage[] = [];
	for (const message of args.messages) {
		if (message.type === 'prompt') {
			const text = message.text.trim();
			if (!text) {
				continue;
			}
			history.push({
				role: 'user',
				contents: [{ type: 'text', text }]
			});
			continue;
		}

		if (!isRunFinalStatus(message.runStatus)) {
			continue;
		}

		history.push(
			...buildAgentHistoryFromAssistantMessage({
				message,
				jobs: jobsByRunId.get(message.runId) ?? []
			})
		);
	}

	return history;
}

export function findLatestPrompt(messages: ThreadTranscriptMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.type === 'prompt') {
			return messages[index].text.trim();
		}
	}
	throw new Error('Run does not contain a user prompt.');
}
