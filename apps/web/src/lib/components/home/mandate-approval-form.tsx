import type { MandateApproval } from '$lib/chat/mandate';

type Props = {
	approval: MandateApproval;
};

export default function MandateApprovalForm({ approval }: Props) {
	return (
		<div className="max-w-md">
			<p className="text-foreground text-sm">
				Approve spending{approval.label ? ` · ${approval.label}` : ''}
			</p>
			<p className="text-muted-foreground mt-0.5 text-xs leading-5">
				Opens Prava in a new tab so you can confirm with your passkey.
			</p>
			<a
				href={approval.approvalUrl}
				target="_blank"
				rel="noopener noreferrer"
				className="border-border bg-surface/80 text-foreground hover:bg-hover-fill mt-3 inline-flex h-9 items-center rounded-full border px-4 text-xs font-medium transition"
			>
				Approve mandate
			</a>
		</div>
	);
}
