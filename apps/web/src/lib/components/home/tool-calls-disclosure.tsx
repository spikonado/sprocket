import { ChevronRight, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';

type Props = {
	label: string;
	icon: LucideIcon;
	/** Extra classes for the leading icon (e.g. animate-spin). */
	iconClass?: string;
	tools: AssistantTimelineTool[];
	/** Overrides the default expansion once a group has a disclosure. */
	defaultExpanded?: boolean;
	preserveExpansion?: boolean;
	toolRow: (tool: AssistantTimelineTool) => ReactNode;
};

export default function ToolCallsDisclosure({
	label,
	icon: Icon,
	iconClass,
	tools,
	defaultExpanded,
	preserveExpansion = false,
	toolRow
}: Props) {
	const showDisclosure = tools.length >= 3;
	const [manual, setManual] = useState<boolean | null>(null);
	const [initiallyExpanded] = useState(() => defaultExpanded ?? !showDisclosure);

	const expanded =
		manual ?? (preserveExpansion ? initiallyExpanded : (defaultExpanded ?? !showDisclosure));

	return (
		<div className="text-muted-foreground text-sm">
			{showDisclosure ? (
				<button
					type="button"
					className="text-muted-foreground hover:text-muted-foreground inline-flex items-center gap-1.5 transition"
					onClick={() => setManual(!expanded)}
					aria-expanded={expanded}
				>
					<Icon className={`size-3.5 shrink-0 ${iconClass ?? ''}`} aria-hidden="true" />
					<span>{label}</span>
					<ChevronRight
						className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
						aria-hidden="true"
					/>
				</button>
			) : null}
			{!showDisclosure || expanded ? (
				<div
					className={`text-muted-foreground space-y-1.5 text-[13px] leading-6 ${showDisclosure ? 'mt-1.5' : ''}`}
				>
					{tools.map((tool) => (
						<div key={tool.callId} data-work-detail>
							{toolRow(tool)}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
