declare global {
	interface Window {
		sprocketDesktopBridge?: {
			getLocalBootstrap: () => Promise<{
				httpBaseUrl: string;
				pairingCredential: string;
			}>;
		};
	}
}

export {};
