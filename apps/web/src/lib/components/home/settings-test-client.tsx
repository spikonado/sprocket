import type { ReactNode } from 'react';
import { ConvexProviderWithAuth, ConvexReactClient, type AuthTokenFetcher } from 'convex/react';
import {
	getFunctionName,
	type FunctionReference,
	type FunctionReference_future,
	type FunctionArgs,
	type FunctionReturnType,
	type OptionalRestArgs
} from 'convex/server';

type ActionReference = FunctionReference<'action'> | FunctionReference_future<'action'>;
type ActionRunner = <Action extends ActionReference>(
	args: FunctionArgs<Action>
) => Promise<FunctionReturnType<Action>>;

export class SettingsTestClient extends ConvexReactClient {
	readonly #actions = new Map<string, ActionRunner>();

	constructor() {
		super('https://settings.invalid');
	}

	on<Action extends ActionReference>(
		action: Action,
		handler: (args: FunctionArgs<Action>) => Promise<FunctionReturnType<Action>>
	) {
		// SAFETY: dispatch uses the same function name and argument/result contract registered here.
		this.#actions.set(getFunctionName(action), handler as ActionRunner);
	}

	override action<Action extends ActionReference>(
		action: Action,
		...args: OptionalRestArgs<Action>
	): Promise<FunctionReturnType<Action>> {
		const name = getFunctionName(action);
		const handler = this.#actions.get(name);
		if (!handler) throw new Error(`Unexpected action: ${name}`);
		return handler<Action>(args[0] ?? {});
	}

	override setAuth(_fetchToken: AuthTokenFetcher, onChange?: (authenticated: boolean) => void) {
		onChange?.(true);
	}

	override clearAuth() {}
}

const fetchAccessToken = async () => 'test-token';
const useTestAuth = () => ({ isLoading: false, isAuthenticated: true, fetchAccessToken });

export function SettingsTestProvider({
	client,
	children
}: {
	client: SettingsTestClient;
	children: ReactNode;
}) {
	return (
		<ConvexProviderWithAuth client={client} useAuth={useTestAuth}>
			{children}
		</ConvexProviderWithAuth>
	);
}

export function deferred<Result>() {
	let resolve!: (result: Result) => void;
	const promise = new Promise<Result>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
