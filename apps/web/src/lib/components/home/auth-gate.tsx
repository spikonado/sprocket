import { LoaderCircle } from 'lucide-react';
import Button from '$lib/components/ui/button/button';
import CalmCentered from './calm-centered';

type AuthGateState = {
	isLoading: boolean;
	isConfigured: boolean;
	isAuthenticated: boolean;
	connectionFailed: boolean;
	error: string | null;
};

export default function AuthGate({
	authState,
	overlayOpen = false,
	onSignIn,
	onSignOut,
	onRetry,
	retryLabel = 'Retry',
	onSignUp
}: {
	authState: AuthGateState;
	overlayOpen?: boolean;
	onSignIn: () => void;
	onSignOut: () => void;
	onRetry: () => void;
	retryLabel?: string;
	onSignUp: () => void;
}) {
	const showConfirming =
		authState.isAuthenticated && (authState.isLoading || !authState.connectionFailed);

	const showPreparing = !authState.isAuthenticated && authState.isLoading;

	const headline = !authState.isConfigured
		? 'Sign-in unavailable'
		: showConfirming
			? 'Confirming your session'
			: authState.connectionFailed
				? 'Couldn’t connect your account'
				: showPreparing
					? 'Preparing sign-in'
					: 'Sign in to continue';

	const description = !authState.isConfigured
		? 'Account sign-in is not configured on this deployment, so account actions are disabled.'
		: showConfirming
			? 'Verifying your secure connection before opening your projects.'
			: authState.connectionFailed
				? 'Your session could not be confirmed. Retry when the connection is available.'
				: showPreparing
					? 'Getting account sign-in ready. This usually takes a moment.'
					: 'Sign in to sync your coding threads, streaming responses, and projects.';

	return (
		<div inert={overlayOpen} aria-hidden={overlayOpen || undefined}>
			<CalmCentered
				title={headline}
				description={description}
				actions={
					<>
						{authState.connectionFailed && authState.isConfigured && (
							<Button onclick={onRetry} disabled={authState.isLoading}>
								{retryLabel}
							</Button>
						)}
						{authState.isAuthenticated ? (
							<Button variant="outline" onclick={onSignOut}>
								Sign Out
							</Button>
						) : (
							authState.isConfigured &&
							!authState.connectionFailed && (
								<>
									<Button onclick={onSignIn} disabled={authState.isLoading}>
										Sign In
									</Button>
									<Button variant="outline" onclick={onSignUp} disabled={authState.isLoading}>
										Create Account
									</Button>
								</>
							)
						)}
					</>
				}
			>
				{authState.isConfigured && authState.error && !overlayOpen && (
					<p className="text-destructive text-center text-sm" role="alert">
						{authState.error}
					</p>
				)}
				{authState.isLoading && (
					<div
						className="text-muted-foreground flex items-center justify-center gap-2 text-sm"
						aria-live="polite"
						aria-busy="true"
					>
						<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
						<span>{authState.isAuthenticated ? 'Almost there' : 'One moment'}</span>
					</div>
				)}
			</CalmCentered>
		</div>
	);
}
