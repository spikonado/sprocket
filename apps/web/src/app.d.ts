declare global {
	interface Window {
		sprocketDesktopBridge?: {
			getLocalBootstrap: () => Promise<{
				httpBaseUrl: string;
				desktopLoginCallbackUrl: string;
				pairingCredential: string;
			}>;
			takeWorkspaceLaunch: () => Promise<string | null>;
			onWorkspaceLaunch: (callback: () => void) => () => void;
			openExternal: (url: string) => Promise<void>;
			focusWindow: () => Promise<boolean>;
		};
	}
}

export {};
