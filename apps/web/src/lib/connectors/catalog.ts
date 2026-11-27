import catalog from '../../../../../crates/sprocket-host/connector-catalog.json';

export type CatalogConnector = (typeof catalog)[number];

export const connectorCatalog = catalog;

export function catalogConnector(id: string) {
	return connectorCatalog.find((connector) => connector.id === id);
}
