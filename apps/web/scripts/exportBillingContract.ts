import type { DefaultFunctionArgs, FunctionVisibility } from 'convex/server';
import type { RegisteredAction, RegisteredMutation, RegisteredQuery } from 'convex/server';
import { getClientConfig } from '../convex/authBootstrap';
import {
	buyCredits,
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

	const args: unknown = JSON.parse(fn.exportArgs());
	const returns: unknown = JSON.parse(fn.exportReturns());

	return { kind: kindOf(fn), args, returns };
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
				'billing:buyCredits': contract(buyCredits),
				'billing:customerPortal': contract(customerPortal),
				'billing:getCheckoutStatus': contract(getCheckoutStatus),
				'pricing:getPublicCatalog': contract(getPublicCatalog)
			}
		},
		null,
		2
	)
);
