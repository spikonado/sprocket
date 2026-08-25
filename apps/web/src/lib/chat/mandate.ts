import { isJsonObject, type JsonValue } from '$convex/lib/json';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';
import { jsonString } from '$lib/chat/json-fields';

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
	const mandateId = jsonString(output.mandateId);
	const approvalUrl = jsonString(output.approvalUrl);
	if (!mandateId || !approvalUrl) {
		return undefined;
	}
	return { mandateId, approvalUrl };
}

function mandateSetupLabel(tool: AssistantTimelineTool): string | undefined {
	const input: JsonValue | undefined = tool.job?.payload ?? tool.input;
	if (!isJsonObject(input)) return undefined;
	const description = jsonString(input.description)?.trim();
	if (description) {
		return description;
	}
	const merchantName = jsonString(input.merchantName)?.trim();
	if (merchantName) {
		return merchantName;
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
