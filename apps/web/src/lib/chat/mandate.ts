import { isJsonObject, type JsonValue } from '$convex/lib/json';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';

export type MandateApproval = {
	mandateId: string;
	approvalUrl: string;
	sessionToken: string;
	expiresAt?: string;
};

/** Read the mandate-setup approval (approval iframe URL + session token) off a
 * mandate_setup tool's result, so the transcript can mount the Prava iframe. */
export function mandateApprovalFromTool(tool: AssistantTimelineTool): MandateApproval | undefined {
	const kind = tool.job?.kind ?? tool.name;
	if (kind !== 'mandate_setup') {
		return undefined;
	}
	const output = tool.output;
	if (!isJsonObject(output)) {
		return undefined;
	}
	const { mandateId, approvalUrl, sessionToken, expiresAt } = output;
	if (
		typeof mandateId !== 'string' ||
		typeof approvalUrl !== 'string' ||
		typeof sessionToken !== 'string'
	) {
		return undefined;
	}
	return {
		mandateId,
		approvalUrl,
		sessionToken,
		expiresAt: typeof expiresAt === 'string' ? expiresAt : undefined
	};
}

/** Collect every mandate approval across a tool-group (usually just one). */
export function mandateApprovals(tools: AssistantTimelineTool[]): MandateApproval[] {
	const approvals: MandateApproval[] = [];
	for (const tool of tools) {
		const approval = mandateApprovalFromTool(tool);
		if (approval) {
			approvals.push(approval);
		}
	}
	return approvals;
}

export function mandateSetupMerchant(tool: AssistantTimelineTool): string | undefined {
	const input: JsonValue | undefined = tool.job?.payload ?? tool.input;
	if (!isJsonObject(input) || typeof input.merchantName !== 'string') {
		return undefined;
	}
	return input.merchantName;
}
