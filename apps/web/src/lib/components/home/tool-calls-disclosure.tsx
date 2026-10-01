import { ChevronRight, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AssistantTimelineTool } from '$lib/chat/assistant-timeline';

type Props = {
	label: string;
	icon: LucideIcon;
	/** Extra classes for the leading icon (e.g. animate-spin). */
	iconClass?: string;
	tools: AssistantTimelineTool[];
	/** When set, overrides the default open-when-≤2 rule. */
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
	const [manual, setManual] = useState<boolean | null>(null);
	const [initiallyExpanded] = useState(() => defaultExpanded ?? tools.length <= 2);

	const expanded =
		manual ?? (preserveExpansion ? initiallyExpanded : (defaultExpanded ?? tools.length <= 2));

	return (
		<div className="text-muted-foreground text-sm">
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
			{expanded ? (
				<div className="text-muted-foreground mt-1.5 space-y-1.5 text-[13px] leading-6">
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
