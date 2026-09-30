import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAction, useConvexAuth } from 'convex/react';
import type { Infer } from 'convex/values';
import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import type { vMandateFrequency, vMandateScope } from '@convex/lib/validators';
import type { MandateApproval } from '$lib/chat/mandate';
import MandateApprovalForm from '$lib/components/home/mandate-approval-form';
import Button from '$lib/components/ui/button/button';
import { convexClientErrorMessage } from '$lib/convex-error';

type MandateFrequency = Infer<typeof vMandateFrequency>;
type MandateScope = Infer<typeof vMandateScope>;
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

function friendlyError(error: Error, fallback: string): string {
	return convexClientErrorMessage(error) || fallback;
}

function catchMessage<T>(error: T, fallback: string): string {
	return error instanceof Error ? friendlyError(error, fallback) : fallback;
}

const fieldClass =
	'border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-9 w-full rounded-lg border px-3 text-[13px] outline-none';
const labelClass = 'text-muted-foreground text-[12px]';
const actionLinkClass =
	'text-muted-foreground hover:text-foreground text-[12px] transition disabled:pointer-events-none disabled:opacity-40';
const lifecycleLabels = {
	pause: { idle: 'Pause', busy: 'Pausing…' },
	resume: { idle: 'Resume', busy: 'Resuming…' },
	cancel: { idle: 'Cancel', busy: 'Cancelling…' }
} as const satisfies Record<LifecycleAction, { idle: string; busy: string }>;

const mandateFrequencyOptions = [
	{ value: 'one_time', label: 'One time' },
	{ value: 'weekly', label: 'Weekly' },
	{ value: 'monthly', label: 'Monthly' },
	{ value: 'yearly', label: 'Yearly' }
] as const satisfies readonly { value: MandateFrequency; label: string }[];

const mandateScopeOptions = [
	{ value: 'listed', label: 'Listed merchant' },
	{ value: 'any', label: 'Any merchant' }
] as const satisfies readonly { value: MandateScope; label: string }[];

function parseSelectValue<Value extends string>(
	options: readonly { value: Value }[],
	raw: string
): Value | null {
	return options.find((option) => option.value === raw)?.value ?? null;
}

