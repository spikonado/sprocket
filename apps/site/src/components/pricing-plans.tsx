import { useEffect, useRef, useState } from 'react';
import { captureException, observeSection, setAnalyticsUser, track } from '@/lib/analytics/client';
import {
	clearCheckoutAttempt,
	fetchCheckoutStatus,
	fetchCustomerPortalUrl,
	fetchMySubscription,
	fetchPricingCatalog,
	loadPricingSession,
	readCheckoutAttempt,
	signInForCheckout,
	signOutOfPricing,
	startCheckout,
	userFacingError
} from '@/lib/pricing/billing';
import {
	buildCreditPackCards,
	buildPlanCards,
	isBillingInterval,
	readPurchase,
	type PlanCard,
	type Purchase
} from '@/lib/pricing/catalog';
import type {
	BillingInterval,
	CheckoutStatus,
	MySubscription,
	PublicPricingCatalog
} from '@/lib/pricing/convex-types';
import { cn } from '@/utils';

type User = { id: string; email: string };

const SUPPORT_EMAIL = 'aarav@spikonado.com';
const SUPPORT_HREF = `mailto:${SUPPORT_EMAIL}?subject=Sprocket%20billing%20support`;
const ACTIVATION_TIMEOUT_MS = 30_000;
const ACTIVATION_POLL_MS = 2_000;

// Dodo appends `payment_id`, `status` and `email` to the return URL.
const CHECKOUT_PARAMS = [
	'checkout',
	'tier',
	'interval',
	'pack',
	'sign_in',
	'payment_id',
	'status',
	'email'
];

const INTERVALS = ['monthly', 'annual'] as const;

const linkClass =
	'font-medium text-accent-strong underline decoration-accent-strong/30 underline-offset-4 disabled:opacity-60';

const ctaClass =
	'focus-visible:ring-ring/50 inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

const secondaryCtaClass = 'border-border bg-surface text-foreground hover:bg-action-soft border';

function purchaseId(purchase: Purchase): string {
	return 'pack' in purchase ? purchase.pack : purchase.tier;
}

function purchaseProps(purchase: Purchase) {
	return 'pack' in purchase
		? { pack: purchase.pack }
		: { plan: purchase.tier, interval: purchase.interval };
}

