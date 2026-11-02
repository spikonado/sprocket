import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import { openAgentcardPopup } from '$lib/agentcard';
import Button from '$lib/components/ui/button/button';
import { formatMinorAmount } from '$lib/format';

type Purchase = FunctionReturnType<typeof api.payments.pendingThreadApprovals>[number];

export default function PurchaseApprovals({ purchases }: { purchases: Purchase[] }) {
	return purchases.map((purchase) => (
		<div
			key={purchase._id}
			className="border-border bg-surface/80 flex items-center gap-3 rounded-xl border px-3.5 py-2.5"
			role="status"
		>
			<p className="text-foreground min-w-0 flex-1 text-[13px] leading-5 [overflow-wrap:anywhere]">
				Approve {formatMinorAmount(purchase.amount, purchase.currency)} at {purchase.merchant}
			</p>
			<Button className="h-8 px-4 text-xs" onclick={() => openAgentcardPopup(purchase.approvalUrl)}>
				Approve
			</Button>
		</div>
	));
}
