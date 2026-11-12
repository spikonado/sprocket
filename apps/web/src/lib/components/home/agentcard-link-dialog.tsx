import { encode } from 'uqr';
import Button from '$lib/components/ui/button/button';
import ModalDialog from '$lib/components/ui/modal-dialog';

function openOnThisComputer(url: string) {
	window.open(url, 'agentcard', 'popup,width=480,height=760');
}

function qrPath(url: string) {
	const { data } = encode(url, { ecc: 'M', border: 2 });

	return {
		size: data.length,
		path: data
			.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])))
			.join('')
	};
}

/** Agentcard saves cards behind a passkey, which many PCs can't create, so the phone is offered first. */
export default function AgentcardLinkDialog({
	title,
	action,
	url,
	onClose
}: {
	title: string;
	action: string;
	url: string;
	onClose: () => void;
}) {
	const qr = qrPath(url);

	return (
		<ModalDialog
			title={title}
			description={`Scan with your phone's camera to ${action} with Face ID or your fingerprint.`}
			className="w-[min(24rem,calc(100%-2rem))]"
			onCancel={onClose}
		>
			<svg
				role="img"
				aria-label="QR code for the Agentcard link"
				viewBox={`0 0 ${qr.size} ${qr.size}`}
				className="mx-auto mt-5 size-52 rounded-lg bg-white [shape-rendering:crispEdges]"
			>
				<path d={qr.path} fill="black" />
			</svg>
			<p className="text-muted-foreground mt-5 text-xs leading-5">
				You can use this computer instead if it has a passkey, like Touch ID, Windows Hello, or a
				password manager.
			</p>
			<div className="mt-3 flex justify-end gap-2">
				<Button
					variant="outline"
					className="h-9 px-4 text-xs"
					onclick={() => openOnThisComputer(url)}
				>
					Open on this computer
				</Button>
				<Button className="h-9 px-4 text-xs" onclick={onClose}>
					Done
				</Button>
			</div>
		</ModalDialog>
	);
}
