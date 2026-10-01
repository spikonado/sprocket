import { useCallback, useEffect, type ReactNode } from 'react';
import { ConvexProviderWithAuth, type ConvexReactClient } from 'convex/react';
import {
	convexAuthLoading,
	convexAuthUserId,
	convexAuthRetryVersion,
	getConvexAccessToken,
	initializeAuth
} from '$lib/auth';
import { useStore } from '$lib/store';

export function useSprocketAuth() {
	const isLoading = useStore(convexAuthLoading);
	const userId = useStore(convexAuthUserId);
	const retryVersion = useStore(convexAuthRetryVersion);

	const fetchAccessToken = useCallback(
		(options: { forceRefreshToken: boolean }) => {
			// A new fetcher makes Convex retry authentication after recovery without remounting the UI.
			void retryVersion;
			void userId;

			return getConvexAccessToken(options);
		},
		[retryVersion, userId]
	);

	return { isLoading, isAuthenticated: Boolean(userId), fetchAccessToken };
}

export default function AuthProvider({
	client,
	machine,
	children
}: {
	client: ConvexReactClient;
	machine: boolean;
	children: ReactNode;
}) {
	useEffect(() => {
		void initializeAuth(client, { machine });
	}, [client, machine]);

	return (
		<ConvexProviderWithAuth client={client} useAuth={useSprocketAuth}>
			{children}
		</ConvexProviderWithAuth>
	);
}
