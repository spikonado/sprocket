import { isJsonObject, type JsonValue } from '$convex/lib/json';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';

export type MandateApproval = {
	mandateId: string;
	approvalUrl: string;
	/** Short human label from the setup call (description or merchant name). */
	label?: string;
};

/** Read the mandate-setup approval URL off a mandate_setup tool's result so the
 * transcript can offer a new-tab Prava approval link. */
function mandateApprovalFromTool(
	tool: AssistantTimelineTool
): Pick<MandateApproval, 'mandateId' | 'approvalUrl'> | undefined {
	const kind = tool.job?.kind ?? tool.name;
	if (kind !== 'mandate_setup') {
		return undefined;
	}
	const output = tool.output;
	if (!isJsonObject(output)) {
		return undefined;
	}
	const { mandateId, approvalUrl } = output;
	if (typeof mandateId !== 'string' || typeof approvalUrl !== 'string') {
		return undefined;
	}
	return { mandateId, approvalUrl };
}

function mandateSetupLabel(tool: AssistantTimelineTool): string | undefined {
	const input: JsonValue | undefined = tool.job?.payload ?? tool.input;
	if (!isJsonObject(input)) return undefined;
	if (typeof input.description === 'string' && input.description.trim()) {
		return input.description.trim();
	}
	if (typeof input.merchantName === 'string' && input.merchantName.trim()) {
		return input.merchantName.trim();
	}
	return undefined;
}

/** Collect every mandate approval across a tool-group (usually just one), each
 * labeled from its own mandate_setup call. */
export function mandateApprovals(tools: AssistantTimelineTool[]): MandateApproval[] {
	return tools.flatMap((tool) => {
		const approval = mandateApprovalFromTool(tool);
		return approval ? [{ ...approval, label: mandateSetupLabel(tool) }] : [];
	});
}
