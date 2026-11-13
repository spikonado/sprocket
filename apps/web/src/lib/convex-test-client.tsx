import type { ReactNode } from 'react';
import type { Id, TableNames } from '@convex/_generated/dataModel';
import { convexId } from '$lib/convex-id';
import {
	ConvexProviderWithAuth,
	ConvexReactClient,
	type AuthTokenFetcher,
	type MutationOptions,
	type Watch,
	type WatchQueryOptions
} from 'convex/react';
import type { OptimisticLocalStore, PaginationStatus } from 'convex/browser';
import {
	getFunctionName,
	type ArgsAndOptions,
	type FunctionArgs,
	type FunctionReference,
	type FunctionReference_future,
	type FunctionReturnType,
	type OptionalRestArgs,
	type SystemTableNames
} from 'convex/server';

export function fixtureId<Table extends TableNames | SystemTableNames>(value: string): Id<Table> {
	return convexId<Table>().parse(value);
}

type QueryReference = FunctionReference<'query'> | FunctionReference_future<'query'>;

type MutationReference = FunctionReference<'mutation'> | FunctionReference_future<'mutation'>;

type ActionReference = FunctionReference<'action'> | FunctionReference_future<'action'>;

type FixtureReader = {
	read: <Result>() => Result;
};

function fixtureReader<Value>(value: Value): FixtureReader {
	const read = <Result,>(): Result => {
		// oxlint-disable-next-line typescript/consistent-type-assertions -- fixtures are keyed by function name, so TypeScript cannot tie the stored value to the reference that reads it.
		return value as Value & Result;
	};

	return { read };
}

// Mirrors the PaginatedWatch interface convex/react declares internally.
type PaginatedWatch<Item> = {
	onUpdate(callback: () => void): () => void;
	localQueryResult(): PaginatedResult<Item> | undefined;
};

type PaginatedResult<Item> = {
	results: Item[];
	status: PaginationStatus;
	loadMore: (numItems: number) => boolean;
};

type PaginatedOptions = {
	initialNumItems: number;
	id: number;
};

export class ConvexTestClient extends ConvexReactClient {
	#queryFixtures = new Map<string, FixtureReader>();
	#paginatedFixtures = new Map<string, FixtureReader>();
	#actionHandlers = new Map<string, FixtureReader>();
	#mutationFixtures = new Map<string, FixtureReader>();
	#queryListeners = new Map<string, Set<() => void>>();

	constructor() {
		super('https://fixtures.invalid');
	}

	registerQuery<Query extends QueryReference>(
		query: Query,
		result: FunctionReturnType<Query>
	): void {
		const name = getFunctionName(query);
		this.#queryFixtures.set(name, fixtureReader(result));
		this.#queryListeners.get(name)?.forEach((listener) => listener());
	}

	registerPaginatedQuery<Query extends QueryReference>(
		query: Query,
		page: FunctionReturnType<Query>['page']
	): void {
		const name = getFunctionName(query);
		this.#paginatedFixtures.set(name, fixtureReader(page));
		this.#queryListeners.get(name)?.forEach((listener) => listener());
	}

	registerAction<Action extends ActionReference>(
		action: Action,
		result: FunctionReturnType<Action>
	): void {
		this.handleAction(action, async () => result);
	}

	registerMutation<Mutation extends MutationReference>(
		mutation: Mutation,
		result: FunctionReturnType<Mutation> | Promise<FunctionReturnType<Mutation>>
	): void {
		this.#mutationFixtures.set(getFunctionName(mutation), fixtureReader(result));
	}

	handleAction<Action extends ActionReference>(
		action: Action,
		handler: (args: FunctionArgs<Action>) => Promise<FunctionReturnType<Action>>
	): void {
		this.#actionHandlers.set(getFunctionName(action), fixtureReader(handler));
	}

