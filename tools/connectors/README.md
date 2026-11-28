# Connectors

`crates/sprocket-host/connector-catalog.json` is the reviewed list of remote MCP connectors. Edit it
by hand. Each entry needs a kebab-case `id`, `name`, `description`, and an HTTPS Streamable HTTP
`url`, and can have an `iconUrl`. Keep entries sorted by `id`. A connector's `id` is stored with
users' servers, so don't rename one that has shipped.

MCP registries only suggest additions. `suggest-connectors.ts` reads the
[official MCP Registry](https://registry.modelcontextprotocol.io) and writes up to ten servers to
`candidates.json`, one per registrable domain, in registry name order. A suggestion must be active
and latest, and have an HTTPS Streamable HTTP remote without URL templates on the domain its
registry namespace proves. Domain checks use the Public Suffix List, including private suffixes.
Domains already in the connector list are skipped.

`excluded.json` rejects suggestion ids, which are the first label of the registrable domain, for
example `smithery` for `ai.smithery`. It lists GitHub and Vercel because they have CLI connectors.

Run `bun tools/connectors/suggest-connectors.ts` from the repository root after `bun install`, and
the tests with `node --test tools/connectors/*.test.ts`. The weekly workflow opens a PR with the
suggestions in its body.
