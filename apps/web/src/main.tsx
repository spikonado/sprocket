import { createRoot } from 'react-dom/client';
import { ConvexReactClient } from 'convex/react';
import { canonicalDevWebUrl } from '../../desktop/local-config.mjs';
import { loadRuntimeConfig } from '$lib/runtime-config';
import AuthProvider from './auth-provider';
import App from './app';
import Callback from './callback';
import CalmCentered from '$lib/components/home/calm-centered';
import './app.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing application root.');
const root = createRoot(container);

async function start() {
	if (import.meta.env.DEV) {
		const canonicalUrl = canonicalDevWebUrl(window.location.href);
		if (canonicalUrl) {
			window.location.replace(canonicalUrl);
			return;
		}
	}
	try {
		const config = await loadRuntimeConfig();
		const convexUrl = config.env.PUBLIC_CONVEX_URL;
		if (!convexUrl) throw new Error('Sprocket is missing its Convex configuration.');
		const client = new ConvexReactClient(convexUrl, { unsavedChangesWarning: false });
		root.render(
			<AuthProvider client={client} machine={config.machine}>
				{window.location.pathname === '/callback' ? <Callback /> : <App config={config} />}
			</AuthProvider>
		);
	} catch (error) {
		root.render(
			<CalmCentered
				title="Unable to connect"
				description={error instanceof Error ? error.message : 'Failed to start Sprocket.'}
			/>
		);
	}
}

void start();