	override watchQuery<Query extends QueryReference>(
		query: Query,
		...argsAndOptions: ArgsAndOptions<Query, WatchQueryOptions>
	): Watch<FunctionReturnType<Query>> {
		void argsAndOptions;
		const name = getFunctionName(query);

		return {
			onUpdate: (callback) => this.#listen(name, callback),
			localQueryResult: () => this.#queryFixtures.get(name)?.read<FunctionReturnType<Query>>(),
			journal: () => undefined
		};
	}

	#listen(name: string, callback: () => void) {
		let listeners = this.#queryListeners.get(name);

		if (!listeners) {
			listeners = new Set();
			this.#queryListeners.set(name, listeners);
		}

		listeners.add(callback);

		return () => {
			listeners.delete(callback);
		};
	}

	watchPaginatedQuery<Query extends QueryReference>(
		query: Query,
		args: FunctionArgs<Query>,
		options: PaginatedOptions
	): PaginatedWatch<FunctionReturnType<Query>['page'][number]> {
		void args;
		void options;
		const name = getFunctionName(query);

		return {
			onUpdate: (callback) => this.#listen(name, callback),
			localQueryResult: () => {
				const page = this.#paginatedFixtures.get(name)?.read<FunctionReturnType<Query>['page']>();

				return page ? { results: page, status: 'Exhausted', loadMore: () => false } : undefined;
			}
		};
	}

	override query<Query extends QueryReference>(
		query: Query,
		...args: OptionalRestArgs<Query>
	): Promise<FunctionReturnType<Query>> {
		void args;
		const name = getFunctionName(query);
		const reader = this.#queryFixtures.get(name);

		if (!reader) throw new Error(`No query fixture registered for ${name}`);

		return Promise.resolve(reader.read<FunctionReturnType<Query>>());
	}

	override mutation<Mutation extends MutationReference>(
		mutation: Mutation,
		...argsAndOptions: ArgsAndOptions<Mutation, MutationOptions<FunctionArgs<Mutation>>>
	): Promise<FunctionReturnType<Mutation>> {
		const [args, options] = argsAndOptions;
		const name = getFunctionName(mutation);
		const reader = this.#mutationFixtures.get(name);

		if (!reader) throw new Error(`No mutation fixture registered for ${name}`);

		options?.optimisticUpdate?.(this.#localStore, args ?? {});

		return Promise.resolve(reader.read<FunctionReturnType<Mutation>>());
	}

	#localStore: OptimisticLocalStore = {
		getQuery: (query, ...args) => {
			void args;

			return this.#queryFixtures.get(getFunctionName(query))?.read();
		},
		getAllQueries: () => [],
		setQuery: (query, _args, value) => {
			if (value !== undefined) this.registerQuery(query, value);
		}
	};

	override action<Action extends ActionReference>(
		action: Action,
		...args: OptionalRestArgs<Action>
	): Promise<FunctionReturnType<Action>> {
		const name = getFunctionName(action);

		const handler = this.#actionHandlers
			.get(name)
			?.read<(args: FunctionArgs<Action>) => Promise<FunctionReturnType<Action>>>();

		if (!handler) throw new Error(`No action fixture registered for ${name}`);

		return handler(args[0] ?? {});
	}

	override setAuth(
		fetchToken: AuthTokenFetcher,
		onChange?: (isAuthenticated: boolean) => void
	): void {
		void fetchToken;
		onChange?.(true);
	}

	override clearAuth(): void {}
}

const fetchTestAccessToken = async () => 'test-access-token';

function useTestAuth() {
	return { isLoading: false, isAuthenticated: true, fetchAccessToken: fetchTestAccessToken };
}

export function ConvexTestProvider({
	client,
	children
}: {
	client: ConvexTestClient;
	children: ReactNode;
}) {
	return (
		<ConvexProviderWithAuth client={client} useAuth={useTestAuth}>
			{children}
		</ConvexProviderWithAuth>
	);
}
