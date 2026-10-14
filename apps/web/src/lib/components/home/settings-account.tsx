import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useConvexAuth, useQuery_experimental as useConvexQueryResult } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { AuthUser } from '$lib/auth';
import Button from '$lib/components/ui/button/button';

export default function SettingsAccount({
	user,
	error,
	onSignOut
}: {
	user: AuthUser | null;
	error: string | null;
	onSignOut: () => void;
}) {
	const [emailRevealed, setEmailRevealed] = useState(false);
	const convexAuth = useConvexAuth();

	const subscriptionQuery = useConvexQueryResult({
		query: api.billing.getMySubscription,
		args: convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	});

	const subscription = subscriptionQuery.status === 'success' ? subscriptionQuery.data : null;
	const subscriptionError = subscriptionQuery.status === 'error';
	const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || null;

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Account</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-10">
					<div>
						<p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
							Profile
						</p>
						{displayName || user?.email ? (
							<div className="mt-3 space-y-1">
								{displayName && <p className="text-foreground text-[15px]">{displayName}</p>}
								{user?.email && (
									<button
										type="button"
										className="text-muted-foreground hover:text-foreground block text-left text-sm transition"
										aria-pressed={emailRevealed}
										aria-label={emailRevealed ? 'Hide email address' : 'Show email address'}
										onClick={() => setEmailRevealed((revealed) => !revealed)}
									>
										<span className={emailRevealed ? undefined : 'blur-[5px] select-none'}>
											{user.email}
										</span>
									</button>
								)}
							</div>
						) : (
							<p className="text-muted-foreground mt-3 text-sm">You’re signed in to Sprocket.</p>
						)}
					</div>

					<div>
						<p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
							Spikonado Subscription Tier
						</p>
						{subscription ? (
							<p className="text-foreground mt-3 text-[15px]">{subscription.tierLabel}</p>
						) : subscriptionError ? (
							<p className="text-muted-foreground mt-3 text-sm">
								Couldn’t load your subscription right now.
							</p>
						) : (
							<div
								className="bg-hover-fill mt-3.5 h-4 w-16 animate-pulse rounded"
								aria-hidden="true"
							/>
						)}
					</div>

					<div>
						<Button variant="outline" onclick={onSignOut}>
							<LogOut className="mr-2 size-4" aria-hidden="true" />
							Sign Out
						</Button>
						{error && (
							<p role="alert" className="text-destructive mt-3 text-sm">
								{error}
							</p>
						)}
					</div>
				</div>
			</div>
		</section>
	);
}
