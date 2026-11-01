import { useCallback, useEffect, useState } from 'react';
import { useAction, useConvexAuth, useQuery_experimental } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import type { PurchaseStatus } from '@convex/lib/validators';
import SaveCardButton from '$lib/components/home/save-card-button';
import { convexClientErrorMessage } from '$lib/convex-error';
import { formatMinorAmount } from '$lib/format';

type Card = FunctionReturnType<typeof api.payments.myPayments>['cards'][number];

const statusLabels: Record<PurchaseStatus, string> = {
	awaiting_approval: 'Awaiting approval',
	approved: 'Approved',
	submitted_on_device: 'Submitted on device',
	declined: 'Declined',
	expired: 'Expired',
	settled: 'Completed'
};

const sectionLabelClass = 'text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase';

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
	const myPayments = useAction(api.payments.myPayments);
	const [cards, setCards] = useState<Card[] | null>(null);
	const [cardsError, setCardsError] = useState<string | null>(null);
	const [openError, setOpenError] = useState<string | null>(null);

	const purchases = useQuery_experimental({
		query: api.payments.listMyPurchases,
		args: signedIn ? {} : 'skip'
	});

	const loadCards = useCallback(async () => {
		try {
			setCards((await myPayments({})).cards);
			setCardsError(null);
		} catch (error) {
			setCardsError(errorMessage(error, 'Couldn’t load your cards.'));
		}
	}, [myPayments]);

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
				<div className="max-w-xl space-y-10">
					<div>
						<p className={sectionLabelClass}>Cards</p>
						<p className="text-muted-foreground mt-2 text-sm leading-6">
							You approve every purchase with your passkey through Agentcard.
						</p>
						{cardsError && <p className="text-destructive mt-3 text-sm">{cardsError}</p>}
						{cards === null ? null : cards.length === 0 ? (
							<p className="text-muted-foreground mt-3 text-sm leading-6">No cards saved yet.</p>
						) : (
							<ul className="mt-3 space-y-1">
								{cards.map((card) => (
									<li key={card.id} className="flex items-baseline justify-between gap-3 py-2">
										<p className="text-foreground text-[14px] capitalize">
											{card.brand} •••• {card.last4}
										</p>
										<p className="text-muted-foreground shrink-0 text-[12px]">
											Expires {String(card.expiryMonth).padStart(2, '0')}/{card.expiryYear}
										</p>
									</li>
								))}
							</ul>
						)}
						<div className="mt-4">
							<SaveCardButton label="Add a card" />
						</div>
					</div>

					<div>
						<p className={sectionLabelClass}>Purchases</p>
						{purchases.status === 'error' && (
							<p className="text-destructive mt-3 text-sm">
								{errorMessage(purchases.error, 'Couldn’t load purchases.')}
							</p>
						)}
						{openError && <p className="text-destructive mt-3 text-sm">{openError}</p>}
						{purchases.status === 'success' &&
							(purchases.data.length === 0 ? (
								<p className="text-muted-foreground mt-3 text-sm leading-6">No purchases yet.</p>
							) : (
								<ul className="mt-3 space-y-1">
									{purchases.data.map((purchase) => (
										<li key={purchase._id} className="py-2">
											<div className="flex items-baseline justify-between gap-3">
												<p className="text-foreground truncate text-[14px]">{purchase.merchant}</p>
												<p className="text-foreground shrink-0 text-[14px] tabular-nums">
													{formatMinorAmount(purchase.amount, purchase.currency)}
												</p>
											</div>
											<p className="text-muted-foreground mt-0.5 text-[12px]">
												{statusLabels[purchase.status]}
												{purchase.orderNumber && <> · Order {purchase.orderNumber}</>} ·{' '}
												{purchaseDate.format(purchase.createdAt)} ·{' '}
												<button
													type="button"
													className="hover:text-foreground underline-offset-2 transition hover:underline"
													onClick={() => void openThread(purchase.threadId)}
												>
													Open thread
												</button>
											</p>
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
