<script lang="ts">
	import { onMount } from 'svelte';
	import { captureException, setAnalyticsUser, track } from '@/lib/analytics/client';
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
		type PlanFeature,
		type Purchase
	} from '@/lib/pricing/catalog';
	import type {
		BillingInterval,
		CheckoutStatus,
		MySubscription,
		PublicPricingCatalog
	} from '@/lib/pricing/convex-types';
	import { cn } from '@/utils';

	let { initialCatalog }: { initialCatalog: PublicPricingCatalog | null } = $props();

	const SUPPORT_EMAIL = 'aarav@spikonado.com';
	const SUPPORT_HREF = `mailto:${SUPPORT_EMAIL}?subject=Sprocket%20billing%20support`;
	const ACTIVATION_TIMEOUT_MS = 30_000;
	const ACTIVATION_POLL_MS = 2_000;

	const FREE: MySubscription = {
		tier: 'free',
		tierLabel: 'Free',
		billingManaged: false,
		accessPhase: 'none'
	};

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

	// svelte-ignore state_referenced_locally
	let catalog = $state(initialCatalog);
	let interval = $state<BillingInterval>('monthly');
	let user = $state<{ id: string; email: string } | null>(null);
	let subscription = $state(FREE);
	let loading = $state(true);

	// `id` is the plan or pack whose button shows the label.
	let busy = $state<{ id: string | null; label: string } | null>(null);
	let notice = $state<{ text: string; error: boolean } | null>(null);
	let pending = $state(false);

	const cards = $derived(catalog ? buildPlanCards(catalog) : []);
	const packs = $derived(catalog ? buildCreditPackCards(catalog) : []);
	const largestDiscount = $derived(Math.max(0, ...cards.map((card) => card.annualDiscountPercent)));

	// Plan changes go through the Dodo portal, since checkout refuses a second subscription.
	const subscribed = $derived(subscription.tier !== 'free' && subscription.billingManaged);

	const linkClass =
		'font-medium text-accent-strong underline decoration-accent-strong/30 underline-offset-4 disabled:opacity-60';

	const ctaClass =
		'focus-visible:ring-ring/50 mt-8 inline-flex min-h-11 w-full items-center justify-center rounded-full px-5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

	const secondaryCtaClass = 'border-border bg-surface text-foreground hover:bg-action-soft border';

	function planLabel(tier: string): string {
		return catalog?.plans.find((plan) => plan.id === tier)?.label ?? tier;
	}

	function fail(cause: unknown, fallback: string) {
		busy = null;
		const message = userFacingError(cause);
		notice = { text: message ?? (cause instanceof Error ? cause.message : fallback), error: true };

		if (!message) captureException(cause, fallback);
	}

	function purchaseId(purchase: Purchase): string {
		return 'pack' in purchase ? purchase.pack : purchase.tier;
	}

	function purchaseProps(purchase: Purchase) {
		return 'pack' in purchase
			? { pack: purchase.pack }
			: { plan: purchase.tier, interval: purchase.interval };
	}

	// A subscription counts once its tier shows. A pack counts once the webhook granted its credit.
	async function purchaseConfirmed(purchase: Purchase, status: CheckoutStatus): Promise<boolean> {
		if ('pack' in purchase) return status.creditsAdded === true;

		if (!status.activated) return false;
		subscription = await fetchMySubscription();

		return subscription.tier === purchase.tier;
	}

	function confirmedNotice(purchase: Purchase): string {
		if ('tier' in purchase)
			return `${subscription.tierLabel} is active. You can manage billing anytime from this page.`;
		const pack = packs.find((card) => card.productId === purchase.pack);

		return pack
			? `${pack.usage} of AI usage was added to your account. It expires ${pack.expiresAfterDays} days after purchase.`
			: 'Your credit pack was added to your account.';
	}

	async function loadAccount() {
		user = (await loadPricingSession({ reload: true })).user;
		setAnalyticsUser(user);
		subscription = user ? await fetchMySubscription() : FREE;
	}

	async function recoverAttempt(): Promise<boolean> {
		const attempt = user && readCheckoutAttempt(user.id);

		if (!attempt) return false;
		const { purchase } = attempt;
		const label = 'pack' in purchase ? null : planLabel(purchase.tier);
		const what = label ? `${label} subscription` : 'credit pack';
		pending = true;
		busy = { id: purchaseId(purchase), label: label ? `Confirming ${label}…` : 'Confirming…' };
		notice = { text: `Confirming your ${what}…`, error: false };
		const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;

		while (Date.now() < deadline) {
			const status = await fetchCheckoutStatus(attempt.attemptId).catch(() => null);

			if (status?.status === 'awaiting_payment') {
				busy = null;
				notice = { text: `Your ${what} checkout is not paid yet.`, error: false };

				return true;
			}

			if (status?.status === 'failed') {
				clearCheckoutAttempt();
				pending = false;
				busy = null;
				notice = {
					text: 'Your previous checkout did not complete. You can start a new checkout below.',
					error: false
				};

				return true;
			}

			if (status && (await purchaseConfirmed(purchase, status))) {
				clearCheckoutAttempt();
				pending = false;
				busy = null;
				notice = { text: confirmedNotice(purchase), error: false };

				if ('pack' in purchase) track('pricing_credits_added', { pack: purchase.pack });
				else track('pricing_subscription_activated', { plan: purchase.tier });

				return true;
			}

			await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_MS));
		}

		busy = null;
		notice = {
			text: `We could not confirm your ${what} payment yet. Check again in a moment. No new purchase will be started.`,
			error: false
		};
		track('pricing_activation_timed_out', purchaseProps(purchase));

		return true;
	}

	async function checkout(purchase: Purchase) {
		notice = null;
		const id = purchaseId(purchase);

		if (!user) {
			busy = { id, label: 'Redirecting to sign in…' };
			signInForCheckout(purchase);

			return;
		}

		busy = { id, label: 'Starting checkout…' };
		const props = purchaseProps(purchase);
		track('pricing_checkout_started', props);

		try {
			const checkoutUrl = await startCheckout(purchase);
			busy = { id, label: 'Redirecting to checkout…' };
			track('pricing_checkout_redirected', props);
			window.location.assign(checkoutUrl);
		} catch (error) {
			track('pricing_checkout_failed', props);
			fail(error, 'Could not start checkout.');
			pending = readCheckoutAttempt(user.id) !== null;

			// A refusal can mean a subscription went live since the page loaded.
			if (userFacingError(error)) await loadAccount().catch(() => {});
		}
	}

	async function manageBilling(id: string | null = null) {
		busy = { id, label: 'Opening billing portal…' };

		try {
			window.location.assign(await fetchCustomerPortalUrl());
		} catch (error) {
			fail(error, 'Could not open the billing portal.');
		}
	}

	async function checkPaymentStatus() {
		try {
			if (!(await recoverAttempt())) {
				await loadAccount();
				pending = false;
				notice = { text: 'Your billing status has been refreshed.', error: false };
			}
		} catch (error) {
			fail(error, 'Could not check the payment status.');
		}
	}

	async function signOut() {
		busy = { id: null, label: 'Signing out…' };

		try {
			await signOutOfPricing();
			setAnalyticsUser(null);
			user = null;
			subscription = FREE;
			pending = false;
			busy = null;
			notice = null;
		} catch (error) {
			fail(error, 'Could not sign out. Please try again.');
		}
	}

	function selectInterval(next: BillingInterval) {
		interval = next;
		track('pricing_interval_selected', { interval: next });
	}

	function selectPlan(card: PlanCard) {
		if (!card.isFree && subscribed) {
			void manageBilling(card.id);

			return;
		}

		track('pricing_plan_selected', { plan: card.id, interval, signed_in: user !== null });

		if (card.isFree) window.location.assign('/#download');
		else void checkout({ tier: card.id, interval });
	}

	function buyPack(productId: string) {
		track('pricing_credit_pack_selected', { pack: productId, signed_in: user !== null });
		void checkout({ pack: productId });
	}

	function buttonLabel(card: PlanCard): string {
		if (busy?.id === card.id) return busy.label;

		if (card.isFree) return 'Start free';

		if (card.id === subscription.tier)
			return subscription.billingManaged ? 'Manage billing' : 'Current plan';

		if (!card.prices[interval]) return 'Unavailable';

		return subscribed ? `Switch to ${card.name}` : `Get ${card.name}`;
	}

	function buttonDisabled(card: PlanCard): boolean {
		if (card.isFree) return false;

		if (loading || busy) return true;

		if (card.id === subscription.tier) return !subscription.billingManaged;

		return !card.prices[interval];
	}

	async function initialize(params: URLSearchParams) {
		try {
			await loadAccount();
			const purchase = readPurchase(params);

			if (params.get('checkout') === 'resume' && purchase) {
				// Never send the user back to sign-in from here, which would loop if the session cookie is lost.
				if (!user)
					throw new Error('Your sign-in could not be restored. Choose your purchase to try again.');
				await checkout(purchase);

				return;
			}

			if (params.get('sign_in') === 'failed') {
				track('pricing_sign_in_failed', {});
				notice = { text: 'Sign-in could not be completed. Try again.', error: true };
			} else if (params.get('checkout') === 'cancel') {
				clearCheckoutAttempt();
				track('pricing_checkout_cancelled', {});
				notice = { text: 'Checkout was cancelled. You can try again anytime.', error: false };

				return;
			}

			await recoverAttempt();
		} catch (error) {
			fail(error, 'Could not load your account.');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		const url = new URL(window.location.href);
		const params = new URLSearchParams(url.search);
		const requestedInterval = params.get('interval');

		if (isBillingInterval(requestedInterval)) interval = requestedInterval;
		CHECKOUT_PARAMS.forEach((name) => url.searchParams.delete(name));
		window.history.replaceState(window.history.state, '', url);

		fetchPricingCatalog()
			.then((next) => (catalog = next))
			.catch(() => {
				if (!catalog) notice = { text: 'Could not load plans. Reload to try again.', error: true };
			});
		void initialize(params);

		const onPageShow = (event: PageTransitionEvent) => {
			if (!event.persisted) return;
			busy = null;
			void initialize(new URLSearchParams());
		};

		window.addEventListener('pageshow', onPageShow);

		return () => window.removeEventListener('pageshow', onPageShow);
	});
