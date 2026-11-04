import { PostHog } from '@posthog/convex';
import { components } from '@convex/_generated/api';

export const posthog = new PostHog(components.posthog, {
	beforeSend: (event) => ({ ...event, properties: { ...event.properties, site: 'sprocket_app' } })
});

type CaptureProperties = NonNullable<Parameters<typeof posthog.capture>[1]['properties']>;

/** SHA-256 hex, matching the Rust agent's `analytics_id`, so traces and sessions line up. */
export async function analyticsId(id: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));

	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function captureAnonymous(
	ctx: Parameters<typeof posthog.capture>[0],
	args: { distinctId: string; event: string; properties: CaptureProperties }
): Promise<void> {
	await posthog.capture(ctx, {
		distinctId: args.distinctId,
		event: args.event,
		properties: { ...args.properties, $process_person_profile: false }
	});
}
