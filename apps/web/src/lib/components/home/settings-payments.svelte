<script lang="ts">
	import { page } from '$app/state';
	import { useAction, useAuth, useMutation, useQuery } from 'convex-svelte';
	import type { Id } from '$convex/_generated/dataModel';
	import { api } from '$convex/_generated/api';
	import type { MandateApproval } from '$lib/chat/mandate';
	import MandateApprovalCard from '$lib/components/home/mandate-approval-card.svelte';
	import Button from '$lib/components/ui/button/button.svelte';

	type MandateFrequency = 'one_time' | 'weekly' | 'monthly' | 'yearly';
	type MandateScope = 'listed' | 'any';
	type LifecycleAction = 'pause' | 'resume' | 'cancel';

	type MandateRow = {
		mandateId?: Id<'mandates'>;
		pravaMandateId: string;
		status: string;
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

	const publishableKey = $derived(page.data.env?.PUBLIC_PRAVA_PUBLISHABLE_KEY);

	const fieldClass =
		'border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-9 w-full rounded-lg border px-3 text-[13px] outline-none';
	const labelClass = 'text-muted-foreground text-[12px]';
	const actionButtonClass =
		'text-foreground hover:bg-muted inline-flex items-center rounded-md border px-2.5 py-1 text-xs transition disabled:pointer-events-none disabled:opacity-40';

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

	async function refreshMandates() {
		mandatesLoading = true;
		mandatesError = null;
		try {
			const result = await listMyMandates({});
			mandates = result.mandates;
		} catch (error) {
			mandatesError = error instanceof Error ? error.message : 'Couldn’t load mandates.';
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
			emailError = error instanceof Error ? error.message : 'Couldn’t save email.';
		} finally {
			emailSaving = false;
		}
	}

	async function submitMandateSetup(event: Event) {
		event.preventDefault();
		setupSubmitting = true;
		setupError = null;
		pendingApproval = null;
		try {
			const result = await setupMyMandate({
				merchantName: merchantName.trim() || undefined,
				merchantUrl: merchantUrl.trim() || undefined,
				countryCode: countryCode.trim() || undefined,
				amountCap: amountCap.trim(),
				currency: currency.trim(),
				frequency,
				scope,
				description: description.trim(),
				userEmail: paymentsEmail.trim() || undefined
			});
			pendingApproval = {
				mandateId: result.mandateId,
				approvalUrl: result.approvalUrl,
				sessionToken: result.sessionToken,
				expiresAt: result.expiresAt
			};
			await refreshMandates();
		} catch (error) {
			setupError = error instanceof Error ? error.message : 'Couldn’t set up mandate.';
		} finally {
			setupSubmitting = false;
		}
	}

	async function runLifecycle(mandate: MandateRow, action: LifecycleAction) {
		if (!mandate.mandateId) return;
		lifecycleBusyId = mandate.pravaMandateId;
		mandatesError = null;
		try {
			await setMyMandateLifecycle({
				mandateId: mandate.mandateId,
				action
			});
			await refreshMandates();
		} catch (error) {
			mandatesError = error instanceof Error ? error.message : `Couldn’t ${action} mandate.`;
		} finally {
			lifecycleBusyId = null;
		}
	}

	function statusChipClass(status: string) {
		return status === 'active'
			? 'text-foreground border-border'
			: 'text-muted-foreground border-border';
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
					Create a Prava mandate, then approve it inline with your passkey.
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
							<select class={fieldClass} bind:value={frequency} disabled={setupSubmitting}>
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
						<MandateApprovalCard
							approval={pendingApproval}
							{publishableKey}
							merchant={merchantName.trim() || (scope === 'any' ? 'Any merchant' : undefined)}
						/>
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
					<div class="mt-4 animate-pulse space-y-3" aria-hidden="true">
						{#each [0, 1] as row (row)}
							<div class="bg-hover-fill h-14 w-full rounded-lg"></div>
						{/each}
					</div>
				{:else if mandates.length === 0}
					<p class="text-muted-foreground mt-3 text-sm leading-6">No mandates yet.</p>
				{:else}
					<ul class="mt-4 space-y-2">
						{#each mandates as mandate (mandate.pravaMandateId)}
							{@const busy = lifecycleBusyId === mandate.pravaMandateId}
							<li class="bg-card rounded-lg border px-3.5 py-3">
								<div class="flex flex-wrap items-start justify-between gap-3">
									<div class="min-w-0 space-y-1">
										<p class="text-foreground truncate text-[14px]">
											{mandate.merchantName?.trim() || 'Any merchant'}
										</p>
										<p class="text-muted-foreground text-[12px]">
											{mandate.approvedAmount}
											{mandate.currency}
											{#if mandate.remaining !== undefined}
												· {mandate.remaining} remaining
											{/if}
										</p>
										{#if mandate.validUntil || mandate.renewsAt}
											<p class="text-muted-foreground text-[12px]">
												{#if mandate.validUntil}
													Valid until {mandate.validUntil}
												{/if}
												{#if mandate.validUntil && mandate.renewsAt}
													·
												{/if}
												{#if mandate.renewsAt}
													Renews {mandate.renewsAt}
												{/if}
											</p>
										{/if}
									</div>
									<span
										class={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] capitalize ${statusChipClass(mandate.status)}`}
									>
										{mandate.status}
									</span>
								</div>
								<div class="mt-3 flex flex-wrap gap-2">
									<button
										type="button"
										class={actionButtonClass}
										disabled={busy || !mandate.mandateId || mandate.status !== 'active'}
										onclick={() => void runLifecycle(mandate, 'pause')}
									>
										Pause
									</button>
									<button
										type="button"
										class={actionButtonClass}
										disabled={busy || !mandate.mandateId || mandate.status !== 'paused'}
										onclick={() => void runLifecycle(mandate, 'resume')}
									>
										Resume
									</button>
									<button
										type="button"
										class={actionButtonClass}
										disabled={busy ||
											!mandate.mandateId ||
											(mandate.status !== 'active' && mandate.status !== 'paused')}
										onclick={() => void runLifecycle(mandate, 'cancel')}
									>
										Cancel
									</button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
</section>