</script>

{#snippet featureItem(feature: PlanFeature)}
	<li class="text-foreground flex gap-2.5 text-sm leading-snug">
		<span
			class="bg-action-soft mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs"
			aria-hidden="true">✓</span
		>
		{#if feature.href}
			<a
				class="decoration-foreground/30 hover:decoration-foreground underline underline-offset-4 transition-colors"
				href={feature.href}
				target="_blank"
				rel="noopener">{feature.label}</a
			>
		{:else}
			<span>{feature.label}</span>
		{/if}
	</li>
{/snippet}

<section aria-label="Plans" data-ph-capture-attribute-section="pricing_plans">
	<div class="flex flex-col items-center text-center">
		<fieldset class="border-border/70 bg-surface inline-flex rounded-full border p-1">
			<legend class="sr-only">Billing interval</legend>
			{#each ['monthly', 'annual'] as const as value (value)}
				<label class="cursor-pointer">
					<input
						class="peer sr-only"
						type="radio"
						name="billing-interval"
						{value}
						checked={interval === value}
						onchange={() => selectInterval(value)}
					/>
					<span
						class="text-muted-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:ring-ring/50 block rounded-full px-5 py-2 text-sm font-medium transition-colors peer-focus-visible:ring-2"
					>
						{value === 'monthly' ? 'Monthly' : 'Yearly'}
						{#if value === 'annual' && largestDiscount > 0}
							<span class="ml-2 text-xs">{largestDiscount}% off</span>
						{/if}
					</span>
				</label>
			{/each}
		</fieldset>

		{#if notice}
			<p
				class={cn(
					'mt-6 max-w-2xl rounded-xl border px-4 py-3 text-left text-sm',
					notice.error
						? 'border-red-300/70 bg-red-50 text-red-900'
						: 'border-accent/25 bg-accent-soft text-foreground'
				)}
				role={notice.error ? 'alert' : 'status'}
			>
				{notice.text}
			</p>
		{/if}

		{#if user && pending}
			<div class="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm">
				<p class="text-muted-foreground w-full">
					Your payment is not confirmed yet. If you are stuck, email
					<a class={linkClass} href={SUPPORT_HREF}>{SUPPORT_EMAIL}</a>.
				</p>
				<button type="button" class={linkClass} disabled={!!busy} onclick={checkPaymentStatus}>
					Check payment status
				</button>
			</div>
		{/if}

		{#if user}
			<div
				class="text-muted-foreground mt-4 flex flex-wrap items-center justify-center gap-3 text-sm"
			>
				<p>
					Signed in as <span class="text-foreground">{user.email}</span>
					{#if subscription.tier !== 'free'}
						. Current plan: <span class="text-foreground">{subscription.tierLabel}</span>
					{/if}
				</p>
				<button type="button" class={linkClass} disabled={!!busy} onclick={signOut}>Sign out</button
				>
				{#if subscription.billingManaged}
					<button type="button" class={linkClass} disabled={!!busy} onclick={() => manageBilling()}>
						Manage billing
					</button>
					<a class={linkClass} href={SUPPORT_HREF}>Billing support</a>
				{/if}
			</div>
		{/if}
	</div>

	{#if cards.length === 0}
		<p class="text-muted-foreground mt-12 text-center text-sm" role="status">
			Loading plan details…
		</p>
	{:else}
		<div class="mt-12 flex flex-wrap justify-center gap-6">
			{#each cards as card (card.id)}
				{@const price = card.prices[interval]}
				{@const yearly = interval === 'annual'}
				<article
					class={cn(
						'border-border/70 bg-surface/90 relative flex w-full min-w-0 flex-col rounded-2xl border p-6 sm:w-[calc((100%-1.5rem)/2)] sm:p-7 lg:w-[calc((100%-3rem)/3)] xl:w-[calc((100%-4.5rem)/4)]',
						card.highlighted && 'border-accent/40 ring-accent/30 ring-2'
					)}
				>
					{#if card.highlighted}
						<span
							class="bg-accent-soft text-accent-strong absolute top-5 right-5 rounded-full px-3 py-1 text-xs font-medium"
						>
							Most popular
						</span>
					{/if}
					<h2 class="font-brand text-foreground text-xl font-semibold">{card.name}</h2>
					<div class="mt-3 min-h-16">
						<p class="font-brand text-foreground text-3xl font-semibold tracking-tight">
							{(yearly ? card.annualPerMonth : price) ?? 'Unavailable'}
						</p>
						{#if price}
							<p class="text-muted-foreground mt-1 text-sm">
								per month{card.isFree
									? ', no credit card required'
									: yearly
										? `, billed ${price} yearly`
										: ''}
							</p>
						{/if}
					</div>
					{#if card.description}
						<p class="text-muted-foreground mt-3 min-h-11 text-sm leading-relaxed">
							{card.description}
						</p>
					{/if}
					{#if card.previousPlanName}
						<p class="text-foreground mt-6 text-sm font-medium">
							Everything in {card.previousPlanName}, plus:
						</p>
					{/if}
					<ul class={cn('flex-1 space-y-2.5', card.previousPlanName ? 'mt-2.5' : 'mt-6')}>
						{#each card.features as feature (feature.label)}
							{@render featureItem(feature)}
						{/each}
					</ul>
					<button
						type="button"
						class={cn(
							ctaClass,
							card.primaryCta
								? 'bg-foreground text-background hover:bg-foreground/90'
								: secondaryCtaClass
						)}
						disabled={buttonDisabled(card)}
						onclick={() => selectPlan(card)}
					>
						{buttonLabel(card)}
					</button>
				</article>
			{/each}
		</div>
	{/if}
</section>

{#if packs.length > 0}
	<section
		class="mx-auto mt-20 max-w-6xl"
		aria-labelledby="credit-packs-heading"
		data-ph-capture-attribute-section="pricing_credit_packs"
	>
		<h2 id="credit-packs-heading" class="font-brand text-foreground text-2xl font-semibold">
			Credit packs
		</h2>
		<p class="text-muted-foreground mt-3 max-w-2xl text-base leading-relaxed">
			Packs add AI usage on top of any plan. Sprocket uses them after your monthly allowance runs
			out, and each pack expires a set number of days after purchase.
		</p>
		<div class="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
			{#each packs as pack (pack.productId)}
				<article class="border-border/70 bg-surface/90 flex flex-col rounded-2xl border p-6 sm:p-7">
					<h3 class="font-brand text-foreground text-xl font-semibold">{pack.label}</h3>
					<p class="font-brand text-foreground mt-3 text-3xl font-semibold tracking-tight">
						{pack.price}
					</p>
					<p class="text-muted-foreground mt-1 text-sm">one-time payment</p>
					<ul class="mt-6 flex-1 space-y-2.5">
						{#each [`${pack.usage} of AI usage`, `Expires ${pack.expiresAfterDays} days after purchase`] as line (line)}
							{@render featureItem({ label: line })}
						{/each}
					</ul>
					<button
						type="button"
						class={cn(ctaClass, secondaryCtaClass)}
						disabled={loading || !!busy}
						onclick={() => buyPack(pack.productId)}
					>
						{busy?.id === pack.productId ? busy.label : `Buy ${pack.label}`}
					</button>
				</article>
			{/each}
		</div>
	</section>
{/if}
