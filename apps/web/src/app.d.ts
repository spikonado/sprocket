declare global {
	interface Window {
		sprocketDesktopBridge?: {
			getLocalBootstrap: () => Promise<{
				httpBaseUrl: string;
				desktopLoginCallbackUrl: string;
				pairingCredential: string;
			}>;
			openExternal: (url: string) => Promise<void>;
			focusWindow: () => Promise<boolean>;
		};
	}
}

export {};
