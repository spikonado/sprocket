import { useState } from 'react';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import AgentcardLinkDialog from '$lib/components/home/agentcard-link-dialog';
import Button from '$lib/components/ui/button/button';
import { formatMinorAmount } from '$lib/format';

type Purchase = FunctionReturnType<typeof api.payments.pendingThreadApprovals>[number];

function PurchaseApproval({ purchase }: { purchase: Purchase }) {
	const [approving, setApproving] = useState(false);
	const title = `Approve ${formatMinorAmount(purchase.amount, purchase.currency)} at ${purchase.merchant}`;

	return (
		<div
			className="border-border bg-surface/80 flex items-center gap-3 rounded-xl border px-3.5 py-2.5"
			role="status"
		>
			<p className="text-foreground min-w-0 flex-1 text-[13px] leading-5 [overflow-wrap:anywhere]">
				{title}
			</p>
			<Button className="h-8 px-4 text-xs" onclick={() => setApproving(true)}>
				Approve
			</Button>
			{approving ? (
				<AgentcardLinkDialog
					title={title}
					action="approve it"
					url={purchase.approvalUrl}
					onClose={() => setApproving(false)}
				/>
			) : null}
		</div>
	);
}

export default function PurchaseApprovals({ purchases }: { purchases: Purchase[] }) {
	return purchases.map((purchase) => <PurchaseApproval key={purchase._id} purchase={purchase} />);
}
