import type { DefaultFunctionArgs, FunctionVisibility } from 'convex/server';
import type { RegisteredAction, RegisteredMutation, RegisteredQuery } from 'convex/server';
import { getClientConfig } from '../convex/authBootstrap';
import {
	checkout,
	customerPortal,
	ensureMySubscription,
	getCheckoutStatus,
	getMySubscription
} from '../convex/billing';
import { getPublicCatalog } from '../convex/pricing';

type AnyRegisteredFunction =
	| RegisteredQuery<FunctionVisibility, DefaultFunctionArgs, unknown>
	| RegisteredMutation<FunctionVisibility, DefaultFunctionArgs, unknown>
	| RegisteredAction<FunctionVisibility, DefaultFunctionArgs, unknown>;

function kindOf(fn: AnyRegisteredFunction): 'query' | 'mutation' | 'action' {
	if ('isQuery' in fn && fn.isQuery) return 'query';

	if ('isMutation' in fn && fn.isMutation) return 'mutation';

	return 'action';
}

function contract(fn: AnyRegisteredFunction) {
	if ('isInternal' in fn) {
		throw new Error('Billing contract must contain registered public Convex functions.');
	}

	return {
		kind: kindOf(fn),
		// SAFETY: exportArgs/exportReturns are attached at registration; their
		// output is serialized validator JSON.
		args: JSON.parse(fn.exportArgs()) as unknown,
		// SAFETY: same registration guarantee as args above.
		returns: JSON.parse(fn.exportReturns()) as unknown
	};
}

console.log(
	JSON.stringify(
		{
			version: 1,
			functions: {
				'authBootstrap:getClientConfig': contract(getClientConfig),
				'billing:getMySubscription': contract(getMySubscription),
				'billing:ensureMySubscription': contract(ensureMySubscription),
				'billing:checkout': contract(checkout),
				'billing:customerPortal': contract(customerPortal),
				'billing:getCheckoutStatus': contract(getCheckoutStatus),
				'pricing:getPublicCatalog': contract(getPublicCatalog)
			}
		},
		null,
		2
	)
);
