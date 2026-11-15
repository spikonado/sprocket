import { isJsonObject, isJsonString, type JsonValue } from '@convex/lib/json';
import type {
	AssistantMessagePart,
	AssistantReasoningPart,
	AssistantTextPart,
	AssistantToolCallPart,
	AssistantToolResultErrorOutput,
	AssistantToolResultPart
} from '@convex/lib/validators';

export type {
	AssistantTextPart,
	AssistantReasoningPart,
	AssistantToolCallPart,
	AssistantToolResultPart
};

export type { AssistantToolResultErrorOutput };

export function parseAssistantToolResultError(
	output: JsonValue | undefined
): AssistantToolResultErrorOutput | undefined {
	if (!isJsonObject(output) || !isJsonString(output.error)) {
		return undefined;
	}

	if (output.status !== 'cancelled' && output.status !== 'failed') {
		return undefined;
	}

	return { error: output.error, status: output.status };
}

export type AssistantPart = AssistantMessagePart;

export function joinAssistantTextParts(parts: AssistantPart[]): string {
	let text = '';
	let previousTurnId: string | undefined;
	let sawText = false;

	for (const part of parts) {
		if (part.type !== 'text' || part.text.length === 0) continue;

		if (
			sawText &&
			previousTurnId !== undefined &&
			part.turnId !== undefined &&
			part.turnId !== previousTurnId
		) {
			text += '\n\n';
		}

		text += part.text;

		if (part.turnId !== undefined) previousTurnId = part.turnId;
		sawText = true;
	}

	return text;
}
