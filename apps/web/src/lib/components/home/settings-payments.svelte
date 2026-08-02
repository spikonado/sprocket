<script lang="ts">
	import { browser } from '$app/environment';
	import { useAction, useAuth, useMutation, useQuery } from 'convex-svelte';
	import type { Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
	import type { MandateApproval } from '$lib/chat/mandate';
	import MandateApprovalForm from '$lib/components/home/mandate-approval-form.svelte';
	import Button from '$lib/components/ui/button/button.svelte';

	type MandateFrequency = 'one_time' | 'weekly' | 'monthly' | 'yearly';
	type MandateScope = 'listed' | 'any';
	type LifecycleAction = 'pause' | 'resume' | 'cancel';

	type MandateRow = {
		mandateId?: Id<'mandates'>;
		pravaMandateId: string;
		status: string;
		description?: string;
		merchantName?: string;
		approvedAmount: string;
		remaining?: string;
		currency: string;
		validUntil?: string;
		renewsAt?: string;
	};

	const convexAuth = useAuth();
	const prefsQuery = useQuery(api.uiPreferences.getMine, () =>
		convexAuth.isAuthenticated && !convexAuth.isLoading ? {} : 'skip'
	);
	const setPaymentsEmail = useMutation(api.uiPreferences.setPaymentsEmail);
	const listMyMandates = useAction(api.payments.listMyMandates);
	const setupMyMandate = useAction(api.payments.setupMyMandate);
	const setMyMandateLifecycle = useAction(api.payments.setMyMandateLifecycle);

	/** Convex action errors arrive wrapped in request-id/stack noise; show just
	 * the meaningful message. */
	function friendlyError(error: unknown, fallback: string): string {
		if (!(error instanceof Error)) return fallback;
		const match = error.message.match(/Uncaught Error: ([^(\n]+)/);
		return (match?.[1] ?? error.message).trim() || fallback;
	}

	const fieldClass =
		'border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-9 w-full rounded-lg border px-3 text-[13px] outline-none';
	const labelClass = 'text-muted-foreground text-[12px]';
	const actionLinkClass =
		'text-muted-foreground hover:text-foreground text-[12px] transition disabled:pointer-events-none disabled:opacity-40';

	let paymentsEmail = $state('');
	let emailHydrated = $state(false);
	let emailSaving = $state(false);
	let emailSaved = $state(false);
	let emailError = $state<string | null>(null);

	let merchantName = $state('');
	let merchantUrl = $state('');
	let countryCode = $state('US');
	let amountCap = $state('');
	let currency = $state('USD');
	let frequency = $state<MandateFrequency>('monthly');
	let scope = $state<MandateScope>('listed');
	let description = $state('');
	let setupSubmitting = $state(false);
	let setupError = $state<string | null>(null);
	let pendingApproval = $state<MandateApproval | null>(null);

	let mandates = $state<MandateRow[]>([]);
	let mandatesLoading = $state(false);
	let mandatesError = $state<string | null>(null);
	let lifecycleBusyId = $state<string | null>(null);
	let lifecycleBusyAction = $state<LifecycleAction | null>(null);

	const lifecycleLabels: Record<LifecycleAction, { idle: string; busy: string }> = {
		pause: { idle: 'Pause', busy: 'Pausing…' },
		resume: { idle: 'Resume', busy: 'Resuming…' },
		cancel: { idle: 'Cancel', busy: 'Cancelling…' }
	};

	// Prava rejects recurring any-merchant mandates; keep the form from
	// offering an invalid combination.
	$effect(() => {
		if (scope === 'any' && frequency !== 'one_time') {
			frequency = 'one_time';
		}
	});

	$effect(() => {
		const data = prefsQuery.data;
		if (data === undefined || emailHydrated) {
			return;
		}
		paymentsEmail = data?.paymentsEmail ?? '';
		emailHydrated = true;
	});

	$effect(() => {
		if (!convexAuth.isAuthenticated || convexAuth.isLoading) {
			return;
		}
		void refreshMandates();
	});

	// After the user finishes Prava approval in another tab, refresh when they
	// return so Pause/Cancel appear without a full page reload.
	$effect(() => {
		if (!browser || !pendingApproval || !convexAuth.isAuthenticated) {
			return;
		}
		const onReturn = () => {
			if (document.visibilityState && document.visibilityState !== 'visible') {
				return;
			}
			void refreshMandates();
		};
		window.addEventListener('focus', onReturn);
		document.addEventListener('visibilitychange', onReturn);
		return () => {
			window.removeEventListener('focus', onReturn);
			document.removeEventListener('visibilitychange', onReturn);
		};
	});

	async function refreshMandates() {
		mandatesLoading = true;
		mandatesError = null;
		try {
			const result = await listMyMandates({});
			mandates = result.mandates;
			const pendingId = pendingApproval?.mandateId;
			if (
				pendingId &&
				mandates.some(
					(mandate) =>
						mandate.mandateId === pendingId &&
						(mandate.status === 'active' || mandate.status === 'paused')
				)
			) {
				pendingApproval = null;
			}
		} catch (error) {
			mandatesError = friendlyError(error, 'Couldn’t load mandates.');
		} finally {
			mandatesLoading = false;
		}
	}

	async function savePaymentsEmail() {
		emailSaving = true;
		emailError = null;
		emailSaved = false;
		try {
			await setPaymentsEmail({ email: paymentsEmail.trim() });
			emailSaved = true;
		} catch (error) {
			emailError = friendlyError(error, 'Couldn’t save email.');
		} finally {
			emailSaving = false;
		}
	}

	async function submitMandateSetup(event: Event) {
		event.preventDefault();
		if (!paymentsEmail.trim()) {
			setupError = 'Save your payments email above first — it’s required to set up a mandate.';
			return;
		}
		setupSubmitting = true;
		setupError = null;
		pendingApproval = null;
		// Merchant fields are disabled (and ignored by Prava) for any-merchant
		// mandates; don't submit leftover values that would mislabel the mandate.
		const listed = scope === 'listed';
		try {
			const result = await setupMyMandate({
				merchantName: listed ? merchantName.trim() || undefined : undefined,
				merchantUrl: listed ? merchantUrl.trim() || undefined : undefined,
				countryCode: listed ? countryCode.trim() || undefined : undefined,
				amountCap: amountCap.trim(),
				currency: currency.trim(),
				frequency,
				scope,
				description: description.trim(),
				userEmail: paymentsEmail.trim()
			});
			pendingApproval = {
				mandateId: result.mandateId,
				approvalUrl: result.approvalUrl,
				label: description.trim()
			};
			await refreshMandates();
		} catch (error) {
			setupError = friendlyError(error, 'Couldn’t set up mandate.');
		} finally {
			setupSubmitting = false;
		}
	}

	async function runLifecycle(mandate: MandateRow, action: LifecycleAction) {
		if (!mandate.mandateId || lifecycleBusyId !== null) return;
		lifecycleBusyId = mandate.pravaMandateId;
		lifecycleBusyAction = action;
		mandatesError = null;
		try {
			await setMyMandateLifecycle({
				mandateId: mandate.mandateId,
				action
			});
			await refreshMandates();
		} catch (error) {
			mandatesError = friendlyError(error, `Couldn’t ${action} mandate.`);
		} finally {
			lifecycleBusyId = null;
			lifecycleBusyAction = null;
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex h-12 shrink-0 items-center px-6">
		<h1 class="text-foreground text-[1rem] font-medium tracking-[-0.03em]">Payments</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="max-w-xl space-y-10">
			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Payments email
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Used when setting up spending mandates. Saved to your account preferences.
				</p>
				<form
					class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
					onsubmit={(event) => {
						event.preventDefault();
						void savePaymentsEmail();
					}}
				>
					<label class="block min-w-0 flex-1 space-y-1.5">
						<span class={labelClass}>Email</span>
						<input
							class={fieldClass}
							type="email"
							autocomplete="email"
							bind:value={paymentsEmail}
							placeholder="you@example.com"
							disabled={emailSaving || prefsQuery.isLoading}
							oninput={() => {
								emailSaved = false;
								emailError = null;
							}}
						/>
					</label>
					<Button type="submit" variant="outline" disabled={emailSaving || !paymentsEmail.trim()}>
						{emailSaving ? 'Saving…' : 'Save'}
					</Button>
				</form>
				{#if emailError}
					<p class="text-destructive mt-2 text-sm">{emailError}</p>
				{:else if emailSaved}
					<p class="text-muted-foreground mt-2 text-sm" role="status">Saved.</p>
				{/if}
			</div>

			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Set up a spending mandate
				</p>
				<p class="text-muted-foreground mt-2 text-sm leading-6">
					Create a Prava mandate, then approve it in a new tab with your passkey.
				</p>
				<form class="mt-4 space-y-3" onsubmit={submitMandateSetup}>
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="block space-y-1.5">
							<span class={labelClass}>Merchant name</span>
							<input
								class={fieldClass}
								bind:value={merchantName}
								placeholder="Example Shop"
								disabled={setupSubmitting || scope === 'any'}
							/>
						</label>
						<label class="block space-y-1.5">
							<span class={labelClass}>Merchant URL</span>
							<input
								class={fieldClass}
								bind:value={merchantUrl}
								placeholder="https://example.com"
								disabled={setupSubmitting || scope === 'any'}
							/>
						</label>
						<label class="block space-y-1.5">
							<span class={labelClass}>Country code</span>
							<input
								class={fieldClass}
								bind:value={countryCode}
								placeholder="US"
								disabled={setupSubmitting || scope === 'any'}
							/>
						</label>
						<label class="block space-y-1.5">
							<span class={labelClass}>Amount cap</span>
							<input
								class={fieldClass}
								bind:value={amountCap}
								placeholder="120.00"
								required
								disabled={setupSubmitting}
							/>
						</label>
						<label class="block space-y-1.5">
							<span class={labelClass}>Currency</span>
							<input
								class={fieldClass}
								bind:value={currency}
								placeholder="USD"
								required
								disabled={setupSubmitting}
							/>
						</label>
						<label class="block space-y-1.5">
							<span class={labelClass}>Frequency</span>
							<select
								class={fieldClass}
								bind:value={frequency}
								disabled={setupSubmitting || scope === 'any'}
							>
								<option value="one_time">One time</option>
								<option value="weekly">Weekly</option>
								<option value="monthly">Monthly</option>
								<option value="yearly">Yearly</option>
							</select>
						</label>
						<label class="block space-y-1.5 sm:col-span-2">
							<span class={labelClass}>Scope</span>
							<select class={fieldClass} bind:value={scope} disabled={setupSubmitting}>
								<option value="listed">Listed merchant</option>
								<option value="any">Any merchant</option>
							</select>
						</label>
						<label class="block space-y-1.5 sm:col-span-2">
							<span class={labelClass}>Description</span>
							<input
								class={fieldClass}
								bind:value={description}
								placeholder="Agent shopping budget"
								required
								disabled={setupSubmitting}
							/>
						</label>
					</div>
					{#if setupError}
						<p class="text-destructive text-sm">{setupError}</p>
					{/if}
					<Button type="submit" variant="outline" disabled={setupSubmitting}>
						{setupSubmitting ? 'Setting up…' : 'Set up mandate'}
					</Button>
				</form>
				{#if pendingApproval}
					<div class="mt-4">
						<MandateApprovalForm approval={pendingApproval} />
					</div>
				{/if}
			</div>

			<div>
				<p class="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
					Your mandates
				</p>
				{#if mandatesError}
					<p class="text-destructive mt-3 text-sm">{mandatesError}</p>
				{/if}
				{#if mandatesLoading && mandates.length === 0}
					<div class="mt-4 animate-pulse space-y-4" aria-hidden="true">
						{#each [0, 1] as row (row)}
							<div class="space-y-2">
								<div class="bg-hover-fill h-3.5 w-40 rounded"></div>
								<div class="bg-hover-fill h-3 w-56 rounded"></div>
							</div>
						{/each}
					</div>
				{:else if mandates.length === 0}
					<p class="text-muted-foreground mt-3 text-sm leading-6">No mandates yet.</p>
				{:else}
					<ul class="mt-3 space-y-1">
						{#each mandates as mandate (mandate.pravaMandateId)}
							{@const busy = lifecycleBusyId === mandate.pravaMandateId}
							{@const busyAction = busy ? lifecycleBusyAction : null}
							{@const canPause = Boolean(mandate.mandateId) && mandate.status === 'active'}
							{@const canResume = Boolean(mandate.mandateId) && mandate.status === 'paused'}
							<li class="py-2">
								<div class="flex items-baseline justify-between gap-3">
									<p class="text-foreground truncate text-[14px]">
										{mandate.description?.trim() ||
											mandate.merchantName?.trim() ||
											'Spending mandate'}
									</p>
									<p class="text-muted-foreground shrink-0 text-[12px] capitalize">
										{mandate.status}
									</p>
								</div>
								<p class="text-muted-foreground mt-0.5 text-[12px]">
									{mandate.approvedAmount}
									{mandate.currency}
									{#if mandate.remaining !== undefined}
										· {mandate.remaining} remaining
									{/if}
									{#if mandate.validUntil}
										· until {mandate.validUntil}
									{/if}
									{#if mandate.renewsAt}
										· renews {mandate.renewsAt}
									{/if}
								</p>
								{#if canPause || canResume}
									{@const rowActions = [canPause ? 'pause' : 'resume', 'cancel'] as const}
									<div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
										{#each rowActions as action (action)}
											<button
												type="button"
												class={actionLinkClass}
												disabled={lifecycleBusyId !== null}
												onclick={() => void runLifecycle(mandate, action)}
											>
												{busyAction === action
													? lifecycleLabels[action].busy
													: lifecycleLabels[action].idle}
											</button>
										{/each}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
</section>
