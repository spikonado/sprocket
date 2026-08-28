import { v, type Infer } from 'convex/values';
import { fetchGatewayCatalog } from '@convex/lib/gatewayFetch';
import { toGatewayUiCatalog, vGatewayUiCatalog } from '@convex/lib/gatewayCatalog';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { action, query } from './_generated/server';

/**
 * Live catalog from the AI gateway.
 * Unauthenticated: the catalog is not secret. Entitlements stay server-side.
 */
export const fetch = action({
	args: {},
	returns: vGatewayUiCatalog,
	handler: async (): Promise<Infer<typeof vGatewayUiCatalog>> => {
		const catalog = await fetchGatewayCatalog();
		return toGatewayUiCatalog(catalog);
	}
});

/** Retired static catalog. Kept so older UIs get an update message. */
export const get = query({
	args: {},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
