import type { InboxSectionData } from '$lib/project/inbox';

export default function InboxLoadMore({ section }: { section: InboxSectionData }) {
	return (
		<div className="inbox-load-more" aria-live="polite">
			{section.error ? (
				<span role="alert">{section.error}</span>
			) : section.loading ? (
				<span>Loading...</span>
			) : section.canLoadMore ? (
				<button type="button" onClick={section.loadMore}>
					Show more
				</button>
			) : null}
		</div>
	);
}