export default function PricingPlans({
	initialCatalog
}: {
	initialCatalog: PublicPricingCatalog | null;
}) {
	const [catalog, setCatalog] = useState(initialCatalog);
	const [interval, setBillingInterval] = useState<BillingInterval>('monthly');
	const [user, setUser] = useState<User | null>(null);
	const [subscription, setSubscription] = useState<MySubscription | null>(null);
	const [loading, setLoading] = useState(true);
	// `id` is the plan or pack whose button shows the label.
	const [busy, setBusy] = useState<{ id: string | null; label: string } | null>(null);
	const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
	const [pending, setPending] = useState(false);

	// Checkout recovery runs across renders and needs the latest catalog for its messages.
	const catalogRef = useRef(catalog);
	catalogRef.current = catalog;

	const cards = catalog ? buildPlanCards(catalog) : [];
	const packs = catalog ? buildCreditPackCards(catalog) : [];
	const largestDiscount = Math.max(0, ...cards.map((card) => card.annualDiscountPercent));

	// Plan changes go through the Dodo portal, since checkout refuses a second subscription.
	const subscribed =
		subscription !== null && subscription.tier !== 'free' && subscription.billingManaged;

	function fail(cause: unknown, fallback: string) {
		setBusy(null);
		const message = userFacingError(cause);
		setNotice({
			text: message ?? (cause instanceof Error ? cause.message : fallback),
			error: true
		});

		if (!message) captureException(cause, fallback);
	}

	async function loadAccount(): Promise<User | null> {
		const { user: current } = await loadPricingSession({ reload: true });
		setAnalyticsUser(current);
		setUser(current);
		setSubscription(current ? await fetchMySubscription() : null);

		return current;
	}

	/**
	 * A subscription counts once its tier shows. A pack counts once the webhook granted its credit.
	 * Returns the notice to show, or null while the purchase is unconfirmed.
	 */
	async function confirmation(purchase: Purchase, status: CheckoutStatus): Promise<string | null> {
		if ('pack' in purchase) {
			if (status.creditsAdded !== true) return null;
			const current = catalogRef.current;

			const pack =
				current && buildCreditPackCards(current).find((card) => card.productId === purchase.pack);

			return pack
				? `${pack.usage} of AI usage was added to your account. It expires ${pack.expiresAfter} after purchase.`
				: 'Your credit pack was added to your account.';
		}

		if (!status.activated) return null;
		const current = await fetchMySubscription();
		setSubscription(current);

		return current.tier === purchase.tier
			? `${current.tierLabel} is active. You can manage billing anytime from this page.`
			: null;
	}

	async function recoverAttempt(signedInUser: User | null): Promise<boolean> {
		const attempt = signedInUser && readCheckoutAttempt(signedInUser.id);

		if (!attempt) return false;
		const { purchase } = attempt;

		const label =
			'pack' in purchase
				? null
				: (catalogRef.current?.plans.find((plan) => plan.id === purchase.tier)?.label ??
					purchase.tier);

		const what = label ? `${label} subscription` : 'credit pack';
		setPending(true);
		setBusy({ id: purchaseId(purchase), label: label ? `Confirming ${label}…` : 'Confirming…' });
		setNotice({ text: `Confirming your ${what}…`, error: false });
		const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;

		while (Date.now() < deadline) {
			const status = await fetchCheckoutStatus(attempt.attemptId).catch(() => null);

			if (status?.status === 'awaiting_payment') {
				setBusy(null);
				setNotice({ text: `Your ${what} checkout is not paid yet.`, error: false });

				return true;
			}

			if (status?.status === 'failed') {
				clearCheckoutAttempt();
				setPending(false);
				setBusy(null);
				setNotice({
					text: 'Your previous checkout did not complete. You can start a new checkout below.',
					error: false
				});

				return true;
			}

			const confirmed = status && (await confirmation(purchase, status));

			if (confirmed) {
				clearCheckoutAttempt();
				setPending(false);
				setBusy(null);
				setNotice({ text: confirmed, error: false });

				if ('pack' in purchase) track('pricing_credits_added', { pack: purchase.pack });
				else track('pricing_subscription_activated', { plan: purchase.tier });

				return true;
			}

			await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_MS));
		}

		setBusy(null);
		setNotice({
			text: `We could not confirm your ${what} payment yet. Check again in a moment. No new purchase will be started.`,
			error: false
		});
		track('pricing_activation_timed_out', purchaseProps(purchase));

		return true;
	}

	async function checkout(purchase: Purchase, signedInUser: User | null) {
		setNotice(null);
		const id = purchaseId(purchase);

		if (!signedInUser) {
			setBusy({ id, label: 'Redirecting to sign in…' });
			signInForCheckout(purchase);

			return;
		}

		setBusy({ id, label: 'Starting checkout…' });
		const props = purchaseProps(purchase);
		track('pricing_checkout_started', props);

		try {
			const checkoutUrl = await startCheckout(purchase);
			setBusy({ id, label: 'Redirecting to checkout…' });
			track('pricing_checkout_redirected', props);
			window.location.assign(checkoutUrl);
		} catch (error) {
			track('pricing_checkout_failed', props);
			fail(error, 'Could not start checkout.');
			setPending(readCheckoutAttempt(signedInUser.id) !== null);

			// A refusal can mean a subscription went live since the page loaded.
			if (userFacingError(error)) await loadAccount().catch(() => {});
		}
	}

	async function manageBilling(id: string | null = null) {
		setBusy({ id, label: 'Opening billing portal…' });

		try {
			window.location.assign(await fetchCustomerPortalUrl());
		} catch (error) {
			fail(error, 'Could not open the billing portal.');
		}
	}

	async function checkPaymentStatus() {
		try {
			if (!(await recoverAttempt(user))) {
				await loadAccount();
				setPending(false);
				setNotice({ text: 'Your billing status has been refreshed.', error: false });
			}
		} catch (error) {
			fail(error, 'Could not check the payment status.');
		}
	}

	async function signOut() {
		setBusy({ id: null, label: 'Signing out…' });

		try {
			await signOutOfPricing();
			setAnalyticsUser(null);
			setUser(null);
			setSubscription(null);
			setPending(false);
			setBusy(null);
			setNotice(null);
		} catch (error) {
			fail(error, 'Could not sign out. Please try again.');
		}
	}

	function selectInterval(next: BillingInterval) {
		setBillingInterval(next);
		track('pricing_interval_selected', { interval: next });
	}

	function selectPlan(card: PlanCard) {
		if (!card.isFree && subscribed) {
			void manageBilling(card.id);

			return;
		}

		track('pricing_plan_selected', { plan: card.id, interval, signed_in: user !== null });

		if (card.isFree) window.location.assign('/#download');
		else void checkout({ tier: card.id, interval }, user);
	}

	function buyPack(productId: string) {
		track('pricing_credit_pack_selected', { pack: productId, signed_in: user !== null });
		void checkout({ pack: productId }, user);
	}

	function buttonLabel(card: PlanCard): string {
		if (busy?.id === card.id) return busy.label;

		if (card.isFree) return 'Start free';

		if (card.id === subscription?.tier)
			return subscription.billingManaged ? 'Manage billing' : 'Current plan';

		if (!card.prices[interval]) return 'Unavailable';

		return subscribed ? `Switch to ${card.name}` : `Get ${card.name}`;
	}

	function buttonDisabled(card: PlanCard): boolean {
		if (card.isFree) return false;

		if (loading || busy) return true;

		if (card.id === subscription?.tier) return !subscription.billingManaged;

		return !card.prices[interval];
	}

	async function initialize(params: URLSearchParams) {
		try {
			const signedInUser = await loadAccount();
			const purchase = readPurchase(params);

			if (params.get('checkout') === 'resume' && purchase) {
				// Never send the user back to sign-in from here, which would loop if the session cookie is lost.
				if (!signedInUser)
					throw new Error('Your sign-in could not be restored. Choose your purchase to try again.');
				await checkout(purchase, signedInUser);

				return;
			}

			if (params.get('sign_in') === 'failed') {
				track('pricing_sign_in_failed', {});
				setNotice({ text: 'Sign-in could not be completed. Try again.', error: true });
			} else if (params.get('checkout') === 'cancel') {
				clearCheckoutAttempt();
				track('pricing_checkout_cancelled', {});
				setNotice({ text: 'Checkout was cancelled. You can try again anytime.', error: false });

				return;
			}

			await recoverAttempt(signedInUser);
		} catch (error) {
			fail(error, 'Could not load your account.');
		} finally {
			setLoading(false);
		}
	}

	// Runs once: the flows it starts read the catalog through `catalogRef` and take the user as an argument.
	useEffect(() => {
		const url = new URL(window.location.href);
		const params = new URLSearchParams(url.search);
		const requestedInterval = params.get('interval');

		if (isBillingInterval(requestedInterval)) setBillingInterval(requestedInterval);
		CHECKOUT_PARAMS.forEach((name) => url.searchParams.delete(name));
		window.history.replaceState(window.history.state, '', url);

		fetchPricingCatalog()
			.then(setCatalog)
			.catch(() => {
				if (!catalogRef.current)
					setNotice({ text: 'Could not load plans. Reload to try again.', error: true });
			});
		void initialize(params);

		const onPageShow = (event: PageTransitionEvent) => {
			if (!event.persisted) return;
			setBusy(null);
			void initialize(new URLSearchParams());
		};

		window.addEventListener('pageshow', onPageShow);

		return () => window.removeEventListener('pageshow', onPageShow);
	}, []);

	return (
		<>
			<section aria-label="Plans" data-ph-capture-attribute-section="pricing_plans">
				<div className="flex flex-col items-center text-center">
					<fieldset className="border-border/70 bg-surface inline-flex rounded-full border p-1">
						<legend className="sr-only">Billing interval</legend>
						{INTERVALS.map((value) => (
							<label key={value} className="cursor-pointer">
								<input
									className="peer sr-only"
									type="radio"
									name="billing-interval"
									value={value}
									checked={interval === value}
									onChange={() => selectInterval(value)}
								/>
								<span className="text-muted-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:ring-ring/50 block rounded-full px-5 py-2 text-sm font-medium transition-colors peer-focus-visible:ring-2">
									{value === 'monthly' ? 'Monthly' : 'Yearly'}
									{value === 'annual' && largestDiscount > 0 && (
										<span className="ml-2 text-xs">{largestDiscount}% off</span>
									)}
								</span>
							</label>
						))}
					</fieldset>

					{notice && (
						<p
							className={cn(
								'mt-6 max-w-2xl rounded-xl border px-4 py-3 text-left text-sm',
								notice.error
									? 'border-red-300/70 bg-red-50 text-red-900'
									: 'border-accent/25 bg-accent-soft text-foreground'
							)}
							role={notice.error ? 'alert' : 'status'}
						>
							{notice.text}
						</p>
					)}

					{user && pending && (
						<div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm">
							<p className="text-muted-foreground w-full">
								Your payment is not confirmed yet. If you are stuck, email{' '}
								<a className={linkClass} href={SUPPORT_HREF}>
									{SUPPORT_EMAIL}
								</a>
								.
							</p>
							<button
								type="button"
								className={linkClass}
								disabled={!!busy}
								onClick={() => void checkPaymentStatus()}
							>
								Check payment status
							</button>
						</div>
					)}

					{user && (
						<div className="text-muted-foreground mt-4 flex flex-wrap items-center justify-center gap-3 text-sm">
							<p>
								Signed in as <span className="text-foreground">{user.email}</span>
								{subscription && subscription.tier !== 'free' && (
									<>
										. Current plan:{' '}
										<span className="text-foreground">{subscription.tierLabel}</span>
									</>
								)}
							</p>
							<button
								type="button"
								className={linkClass}
								disabled={!!busy}
								onClick={() => void signOut()}
							>
								Sign out
							</button>
							{subscription?.billingManaged && (
								<>
									<button
										type="button"
										className={linkClass}
										disabled={!!busy}
										onClick={() => void manageBilling()}
									>
										Manage billing
									</button>
									<a className={linkClass} href={SUPPORT_HREF}>
										Billing support
									</a>
								</>
							)}
						</div>
					)}
				</div>

				{cards.length === 0 ? (
					<p className="text-muted-foreground mt-12 text-center text-sm" role="status">
						Loading plan details…
					</p>
				) : (
					<div className="mt-12 flex flex-wrap justify-center gap-6">
						{cards.map((card) => {
							const price = card.prices[interval];
							const yearly = interval === 'annual';

							return (
								<article
									key={card.id}
									className={cn(
										'border-border/70 bg-surface/90 relative flex w-full min-w-0 flex-col rounded-2xl border p-6 sm:w-[calc((100%-1.5rem)/2)] sm:p-7 lg:w-[calc((100%-3rem)/3)] xl:w-[calc((100%-4.5rem)/4)]',
										card.highlighted && 'border-accent/40 ring-accent/30 ring-2'
									)}
								>
									{card.highlighted && (
										<span className="bg-accent-soft text-accent-strong absolute top-5 right-5 rounded-full px-3 py-1 text-xs font-medium">
											Most popular
										</span>
									)}
									<h2 className="text-foreground text-xl font-semibold">{card.name}</h2>
									<div className="mt-3 min-h-16">
										<p className="text-foreground text-3xl font-semibold tracking-tight">
											{(yearly ? card.annualPerMonth : price) ?? 'Unavailable'}
										</p>
										{price && (
											<p className="text-muted-foreground mt-1 text-sm">
												per month
												{card.isFree
													? ', no credit card required'
													: yearly
														? `, billed ${price} yearly`
														: ''}
											</p>
										)}
									</div>
									{card.description && (
										<p className="text-muted-foreground mt-3 min-h-11 text-sm leading-relaxed">
											{card.description}
										</p>
									)}
									{card.previousPlanName && (
										<p className="text-foreground mt-6 text-sm font-medium">
											Everything in {card.previousPlanName}, plus:
										</p>
									)}
									<ul
										className={cn('flex-1 space-y-2.5', card.previousPlanName ? 'mt-2.5' : 'mt-6')}
									>
										{card.features.map((feature) => (
											<li
												key={feature.label}
												className="text-foreground flex gap-2.5 text-sm leading-snug"
											>
												<span
													className="bg-action-soft mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs"
													aria-hidden="true"
												>
													✓
												</span>
												{feature.href ? (
													<a
														className="decoration-foreground/30 hover:decoration-foreground underline underline-offset-4 transition-colors"
														href={feature.href}
														target="_blank"
														rel="noopener"
													>
														{feature.label}
													</a>
												) : (
													<span>{feature.label}</span>
												)}
											</li>
										))}
									</ul>
									<button
										type="button"
										className={cn(
											ctaClass,
											'mt-8 w-full',
											card.primaryCta
												? 'bg-foreground text-background hover:bg-foreground/90'
												: secondaryCtaClass
										)}
										disabled={buttonDisabled(card)}
										onClick={() => selectPlan(card)}
									>
										{buttonLabel(card)}
									</button>
								</article>
							);
						})}
					</div>
				)}
			</section>

			{packs.length > 0 && (
				<section
					ref={(section) => (section ? observeSection(section) : undefined)}
					className="mx-auto mt-20 max-w-6xl"
					aria-labelledby="credit-packs-heading"
					data-ph-capture-attribute-section="pricing_credit_packs"
				>
					<h2 id="credit-packs-heading" className="text-foreground text-2xl font-semibold">
						Credit packs
					</h2>
					<p className="text-muted-foreground mt-3 text-base leading-relaxed">
						Packs add AI usage on top of any plan. Sprocket uses them after your monthly allowance
						runs out, until each pack expires.
					</p>
					<ul
						className="border-border/70 bg-surface/90 divide-border/70 mt-6 divide-y rounded-2xl border"
						role="list"
					>
						{packs.map((pack) => (
							<li
								key={pack.productId}
								className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:gap-6 sm:px-7"
							>
								<div className="flex min-w-0 flex-1 flex-col gap-1 lg:flex-row lg:items-baseline lg:gap-8">
									<p
										id={`pack-${pack.productId}`}
										className="text-foreground text-xl font-semibold tracking-tight lg:w-56"
									>
										{pack.usage} of AI usage
									</p>
									<p className="text-muted-foreground text-sm">
										Expires {pack.expiresAfter} after purchase
									</p>
								</div>
								<button
									type="button"
									className={cn(ctaClass, secondaryCtaClass, 'w-full sm:w-auto sm:min-w-40')}
									aria-describedby={`pack-${pack.productId}`}
									disabled={loading || !!busy}
									onClick={() => buyPack(pack.productId)}
								>
									{busy?.id === pack.productId ? busy.label : `Buy for ${pack.price}`}
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</>
	);
}
