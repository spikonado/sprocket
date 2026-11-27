import { useAction } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { LocalApi, McpConnector, NewMcpConnector } from '$lib/types/sprocket';

export type RemoteMcpServer = FunctionReturnType<typeof api.mcpServers.listMine>[number];

export const REMOTE_MCP_PREFIX = 'remote:';

export function remoteMcpConnector(server: RemoteMcpServer): McpConnector {
	return {
		id: `${REMOTE_MCP_PREFIX}${server.connectorId}`,
		name: server.name,
		transport: { type: 'http', url: server.url, headers: server.headerNames }
	};
}

function isRemoteMcpUrl(value: string): boolean {
	const url = new URL(value);

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('MCP server URLs must use http or https.');
	}

	return !(
		url.hostname === 'localhost' ||
		url.hostname === '[::1]' ||
		/^127\.\d+\.\d+\.\d+$/.test(url.hostname)
	);
}

type AddedConnector =
	{ type: 'local'; connector: McpConnector } | { type: 'remote'; connectorId: string };

export function useAddMcpConnector(
	userId: string,
	localApi: Pick<LocalApi, 'addMcpConnector'> | null
) {
	const addRemote = useAction(api.mcpServers.add);

	return async (connector: NewMcpConnector): Promise<AddedConnector> => {
		if (connector.transport.type === 'http' && isRemoteMcpUrl(connector.transport.url)) {
			const connectorId = await addRemote({
				name: connector.name,
				url: connector.transport.url,
				headers: connector.transport.headers
			});

			return { type: 'remote', connectorId };
		}

		if (!localApi) throw new Error('Open Sprocket on this computer to add a local connector.');

		return { type: 'local', connector: await localApi.addMcpConnector(userId, connector) };
	};
}
