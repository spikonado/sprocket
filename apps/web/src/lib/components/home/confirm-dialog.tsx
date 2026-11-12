import ModalDialog from '$lib/components/ui/modal-dialog';

type Props = {
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
};

export default function ConfirmDialog({
	title,
	description,
	confirmLabel,
	destructive = false,
	onCancel,
	onConfirm
}: Props) {
	return (
		<ModalDialog title={title} description={description} onCancel={onCancel}>
			<div className="mt-6 flex justify-end gap-2">
				<button
					type="button"
					className="hover:bg-hover-fill rounded-lg px-4 py-2 text-sm"
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="button"
					className={`rounded-lg px-4 py-2 text-sm ${
						destructive
							? 'bg-destructive text-destructive-foreground'
							: 'bg-foreground text-background'
					}`}
					onClick={onConfirm}
				>
					{confirmLabel}
				</button>
			</div>
		</ModalDialog>
	);
}
