import { PostHog } from '@posthog/convex';
import { components } from '@convex/_generated/api';

export const posthog = new PostHog(components.posthog, {
	beforeSend: (event) => ({ ...event, properties: { ...event.properties, site: 'sprocket_app' } })
});
