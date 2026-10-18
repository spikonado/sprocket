import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
	ChevronDown,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	type LucideIcon
} from 'lucide-react';
import type { LinkedPullRequest as PullRequest } from '@convex/lib/validators';
import { listenOpenMenuDismiss } from '$lib/components/ui/menu-dismiss';

type PullRequestState = PullRequest['state'];

const stateDisplay: Record<PullRequestState, { Icon: LucideIcon; label: string }> = {
	open: { Icon: GitPullRequest, label: 'Open' },
	closed: { Icon: GitPullRequestClosed, label: 'Closed' },
	merged: { Icon: GitMerge, label: 'Merged' }
};

// Open PRs still need the user, and merged ones outrank PRs closed along the way.
const SUMMARY_ORDER: readonly PullRequestState[] = ['open', 'merged', 'closed'];

const DASHBOARD_GAP_PX = 6;

const VIEWPORT_MARGIN_PX = 8;

const pullRequestUrl = (pr: PullRequest) => `https://${pr.repository}/pull/${pr.number}`;

const shortRepository = (repository: string) => repository.replace(/^github\.com\//, '');

/** One button for a thread's linked PRs: a link for one PR, a dashboard for several. */
export default function LinkedPullRequests({
	pullRequests
}: {
	pullRequests: readonly PullRequest[];
}) {
	if (pullRequests.length === 0) return null;

	if (pullRequests.length > 1) return <PullRequestDashboard pullRequests={pullRequests} />;

	const [pr] = pullRequests;
	const { Icon, label } = stateDisplay[pr.state];

	return (
		<a
			className="inbox-pr-button"
			href={pullRequestUrl(pr)}
			target="_blank"
			rel="noreferrer"
			draggable={false}
			aria-label={`${label} PR #${pr.number}: ${pr.title}`}
		>
			<Icon size={12} className={`inbox-pr-${pr.state}`} aria-hidden />#{pr.number}
		</a>
	);
}

function PullRequestDashboard({ pullRequests }: { pullRequests: readonly PullRequest[] }) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const panelId = useId();

	const summaryState =
		SUMMARY_ORDER.find((state) => pullRequests.some((pr) => pr.state === state)) ?? 'open';

	const SummaryIcon = stateDisplay[summaryState].Icon;

	const counts = SUMMARY_ORDER.flatMap((state) => {
		const count = pullRequests.filter((pr) => pr.state === state).length;

		return count > 0 ? [`${count} ${stateDisplay[state].label.toLowerCase()}`] : [];
	});

	const multipleRepositories = new Set(pullRequests.map((pr) => pr.repository)).size > 1;

	useLayoutEffect(() => {
		const trigger = triggerRef.current?.getBoundingClientRect();
		const panel = panelRef.current;

		if (!open || !trigger || !panel) return;

		const { width, height } = panel.getBoundingClientRect();
		const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN_PX;
		const maxTop = window.innerHeight - height - VIEWPORT_MARGIN_PX;
		const left = Math.min(trigger.right + DASHBOARD_GAP_PX, maxLeft);
		const top = Math.min(trigger.top - DASHBOARD_GAP_PX, maxTop);

		panel.style.left = `${Math.max(VIEWPORT_MARGIN_PX, left)}px`;
		panel.style.top = `${Math.max(VIEWPORT_MARGIN_PX, top)}px`;
		panel.focus();
	}, [open]);

	useEffect(() => {
		if (!open) return;

		// Placed once on open, so it closes rather than drift away from its button.
		function closeOnMove(event: Event) {
			if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
			setOpen(false);
		}

		const stopDismiss = listenOpenMenuDismiss({
			getRoot: () => [triggerRef.current, panelRef.current],
			onOutside: () => setOpen(false),
			onEscape: () => {
				setOpen(false);
				triggerRef.current?.focus();
			}
		});

		window.addEventListener('resize', closeOnMove);
		window.addEventListener('scroll', closeOnMove, true);

		return () => {
			stopDismiss();
			window.removeEventListener('resize', closeOnMove);
			window.removeEventListener('scroll', closeOnMove, true);
		};
	}, [open]);

	function closeOnFocusLeave(event: ReactFocusEvent<HTMLDivElement>) {
		const next = event.relatedTarget;

		if (!(next instanceof Node) || event.currentTarget.contains(next)) return;

		if (next !== triggerRef.current) setOpen(false);
	}

	function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();

		const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a')];
		const current = links.findIndex((link) => link === document.activeElement);
		const step = event.key === 'ArrowDown' ? 1 : -1;
		const from = current === -1 && step === -1 ? 0 : current;

		links.at((from + step) % links.length)?.focus();
	}

	return (
		<>
			<button
				ref={triggerRef}
				className="inbox-pr-button"
				type="button"
				aria-label={`${pullRequests.length} linked PRs: ${counts.join(', ')}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen((wasOpen) => !wasOpen)}
			>
				<SummaryIcon size={12} className={`inbox-pr-${summaryState}`} aria-hidden />
				{pullRequests.length}
				<ChevronDown size={10} className="inbox-pr-button-chevron" aria-hidden />
			</button>
			{open &&
				createPortal(
					// React bubbles portal events to the row, whose context menu acts on the thread.
					<div
						ref={panelRef}
						id={panelId}
						className="inbox-pr-dashboard"
						role="dialog"
						aria-label="Linked pull requests"
						tabIndex={-1}
						onKeyDown={moveFocus}
						onBlur={closeOnFocusLeave}
						onContextMenu={(event) => event.stopPropagation()}
					>
						<div className="inbox-pr-dashboard-heading">
							<span>Pull requests</span>
							<span>{counts.join(' · ')}</span>
						</div>
						<ul>
							{[...pullRequests].reverse().map((pr) => {
								const { Icon, label } = stateDisplay[pr.state];

								return (
									<li key={`${pr.repository}#${pr.number}`}>
										<a
											className="inbox-pr-item"
											href={pullRequestUrl(pr)}
											target="_blank"
											rel="noreferrer"
											draggable={false}
											onClick={() => setOpen(false)}
										>
											<Icon size={14} className={`inbox-pr-${pr.state}`} aria-hidden />
											<span className="inbox-pr-item-body">
												<span className="inbox-pr-item-title">{pr.title}</span>
												<span className="inbox-pr-item-meta">
													<span className={`inbox-pr-${pr.state}`}>{label}</span>
													{multipleRepositories && <span>{shortRepository(pr.repository)}</span>}
												</span>
											</span>
											<span className="inbox-pr-item-number">#{pr.number}</span>
										</a>
									</li>
								);
							})}
						</ul>
					</div>,
					document.body
				)}
		</>
	);
}
