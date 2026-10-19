declare global {
	interface Window {
		sprocketDesktopBridge?: {
			updates: import('$lib/updates').DesktopUpdates;
			takeWorkspaceLaunch: () => Promise<string | null>;
			onWorkspaceLaunch: (callback: () => void) => () => void;
			openExternal: (url: string) => Promise<void>;
			focusWindow: () => Promise<boolean>;
			setUnsavedChanges: (value: boolean) => Promise<void>;
		};
	}
}

export {};
