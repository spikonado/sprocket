import { FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import {
	isPreviewableImageMediaType,
	revokeAttachmentPreview,
	triggerAttachmentDownload
} from '$lib/chat/attachments';
import type { ViewerImage } from '$lib/components/image-viewer';
import type { MessageAttachment } from '$lib/types/sprocket';
import { useLatest } from '$lib/use-latest';

type Props = {
	attachment: MessageAttachment;
	loadAttachment?: (fileId: Id<'files'>) => Promise<string | null>;
	onOpen: (image: ViewerImage) => void;
};

const fileChipClass =
	'border-border hover:border-border focus-visible:ring-ring/40 text-foreground inline-flex h-14 max-w-56 items-center gap-2 rounded-xl border px-3 py-2 text-xs transition focus-visible:ring-2 focus-visible:outline-none';

const unavailableChipClass =
	'text-muted-foreground border-hairline bg-hover-fill inline-flex items-center rounded-xl border px-3 py-2 text-xs';

export default function TranscriptAttachment({ attachment, loadAttachment, onOpen }: Props) {
	const [url, setUrl] = useState<string | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [downloadPending, setDownloadPending] = useState(false);
	const downloadGeneration = useRef(0);
	const loadAttachmentRef = useLatest(loadAttachment);
	const fileId = attachment.fileId;
	const previewable = isPreviewableImageMediaType(attachment.mediaType);

	useEffect(() => {
		const current = url;

		return () => {
			revokeAttachmentPreview(current ?? undefined);
			// A hidden <Activity> runs this cleanup but keeps state, so drop the revoked URL.
			setUrl((value) => (value === current ? null : value));
		};
	}, [url]);

	useEffect(() => {
		const loader = loadAttachmentRef.current;

		if (!fileId || !previewable || !loader) {
			return;
		}

		let cancelled = false;
		setLoadFailed(false);
		void loader(fileId)
			.then((next) => {
				if (cancelled) {
					revokeAttachmentPreview(next ?? undefined);

					return;
				}

				setUrl(next);
				setLoadFailed(next == null);
			})
			.catch(() => {
				if (!cancelled) {
					setLoadFailed(true);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [fileId, previewable, loadAttachmentRef]);

	useEffect(() => {
		return () => {
			downloadGeneration.current += 1;
			setDownloadPending(false);
		};
	}, []);

	async function downloadFile(fileId: Id<'files'>, loader: NonNullable<Props['loadAttachment']>) {
		if (downloadPending) {
			return;
		}

		if (url) {
			triggerAttachmentDownload(url, attachment.name);

			return;
		}

		const generation = downloadGeneration.current;
		setDownloadPending(true);
		setLoadFailed(false);

		try {
			const next = await loader(fileId);

			if (generation !== downloadGeneration.current) {
				revokeAttachmentPreview(next ?? undefined);

				return;
			}

			if (!next) {
				setLoadFailed(true);

				return;
			}

			setUrl(next);
			triggerAttachmentDownload(next, attachment.name);
		} catch {
			if (generation === downloadGeneration.current) {
				setLoadFailed(true);
			}
		} finally {
			if (generation === downloadGeneration.current) {
				setDownloadPending(false);
			}
		}
	}

	if (!fileId) {
		return <span className={unavailableChipClass}>{`${attachment.name} (deleted)`}</span>;
	}

	if (url && previewable) {
		return (
			<button
				type="button"
				className="border-border hover:border-border focus-visible:ring-ring/40 block size-14 cursor-zoom-in overflow-hidden rounded-xl border transition focus-visible:ring-2 focus-visible:outline-none"
				aria-label={`View ${attachment.name}`}
				title={attachment.name}
				onClick={() => {
					onOpen({
						url,
						name: attachment.name,
						mediaType: attachment.mediaType
					});
				}}
			>
				<img src={url} alt="" loading="lazy" className="size-full object-cover" />
			</button>
		);
	}

	if (!loadAttachment || (previewable && loadFailed)) {
		return <span className={unavailableChipClass}>{`${attachment.name} (unavailable)`}</span>;
	}

	if (previewable) {
		return (
			<span
				className="border-hairline bg-hover-fill inline-flex size-14 animate-pulse rounded-xl border"
				aria-label={`Loading ${attachment.name}`}
			></span>
		);
	}

	if (downloadPending) {
		return (
			<span
				className={`${fileChipClass} pointer-events-none animate-pulse`}
				aria-label={`Downloading ${attachment.name}`}
				role="status"
			>
				<FileText className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{attachment.name}</span>
			</span>
		);
	}

	return (
		<button
			type="button"
			className={`${fileChipClass} cursor-pointer`}
			aria-label={`${loadFailed ? 'Retry download of' : 'Download'} ${attachment.name}`}
			title={attachment.name}
			onClick={() => {
				void downloadFile(fileId, loadAttachment);
			}}
		>
			<FileText className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">
				{loadFailed ? `${attachment.name} (unavailable)` : attachment.name}
			</span>
		</button>
	);
}
