<script lang="ts">
	import { onMount } from 'svelte';
	import { captureException, setAnalyticsUser, track } from '@/lib/analytics/client';
	import type { BillingInterval, MySubscription, PublicPricingCatalog } from '@/lib/convex/api';
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
		startCheckout
	} from '@/lib/pricing/billing';
	import { buildPlanCards, isBillingInterval, type PlanCard } from '@/lib/pricing/catalog';
	import { cn } from '@/utils';

	let { initialCatalog }: { initialCatalog: PublicPricingCatalog | null } = $props();

	const SUPPORT_EMAIL = 'aarav@spikonado.com';
	const SUPPORT_HREF = `mailto:${SUPPORT_EMAIL}?subject=Sprocket%20billing%20support`;
	const ACTIVATION_TIMEOUT_MS = 30_000;
	const ACTIVATION_POLL_MS = 2_000;
	const FREE: MySubscription = { tier: 'free', tierLabel: 'Free', billingManaged: false };
	const CHECKOUT_PARAMS = ['checkout', 'tier', 'interval', 'attempt', 'sign_in'];

	// svelte-ignore state_referenced_locally
	let catalog = $state(initialCatalog);
	let interval = $state<BillingInterval>('monthly');
	let user = $state<{ id: string; email: string } | null>(null);
	let subscription = $state(FREE);
	let loading = $state(true);
	let busy = $state<{ plan: string | null; label: string } | null>(null);
	let notice = $state<{ text: string; error: boolean } | null>(null);
	let pending = $state<{ attemptId: string; checkoutUrl: string | null } | null>(null);

	const cards = $derived(catalog ? buildPlanCards(catalog) : []);
	const largestDiscount = $derived(Math.max(0, ...cards.map((card) => card.annualDiscountPercent)));

	const linkClass =
		'font-medium text-accent-strong underline decoration-accent-strong/30 underline-offset-4 disabled:opacity-60';

	function planLabel(tier: string): string {
		return catalog?.plans.find((plan) => plan.id === tier)?.label ?? tier;
	}

	function fail(error: unknown, fallback: string) {
		busy = null;
		notice = { text: error instanceof Error ? error.message : fallback, error: true };
		captureException(error, { context: fallback });
	}

	async function loadAccount() {
		user = (await loadPricingSession({ reload: true })).user;
		setAnalyticsUser(user);
		subscription = user ? await fetchMySubscription() : FREE;
	}

	// Payment success alone is not entitlement, so wait for the subscription to show the tier.
	async function recoverAttempt(): Promise<boolean> {
		const attempt = user && readCheckoutAttempt(user.id);
		if (!attempt) return false;
		const label = planLabel(attempt.tier);
		pending = { attemptId: attempt.attemptId, checkoutUrl: null };
		busy = { plan: attempt.tier, label: `Confirming ${label}…` };
		notice = { text: `Confirming your ${label} subscription…`, error: false };
		const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const status = await fetchCheckoutStatus(attempt.attemptId).catch(() => null);
			if (status?.status === 'awaiting_payment') {
				pending = { attemptId: attempt.attemptId, checkoutUrl: status.checkout_url ?? null };
				busy = null;
				notice = { text: `Your ${label} checkout is not paid yet.`, error: false };
				return true;
			}
			if (status?.status === 'failed' || status?.status === 'expired') {
				clearCheckoutAttempt();
				pending = null;
				busy = null;
				notice = {
					text: 'Your previous checkout did not complete. You can start a new checkout below.',
					error: false
				};
				return true;
			}
			if (status?.activated) {
				subscription = await fetchMySubscription();
				if (subscription.tier === attempt.tier) {
					clearCheckoutAttempt();
					pending = null;
					busy = null;
					notice = {
						text: `${subscription.tierLabel} is active. You can manage billing anytime from this page.`,
						error: false
					};
					track('pricing_subscription_activated', { plan: attempt.tier });
					return true;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_MS));
		}
		busy = null;
		notice = {
			text: `We could not confirm your ${label} payment yet. Check again in a moment. No new purchase will be started.`,
			error: false
		};
		track('pricing_activation_timed_out', { plan: attempt.tier });
		return true;
	}

	async function checkout(tier: string, planInterval: BillingInterval) {
		busy = { plan: tier, label: 'Starting checkout…' };
		notice = null;
		if (!user) {
			busy = { plan: tier, label: 'Redirecting to sign in…' };
			signInForCheckout(tier, planInterval);
			return;
		}
		const plan = { plan: tier, interval: planInterval };
		track('pricing_checkout_started', plan);
		try {
			const checkoutUrl = await startCheckout(tier, planInterval);
			busy = { plan: tier, label: 'Redirecting to checkout…' };
			track('pricing_checkout_redirected', plan);
			window.location.assign(checkoutUrl);
		} catch (error) {
			track('pricing_checkout_failed', plan);
			fail(error, 'Could not start checkout.');
			const attempt = readCheckoutAttempt(user.id);
			if (attempt) pending = { attemptId: attempt.attemptId, checkoutUrl: null };
		}
	}

	async function manageBilling() {
		busy = { plan: subscription.tier, label: 'Opening billing portal…' };
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
				pending = null;
				notice = { text: 'Your billing status has been refreshed.', error: false };
			}
		} catch (error) {
			fail(error, 'Could not check the payment status.');
		}
	}

	async function continueCheckout() {
		if (!pending) return;
		busy = { plan: null, label: 'Redirecting to checkout…' };
		try {
			const status = await fetchCheckoutStatus(pending.attemptId);
			if (status.status === 'awaiting_payment' && status.checkout_url) {
				window.location.assign(status.checkout_url);
			} else {
				await recoverAttempt();
			}
		} catch (error) {
			fail(error, 'Could not resume the checkout.');
		}
	}

	async function signOut() {
		busy = { plan: null, label: 'Signing out…' };
		try {
			await signOutOfPricing();
			setAnalyticsUser(null);
			user = null;
			subscription = FREE;
			pending = null;
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
		if (!card.isFree && card.id === subscription.tier && subscription.billingManaged) {
			void manageBilling();
			return;
		}
		track('pricing_plan_selected', { plan: card.id, interval, signed_in: user !== null });
		if (card.isFree) window.location.assign('/#sprocket');
		else void checkout(card.id, interval);
	}

	function buttonLabel(card: PlanCard): string {
		if (busy?.plan === card.id) return busy.label;
		if (card.isFree) return 'Start free';
		if (card.id === subscription.tier)
			return subscription.billingManaged ? 'Manage billing' : 'Current plan';
		return card.prices[interval] ? `Get ${card.name}` : 'Unavailable';
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
			const tier = params.get('tier');
			const requestedInterval = params.get('interval');
			if (params.get('checkout') === 'resume' && tier && isBillingInterval(requestedInterval)) {
				// Never send the user back to sign-in from here, which would loop if the session cookie is lost.
				if (!user)
					throw new Error('Your sign-in could not be restored. Choose your plan to try again.');
				await checkout(tier, requestedInterval);
				return;
			}
			if (params.get('sign_in') === 'failed') {
				track('pricing_sign_in_failed', {});
				notice = { text: 'Sign-in could not be completed. Try again.', error: true };
			} else if (params.get('checkout') === 'cancel') {
				track('pricing_checkout_cancelled', {});
				notice = { text: 'Checkout was cancelled. You can try again anytime.', error: false };
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

<section aria-label="Plans" data-ph-capture-attribute-section="pricing_plans">
	<div class="flex flex-col items-center text-center">
		<fieldset class="inline-flex rounded-full border border-border/70 bg-surface p-1">
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
						class="block rounded-full px-5 py-2 text-sm font-medium text-muted-foreground transition-colors peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50"
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
				<p class="w-full text-muted-foreground">
					Your payment is not confirmed yet. If you are stuck, email
					<a class={linkClass} href={SUPPORT_HREF}>{SUPPORT_EMAIL}</a>.
				</p>
				{#if pending.checkoutUrl}
					<button type="button" class={linkClass} disabled={!!busy} onclick={continueCheckout}>
						Continue checkout
					</button>
				{/if}
				<button type="button" class={linkClass} disabled={!!busy} onclick={checkPaymentStatus}>
					Check payment status
				</button>
			</div>
		{/if}

		{#if user}
			<div
				class="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground"
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
					<button type="button" class={linkClass} disabled={!!busy} onclick={manageBilling}>
						Manage billing
					</button>
					<a class={linkClass} href={SUPPORT_HREF}>Billing support</a>
				{/if}
			</div>
		{/if}
	</div>

	{#if cards.length === 0}
		<p class="mt-12 text-center text-sm text-muted-foreground" role="status">
			Loading plan details…
		</p>
	{:else}
		<div class="mt-12 flex flex-wrap justify-center gap-6">
			{#each cards as card (card.id)}
				{@const price = card.prices[interval]}
				{@const yearly = interval === 'annual'}
				<article
					class={cn(
						'relative flex w-full min-w-0 flex-col rounded-2xl border border-border/70 bg-surface/90 p-6 sm:w-[calc((100%-1.5rem)/2)] sm:p-7 lg:w-[calc((100%-3rem)/3)] xl:w-[calc((100%-4.5rem)/4)]',
						card.highlighted && 'border-accent/40 ring-2 ring-accent/30'
					)}
				>
					{#if card.highlighted}
						<span
							class="absolute top-5 right-5 rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent-strong"
						>
							Most popular
						</span>
					{/if}
					<h2 class="font-brand text-xl font-semibold text-foreground">{card.name}</h2>
					<div class="mt-3 min-h-16">
						<p class="font-brand text-3xl font-semibold tracking-tight text-foreground">
							{(yearly ? card.annualPerMonth : price) ?? 'Unavailable'}
						</p>
						{#if price}
							<p class="mt-1 text-sm text-muted-foreground">
								per month{card.isFree
									? ', no credit card required'
									: yearly
										? `, billed ${price} yearly`
										: ''}
							</p>
						{/if}
					</div>
					{#if card.description}
						<p class="mt-3 min-h-11 text-sm leading-relaxed text-muted-foreground">
							{card.description}
						</p>
					{/if}
					{#if card.previousPlanName}
						<p class="mt-6 text-sm font-medium text-foreground">
							Everything in {card.previousPlanName}, plus:
						</p>
					{/if}
					<ul class={cn('flex-1 space-y-2.5', card.previousPlanName ? 'mt-2.5' : 'mt-6')}>
						{#each card.features as feature (feature.label)}
							<li class="flex gap-2.5 text-sm leading-snug text-foreground">
								<span
									class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-action-soft text-xs"
									aria-hidden="true">✓</span
								>
								{#if feature.href}
									<a
										class="underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground"
										href={feature.href}
										target="_blank"
										rel="noopener">{feature.label}</a
									>
								{:else}
									<span>{feature.label}</span>
								{/if}
							</li>
						{/each}
					</ul>
					<button
						type="button"
						class={cn(
							'mt-8 inline-flex min-h-11 w-full items-center justify-center rounded-full px-5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
							card.primaryCta
								? 'bg-foreground text-background hover:bg-foreground/90'
								: 'border border-border bg-surface text-foreground hover:bg-action-soft'
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
