import { FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
	isPreviewableImageMediaType,
	revokeAttachmentPreview,
	shouldEagerLoadAttachmentPreview,
	triggerAttachmentDownload
} from '$lib/chat/attachments';
import type { ViewerImage } from '$lib/components/image-viewer';
import type { MessageAttachment } from '$lib/types/sprocket';

type Props = {
	attachment: MessageAttachment;
	loadAttachment?: (storageId: MessageAttachment['storageId']) => Promise<string | null>;
	onOpen: (image: ViewerImage) => void;
};

const fileChipClass =
	'border-border hover:border-border focus-visible:ring-ring/40 text-foreground inline-flex h-14 max-w-56 items-center gap-2 rounded-xl border px-3 py-2 text-xs transition focus-visible:ring-2 focus-visible:outline-none';

export default function TranscriptAttachment({ attachment, loadAttachment, onOpen }: Props) {
	const [ownedUrl, setOwnedUrl] = useState<string | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [downloadPending, setDownloadPending] = useState(false);
	const downloadGeneration = useRef(0);
	const loadAttachmentRef = useRef(loadAttachment);
	loadAttachmentRef.current = loadAttachment;

	const url = ownedUrl ?? attachment.url ?? null;
	const previewable = isPreviewableImageMediaType(attachment.mediaType);

	useEffect(() => {
		const current = ownedUrl;
		return () => revokeAttachmentPreview(current ?? undefined);
	}, [ownedUrl]);

	useEffect(() => {
		const storageId = attachment.storageId;
		const mediaType = attachment.mediaType;
		if (!shouldEagerLoadAttachmentPreview({ mediaType, url: attachment.url })) {
			return;
		}
		const loader = loadAttachmentRef.current;
		if (!loader) {
			return;
		}
		let cancelled = false;
		setLoadFailed(false);
		void loader(storageId)
			.then((next) => {
				if (cancelled) {
					revokeAttachmentPreview(next ?? undefined);
					return;
				}
				setOwnedUrl(next);
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
	}, [attachment.storageId, attachment.mediaType, attachment.url]);

	useEffect(() => {
		return () => {
			downloadGeneration.current += 1;
		};
	}, []);

	async function downloadFile() {
		if (downloadPending) {
			return;
		}
		const existing = url;
		if (existing?.startsWith('blob:')) {
			triggerAttachmentDownload(existing, attachment.name);
			return;
		}
		if (!loadAttachment && !existing) {
			setLoadFailed(true);
			return;
		}
		const generation = downloadGeneration.current;
		setDownloadPending(true);
		setLoadFailed(false);
		try {
			let next: string | null = null;
			if (loadAttachment) {
				next = await loadAttachment(attachment.storageId);
			} else if (existing) {
				const response = await fetch(existing);
				if (!response.ok) throw new Error('Download failed');
				next = URL.createObjectURL(await response.blob());
			}
			if (generation !== downloadGeneration.current) {
				revokeAttachmentPreview(next ?? undefined);
				return;
			}
			if (!next) {
				setLoadFailed(true);
				return;
			}
			setOwnedUrl(next);
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

	if (previewable && loadAttachment && !loadFailed) {
		return (
			<span
				className="border-hairline bg-hover-fill inline-flex size-14 animate-pulse rounded-xl border"
				aria-label={`Loading ${attachment.name}`}
			></span>
		);
	}

	if (previewable) {
		return (
			<span className="text-muted-foreground border-hairline bg-hover-fill inline-flex items-center rounded-xl border px-3 py-2 text-xs">
				{`${attachment.name} (unavailable)`}
			</span>
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

	if (loadFailed) {
		return (
			<button
				type="button"
				className={`${fileChipClass} cursor-pointer`}
				aria-label={`Retry download of ${attachment.name}`}
				title={attachment.name}
				onClick={() => {
					void downloadFile();
				}}
			>
				<FileText className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{`${attachment.name} (unavailable)`}</span>
			</button>
		);
	}

	if (loadAttachment || url) {
		return (
			<button
				type="button"
				className={`${fileChipClass} cursor-pointer`}
				aria-label={`Download ${attachment.name}`}
				title={attachment.name}
				onClick={() => {
					void downloadFile();
				}}
			>
				<FileText className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				<span className="min-w-0 truncate">{attachment.name}</span>
			</button>
		);
	}

	return (
		<span className="text-muted-foreground border-hairline bg-hover-fill inline-flex items-center rounded-xl border px-3 py-2 text-xs">
			{`${attachment.name} (unavailable)`}
		</span>
	);
}
