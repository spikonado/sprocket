import { useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAction } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { z } from 'zod';
import { api } from '@convex/_generated/api';
import Button from '$lib/components/ui/button/button';
import ProviderLogo from '$lib/components/provider-logo';
import { completionProviderLabels } from '$lib/chat/providers';
import { convexClientErrorMessage } from '$lib/convex-error';

export type ApiKeyProvider = FunctionArgs<typeof api.providerCredentials.saveApiKey>['provider'];

type ProviderConfiguration = FunctionReturnType<typeof api.providerCredentials.getMyConfiguration>;

export function providerConfigKey(
	provider: ApiKeyProvider | 'claude'
): keyof ProviderConfiguration {
	return provider === 'opencode-go' ? 'opencodeGo' : provider;
}

const keyPlaceholders: Record<ApiKeyProvider, string> = {
	openai: 'sk-…',
	anthropic: 'sk-ant-…',
	vercel: 'vck_…',
	openrouter: 'sk-or-…',
	opencode: 'oc_sk_…',
	'opencode-go': 'oc_sk_…',
	morph: 'sk-…'
};

const caughtError = z.instanceof(Error).catch(new Error());

export default function ApiKeyCard({
	provider,
	configured,
	loading,
	onConfiguredChange
}: {
	provider: ApiKeyProvider;
	configured: boolean;
	loading: boolean;
	onConfiguredChange: (configured: boolean) => void;
}) {
	const saveApiKey = useAction(api.providerCredentials.saveApiKey);
	const removeApiKey = useAction(api.providerCredentials.removeApiKey);
	const [apiKey, setApiKey] = useState('');
	const [showKey, setShowKey] = useState(false);
	const [pending, setPending] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const title = completionProviderLabels[provider];

	async function saveKey(event: FormEvent) {
		event.preventDefault();

		if (!apiKey.trim() || pending) return;
		setPending(true);
		setError(null);
		setSaved(false);

		try {
			await saveApiKey({ provider, apiKey });
			setApiKey('');
			setShowKey(false);
			setSaved(true);
			onConfiguredChange(true);
		} catch (caught) {
			setError(
				convexClientErrorMessage(caughtError.parse(caught)) ?? `Couldn’t save the ${title} key.`
			);
		} finally {
			setPending(false);
		}
	}

	async function removeKey() {
		if (pending) return;
		setPending(true);
		setError(null);
		setSaved(false);

		try {
			await removeApiKey({ provider });
			setConfirmRemove(false);
			onConfiguredChange(false);
		} catch (caught) {
			setError(
				convexClientErrorMessage(caughtError.parse(caught)) ?? `Couldn’t remove the ${title} key.`
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<section className="border-border rounded-xl border p-5" aria-label={title}>
			<div className="flex items-center gap-3">
				<ProviderLogo provider={provider} className="size-5" />
				<div className="min-w-0 flex-1">
					<p className="text-foreground text-[15px]">{title}</p>
					<p className="text-muted-foreground mt-0.5 text-[12px]">
						{loading ? 'Checking configuration…' : configured ? 'Connected' : 'Not configured'}
					</p>
				</div>
			</div>

			<form className="mt-5 space-y-3" onSubmit={(event) => void saveKey(event)}>
				<label className="block space-y-1.5">
					<span className="text-muted-foreground text-[12px]">API key</span>
					<div className="relative">
						<input
							type={showKey ? 'text' : 'password'}
							value={apiKey}
							onChange={(event) => setApiKey(event.currentTarget.value)}
							autoComplete="off"
							spellCheck={false}
							placeholder={configured ? 'Enter a replacement key' : keyPlaceholders[provider]}
							disabled={pending || loading}
							className="border-border bg-hover-fill text-foreground placeholder:text-muted-foreground focus:border-ring h-10 w-full rounded-lg border pr-10 pl-3 font-mono text-[13px] outline-none disabled:opacity-50"
						/>
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
							aria-label={showKey ? 'Hide API key' : 'Show API key'}
							disabled={pending || loading}
							onClick={() => setShowKey((visible) => !visible)}
						>
							{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
						</button>
					</div>
				</label>

				<div className="flex flex-wrap items-center gap-3">
					<Button type="submit" disabled={pending || loading || !apiKey.trim()}>
						{pending ? 'Saving…' : configured ? 'Replace key' : 'Connect API key'}
					</Button>
					{configured && !confirmRemove ? (
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onclick={() => setConfirmRemove(true)}
						>
							Remove
						</Button>
					) : confirmRemove ? (
						<>
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onclick={() => void removeKey()}
							>
								{pending ? 'Removing…' : 'Confirm removal'}
							</Button>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground text-[13px]"
								disabled={pending}
								onClick={() => setConfirmRemove(false)}
							>
								Cancel
							</button>
						</>
					) : null}
					{saved && <span className="text-muted-foreground text-[12px]">Saved</span>}
				</div>
			</form>

			{error && (
				<p className="text-destructive mt-4 text-sm" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
