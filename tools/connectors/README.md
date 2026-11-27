# Connector catalog

`update-catalog.ts` builds `catalog.json` from the [official MCP Registry](https://registry.modelcontextprotocol.io),
whose data is CC0. Run `bun tools/connectors/update-catalog.ts` from the repository root after
`bun install`. Run the tests with `node --test tools/connectors/*.test.ts`.

`vendors.json` is the reviewed inclusion list, keyed by registry namespace. Each vendor picks one
official registry server and a stable connector id. `domains` allows extra registrable remote domains
when they differ from the namespace domain. A vendor that publishes under its GitHub org, such as
`io.github.getsentry`, must list its remote domains there. `githubName` identifies a different name
for the same server in the GitHub registry, for example Notion's older SSE listing.

A server qualifies when it is active and latest, and has an HTTPS Streamable HTTP remote without URL
templates on an allowed domain. Domain checks use the Public Suffix List,
including private suffixes. The first qualifying remote wins.

The GitHub MCP Registry supplies only the advisory `listedOnGitHub` field, matched by registry
name, reviewed alias, or remote URL. It never controls catalog inclusion.

Discovery writes the first ten qualifying official servers outside `vendors.json` to
`candidates.json`, one per registrable domain, in registry name order. Approve a candidate in
`vendors.json` or reject its id in `excluded.json` to make room for later ones.

`excluded.json` drops catalog ids and rejects candidate ids. Candidate ids use the first label of
their registrable domain, for example `smithery` for `ai.smithery`. The file lists GitHub and Vercel
because they already have CLI connectors.

The weekly workflow opens a PR with both diffs and the candidates in its body.
