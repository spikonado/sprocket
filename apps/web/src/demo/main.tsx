import { createRoot } from 'react-dom/client';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider, fixtureId } from '$lib/convex-test-client';
import { applyTheme, DEFAULT_THEME, isSprocketTheme } from '$lib/theme';
import { installTouchLongPress } from '$lib/touch-long-press';
import type { UpdateState } from '$lib/updates';
import DemoApp from './demo-app';
import { DemoState } from './demo-state';
import { DOWNLOAD_URL } from './fixtures/preview-reply';
import { DEFAULT_THREAD_ID, projects } from './fixtures/projects';
import '../app.css';

const container = document.getElementById('root');

if (!container) throw new Error('Missing application root.');

const params = new URLSearchParams(window.location.search);
const themeParam = params.get('theme');
const theme = isSprocketTheme(themeParam) ? themeParam : DEFAULT_THEME;
const state = new DemoState(projects);

void state.loadCatalog();

const threadParam = params.get('thread');

const initialThreadId = fixtureId<'threadRecords'>(
	threadParam && state.record(threadParam) ? threadParam : DEFAULT_THREAD_ID
);

const noUpdate = async (): Promise<UpdateState> => ({
	method: 'desktop',
	status: 'idle',
	currentVersion: 'preview',
	version: null,
	error: null
});

// The update button reads this bridge instead of watching `/api/events`.
window.sprocketDesktopBridge = {
	updates: { getState: noUpdate, download: noUpdate, install: noUpdate, onState: () => () => {} },
	takeWorkspaceLaunch: async () => null,
	onWorkspaceLaunch: () => () => {},
	openExternal: async (url) => {
		window.open(url, '_blank', 'noopener');
	},
	focusWindow: async () => true,
	setUnsavedChanges: async () => {}
};

const siteOrigin = new URL(DOWNLOAD_URL).origin;

// The preview runs in the site's iframe, so links back to the site replace the whole page.
document.addEventListener(
	'click',
	(event) => {
		const link = event.target instanceof Element ? event.target.closest('a') : null;

		if (link && new URL(link.href, window.location.href).origin === siteOrigin)
			link.target = '_top';
	},
	true
);

const client = new ConvexTestClient();

client.registerQuery(api.uiPreferences.getMine, null);

function serveUsage() {
	client.handleQuery(api.aiUsage.getRunUsage, ({ runId }) => state.runUsage(runId));
	client.handleQuery(api.aiUsage.getThreadUsage, ({ threadId }) => state.threadUsage(threadId));
}

serveUsage();

state.subscribe(serveUsage);

installTouchLongPress();

applyTheme(theme);

createRoot(container).render(
	<ConvexTestProvider client={client}>
		<DemoApp state={state} initialThreadId={initialThreadId} initialTheme={theme} />
	</ConvexTestProvider>
);