export default function SettingsPayments() {
	const convexAuth = useConvexAuth();
	const listMyMandates = useAction(api.payments.listMyMandates);
	const setupMyMandate = useAction(api.payments.setupMyMandate);
	const setMyMandateLifecycle = useAction(api.payments.setMyMandateLifecycle);
	const [merchantName, setMerchantName] = useState('');
	const [merchantUrl, setMerchantUrl] = useState('');
	const [countryCode, setCountryCode] = useState('US');
	const [amountCap, setAmountCap] = useState('');
	const [currency, setCurrency] = useState('USD');
	const [frequency, setFrequency] = useState<MandateFrequency>('monthly');
	const [scope, setScope] = useState<MandateScope>('listed');
	const [description, setDescription] = useState('');
	const [setupSubmitting, setSetupSubmitting] = useState(false);
	const [setupError, setSetupError] = useState<string | null>(null);
	const [pendingApproval, setPendingApprovalState] = useState<MandateApproval | null>(null);
	const [mandates, setMandates] = useState<MandateRow[]>([]);
	const [mandatesLoading, setMandatesLoading] = useState(false);
	const [mandatesError, setMandatesError] = useState<string | null>(null);
	const [lifecycleBusyId, setLifecycleBusyId] = useState<string | null>(null);
	const [lifecycleBusyAction, setLifecycleBusyAction] = useState<LifecycleAction | null>(null);
	const pendingApprovalRef = useRef<MandateApproval | null>(null);

	const setPendingApproval = (next: MandateApproval | null) => {
		pendingApprovalRef.current = next;
		setPendingApprovalState(next);
	};

	// Prava rejects recurring any-merchant mandates; keep the form from
	// offering an invalid combination.
	useEffect(() => {
		if (scope === 'any' && frequency !== 'one_time') {
			setFrequency('one_time');
		}
	}, [scope, frequency]);

	const refreshMandates = useCallback(async () => {
		setMandatesLoading(true);
		setMandatesError(null);
		try {
			const result = await listMyMandates({});
			setMandates(result.mandates);
			const pendingId = pendingApprovalRef.current?.mandateId;
			if (
				pendingId &&
				result.mandates.some(
					(mandate) =>
						mandate.mandateId === pendingId &&
						(mandate.status === 'active' || mandate.status === 'paused')
				)
			) {
				pendingApprovalRef.current = null;
				setPendingApprovalState(null);
			}
		} catch (error) {
			setMandatesError(catchMessage(error, 'Couldn’t load mandates.'));
		} finally {
			setMandatesLoading(false);
		}
	}, [listMyMandates]);

	useEffect(() => {
		if (!convexAuth.isAuthenticated || convexAuth.isLoading) {
			return;
		}
		void refreshMandates();
	}, [convexAuth.isAuthenticated, convexAuth.isLoading, refreshMandates]);

	// After the user finishes Prava approval in another tab, refresh when they
	// return so Pause/Cancel appear without a full page reload.
	useEffect(() => {
		if (!pendingApproval || !convexAuth.isAuthenticated) {
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
	}, [pendingApproval, convexAuth.isAuthenticated, refreshMandates]);

	async function submitMandateSetup(event: FormEvent) {
		event.preventDefault();
		setSetupSubmitting(true);
		setSetupError(null);
		setPendingApproval(null);
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
				description: description.trim()
			});
			setPendingApproval({
				mandateId: result.mandateId,
				approvalUrl: result.approvalUrl,
				label: description.trim()
			});
			await refreshMandates();
		} catch (error) {
			setSetupError(catchMessage(error, 'Couldn’t set up mandate.'));
		} finally {
			setSetupSubmitting(false);
		}
	}

	async function runLifecycle(mandate: MandateRow, action: LifecycleAction) {
		if (!mandate.mandateId || lifecycleBusyId !== null) return;
		setLifecycleBusyId(mandate.pravaMandateId);
		setLifecycleBusyAction(action);
		setMandatesError(null);
		try {
			await setMyMandateLifecycle({
				mandateId: mandate.mandateId,
				action
			});
			await refreshMandates();
		} catch (error) {
			setMandatesError(catchMessage(error, `Couldn’t ${action} mandate.`));
		} finally {
			setLifecycleBusyId(null);
			setLifecycleBusyAction(null);
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
						<p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
							Set up a spending mandate
						</p>
						<p className="text-muted-foreground mt-2 text-sm leading-6">
							Create a Prava mandate, then approve it in a new tab with your passkey.
						</p>
						<form className="mt-4 space-y-3" onSubmit={(event) => void submitMandateSetup(event)}>
							<div className="grid gap-3 sm:grid-cols-2">
								<label className="block space-y-1.5">
									<span className={labelClass}>Merchant name</span>
									<input
										className={fieldClass}
										value={merchantName}
										onChange={(event) => setMerchantName(event.currentTarget.value)}
										placeholder="Example Shop"
										disabled={setupSubmitting || scope === 'any'}
									/>
								</label>
								<label className="block space-y-1.5">
									<span className={labelClass}>Merchant URL</span>
									<input
										className={fieldClass}
										value={merchantUrl}
										onChange={(event) => setMerchantUrl(event.currentTarget.value)}
										placeholder="https://example.com"
										disabled={setupSubmitting || scope === 'any'}
									/>
								</label>
								<label className="block space-y-1.5">
									<span className={labelClass}>Country code</span>
									<input
										className={fieldClass}
										value={countryCode}
										onChange={(event) => setCountryCode(event.currentTarget.value)}
										placeholder="US"
										disabled={setupSubmitting || scope === 'any'}
									/>
								</label>
								<label className="block space-y-1.5">
									<span className={labelClass}>Amount cap</span>
									<input
										className={fieldClass}
										value={amountCap}
										onChange={(event) => setAmountCap(event.currentTarget.value)}
										placeholder="120.00"
										required
										disabled={setupSubmitting}
									/>
								</label>
								<label className="block space-y-1.5">
									<span className={labelClass}>Currency</span>
									<input
										className={fieldClass}
										value={currency}
										onChange={(event) => setCurrency(event.currentTarget.value)}
										placeholder="USD"
										required
										disabled={setupSubmitting}
									/>
								</label>
								<label className="block space-y-1.5">
									<span className={labelClass}>Frequency</span>
									<select
										className={fieldClass}
										value={frequency}
										onChange={(event) => {
											const next = parseSelectValue(
												mandateFrequencyOptions,
												event.currentTarget.value
											);
											if (next) setFrequency(next);
										}}
										disabled={setupSubmitting || scope === 'any'}
									>
										{mandateFrequencyOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</label>
								<label className="block space-y-1.5 sm:col-span-2">
									<span className={labelClass}>Scope</span>
									<select
										className={fieldClass}
										value={scope}
										onChange={(event) => {
											const next = parseSelectValue(mandateScopeOptions, event.currentTarget.value);
											if (next) setScope(next);
										}}
										disabled={setupSubmitting}
									>
										{mandateScopeOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</label>
								<label className="block space-y-1.5 sm:col-span-2">
									<span className={labelClass}>Description</span>
									<input
										className={fieldClass}
										value={description}
										onChange={(event) => setDescription(event.currentTarget.value)}
										placeholder="Agent shopping budget"
										required
										disabled={setupSubmitting}
									/>
								</label>
							</div>
							{setupError && <p className="text-destructive text-sm">{setupError}</p>}
							<Button type="submit" variant="outline" disabled={setupSubmitting}>
								{setupSubmitting ? 'Setting up…' : 'Set up mandate'}
							</Button>
						</form>
						{pendingApproval && (
							<div className="mt-4">
								<MandateApprovalForm approval={pendingApproval} />
							</div>
						)}
					</div>

					<div>
						<p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
							Your mandates
						</p>
						{mandatesError && <p className="text-destructive mt-3 text-sm">{mandatesError}</p>}
						{mandatesLoading && mandates.length === 0 ? (
							<div className="mt-4 animate-pulse space-y-4" aria-hidden="true">
								{[0, 1].map((row) => (
									<div key={row} className="space-y-2">
										<div className="bg-hover-fill h-3.5 w-40 rounded"></div>
										<div className="bg-hover-fill h-3 w-56 rounded"></div>
									</div>
								))}
							</div>
						) : mandates.length === 0 ? (
							<p className="text-muted-foreground mt-3 text-sm leading-6">No mandates yet.</p>
						) : (
							<ul className="mt-3 space-y-1">
								{mandates.map((mandate) => {
									const busy = lifecycleBusyId === mandate.pravaMandateId;
									const busyAction = busy ? lifecycleBusyAction : null;
									const canPause = Boolean(mandate.mandateId) && mandate.status === 'active';
									const canResume = Boolean(mandate.mandateId) && mandate.status === 'paused';
									const rowActions: readonly LifecycleAction[] = [
										canPause ? 'pause' : 'resume',
										'cancel'
									];
									return (
										<li key={mandate.pravaMandateId} className="py-2">
											<div className="flex items-baseline justify-between gap-3">
												<p className="text-foreground truncate text-[14px]">
													{mandate.description?.trim() ||
														mandate.merchantName?.trim() ||
														'Spending mandate'}
												</p>
												<p className="text-muted-foreground shrink-0 text-[12px] capitalize">
													{mandate.status}
												</p>
											</div>
											<p className="text-muted-foreground mt-0.5 text-[12px]">
												{mandate.approvedAmount} {mandate.currency}
												{mandate.remaining !== undefined && <> · {mandate.remaining} remaining</>}
												{mandate.validUntil && <> · until {mandate.validUntil}</>}
												{mandate.renewsAt && <> · renews {mandate.renewsAt}</>}
											</p>
											{(canPause || canResume) && (
												<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
													{rowActions.map((action) => (
														<button
															key={action}
															type="button"
															className={actionLinkClass}
															disabled={lifecycleBusyId !== null}
															onClick={() => void runLifecycle(mandate, action)}
														>
															{busyAction === action
																? lifecycleLabels[action].busy
																: lifecycleLabels[action].idle}
														</button>
													))}
												</div>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</div>
				</div>
			</div>
		</section>
	);
}
