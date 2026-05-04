import type { DesktopApi } from '$lib/types/sprocket';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface Platform {}
	}

	interface Window {
		sprocketDesktop?: DesktopApi;
	}
}

export {};
