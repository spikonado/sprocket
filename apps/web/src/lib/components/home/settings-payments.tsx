import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Truck } from 'lucide-react';
import { useAction, useConvexAuth, useQuery_experimental } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import type { PurchaseStatus } from '@convex/lib/validators';
import SaveCardButton from '$lib/components/home/save-card-button';
import { convexClientErrorMessage } from '$lib/convex-error';
import { formatMinorAmount } from '$lib/format';
import { cn } from '$lib/utils';

type Card = FunctionReturnType<typeof api.payments.listMyCards>[number];

const statuses: Record<PurchaseStatus, { label: string; dot: string }> = {
	awaiting_approval: { label: 'Awaiting approval', dot: 'bg-amber-500' },
	approved: { label: 'Approved', dot: 'bg-emerald-500' },
	submitted_on_device: { label: 'Finishing on your device', dot: 'bg-accent-strong' },
	declined: { label: 'Declined', dot: 'bg-destructive' },
	expired: { label: 'Expired', dot: 'bg-muted-foreground/50' },
	cancelled: { label: 'Cancelled', dot: 'bg-muted-foreground/50' },
	settled: { label: 'Completed', dot: 'bg-emerald-500' }
};

const sectionHeadingClass = 'text-foreground text-[15px] font-medium tracking-[-0.01em]';

const paymentCardClass = 'aspect-[85.6/53.98] w-52 rounded-[8px]';

const rowButtonClass =
	'border-border text-foreground hover:bg-hover-fill focus-visible:ring-ring/50 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-visible:ring-2 focus-visible:outline-none';

const purchaseDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function errorMessage<Caught>(error: Caught, fallback: string) {
	return (error instanceof Error && convexClientErrorMessage(error)) || fallback;
}

export default function SettingsPayments({
	onOpenThread
}: {
	onOpenThread: (threadId: Id<'threadRecords'>) => Promise<void>;
}) {
	const convexAuth = useConvexAuth();
	const signedIn = convexAuth.isAuthenticated && !convexAuth.isLoading;
	const listMyCards = useAction(api.payments.listMyCards);
	const [cards, setCards] = useState<Card[] | null>(null);
	const [cardsError, setCardsError] = useState<string | null>(null);
	const [openError, setOpenError] = useState<string | null>(null);

	const purchases = useQuery_experimental({
		query: api.payments.listMyPurchases,
		args: signedIn ? {} : 'skip'
	});

	const loadCards = useCallback(async () => {
		try {
			setCards(await listMyCards({}));
			setCardsError(null);
		} catch (error) {
			setCardsError(errorMessage(error, 'Couldn’t load your cards.'));
		}
	}, [listMyCards]);

	// Cards are saved in the Agentcard popup, so reload when the user comes back.
	useEffect(() => {
		if (!signedIn) return;
		void loadCards();
		const reload = () => void loadCards();
		window.addEventListener('focus', reload);

		return () => window.removeEventListener('focus', reload);
	}, [signedIn, loadCards]);

	async function openThread(threadId: Id<'threadRecords'>) {
		setOpenError(null);

		try {
			await onOpenThread(threadId);
		} catch (error) {
			setOpenError(errorMessage(error, 'Couldn’t open that thread.'));
		}
	}

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Payments</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-2xl space-y-12">
					<div>
						<div className="flex items-start justify-between gap-4">
							<div>
								<h2 className={sectionHeadingClass}>Cards</h2>
								<p className="text-muted-foreground mt-1 text-sm leading-6">
									Your agent pays with these. You approve every purchase with your passkey.
								</p>
							</div>
							<div className="shrink-0">
								<SaveCardButton label="Add a card" />
							</div>
						</div>
						{cardsError && <p className="text-destructive mt-4 text-sm">{cardsError}</p>}
						{cards === null ? (
							!cardsError && (
								<div className={cn(paymentCardClass, 'bg-hover-fill mt-5')} aria-hidden="true" />
							)
						) : cards.length === 0 ? (
							<p className="border-border text-muted-foreground mt-4 rounded-xl border border-dashed px-5 py-6 text-sm leading-6">
								No cards yet. Add one so your agent can pay at checkout.
							</p>
						) : (
							<ul className="mt-5 flex flex-wrap gap-4">
								{cards.map((card) => (
									<li
										key={card.id}
										className={cn(
											paymentCardClass,
											'flex flex-col justify-between bg-[linear-gradient(135deg,oklch(0.34_0.03_250),oklch(0.2_0.02_260))] p-4 text-white shadow-[0_14px_30px_-18px_oklch(0.18_0.02_260/0.7)] ring-1 ring-white/10'
										)}
									>
										<p className="text-[13px] font-semibold capitalize">{card.brand}</p>
										<div>
											<p className="text-[17px] tracking-[0.08em] tabular-nums">
												•••• {card.last4}
											</p>
											<p className="mt-1 text-[11px] tabular-nums opacity-70">
												Expires {String(card.expiryMonth).padStart(2, '0')}/
												{String(card.expiryYear).slice(-2)}
											</p>
										</div>
									</li>
								))}
							</ul>
						)}
					</div>

					<div>
						<h2 className={sectionHeadingClass}>Purchases</h2>
						{purchases.status === 'error' && (
							<p className="text-destructive mt-4 text-sm">
								{errorMessage(purchases.error, 'Couldn’t load purchases.')}
							</p>
						)}
						{openError && <p className="text-destructive mt-4 text-sm">{openError}</p>}
						{purchases.status === 'success' &&
							(purchases.data.length === 0 ? (
								<p className="text-muted-foreground mt-1 text-sm leading-6">
									Things your agent buys show up here.
								</p>
							) : (
								<ul className="divide-hairline mt-3 max-w-xl divide-y">
									{purchases.data.map((purchase) => (
										<li key={purchase._id} className="flex items-center gap-4 py-3">
											<p className="text-foreground w-16 shrink-0 text-[14px] font-medium tabular-nums">
												{formatMinorAmount(purchase.amount, purchase.currency)}
											</p>
											<div className="min-w-0 flex-1">
												<p className="text-foreground truncate text-[14px]">{purchase.merchant}</p>
												<div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]">
													<span className="text-foreground/80 inline-flex shrink-0 items-center gap-1.5">
														<span
															className={cn('size-1.5 rounded-full', statuses[purchase.status].dot)}
															aria-hidden="true"
														/>
														{statuses[purchase.status].label}
													</span>
													<span className="shrink-0">
														{purchaseDate.format(purchase.createdAt)}
													</span>
													{purchase.orderNumber &&
														(purchase.orderLink ? (
															<a
																href={purchase.orderLink}
																target="_blank"
																rel="noreferrer"
																className="hover:text-foreground max-w-full truncate underline underline-offset-2"
																title={purchase.orderNumber}
															>
																Order {purchase.orderNumber}
															</a>
														) : (
															<span className="max-w-full truncate" title={purchase.orderNumber}>
																Order {purchase.orderNumber}
															</span>
														))}
												</div>
											</div>
											<div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
												{purchase.trackingLink && (
													<a
														href={purchase.trackingLink}
														target="_blank"
														rel="noreferrer"
														className={rowButtonClass}
													>
														<Truck className="size-3.5" aria-hidden="true" />
														Track order
													</a>
												)}
												<button
													type="button"
													className={rowButtonClass}
													onClick={() => void openThread(purchase.threadId)}
												>
													<MessageSquare className="size-3.5" aria-hidden="true" />
													View thread
												</button>
											</div>
										</li>
									))}
								</ul>
							))}
					</div>
				</div>
			</div>
		</section>
	);
}
