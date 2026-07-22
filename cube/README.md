# cube

A markdown wiki engine that mounts into a Next.js app as a library. Pages are
markdown with typed, site-defined components:

```md
<Prototype game="Sonic the Hedgehog 2" system="Sega Mega Drive" buildDate="1992-05" />

An early prototype. See [[171-5694-01]] for the original cartridge.
```

Component tags are parsed, validated, and rendered through a schema the site
defines once. Nothing in page content is ever compiled or evaluated. The same
schema drives five consumers: rendering, save-time validation with
line-accurate errors, editor node generation, structured-data extraction, and
API introspection.

Components with queryable attributes become database objects on save, and the
built-in `<Query>` component lists pages by that data (filters, sorts,
aggregates), replacing systems like Semantic MediaWiki. Postgres is the source
of truth. Every revision also mirrors to a real git repository, one commit per
edit with author attribution.

## Integration

```ts
import { createCube, cubeNativeAuth, s3Storage } from "cube";

const cube = createCube({
  db: { pool },
  auth: cubeNativeAuth({ pool }),
  storage: s3Storage({ endpoint, bucket, accessKey, secretKey }),
  components: siteComponents,
});
```

The host app owns routing and layout. `cube.api` is the local API for server
components (no HTTP hop), `cube.handlers` mounts as a catch-all route for the
REST API, `cube/react` renders pages, `cube/editor` provides the visual editor
layer, and `cube/mcp` exposes the same operations as MCP tools for agents.
Auth and storage are adapters, so any session system or blob store fits.

## MediaWiki import

`cube/import/mediawiki` converts MediaWiki pages using Parsoid HTML and its
`data-mw` annotations: template calls map to component tags through a
site-supplied mapping table, `#ask` queries become `<Query>` tags, and
galleries, media, and wiki links convert structurally. Imported history keeps
the original wikitext: each MediaWiki revision is stored verbatim with its
author, timestamp, and revision id, and the converted markdown lands as a
revision on top.

## Development

```
npm test          # node --test; integration suites need local Postgres
npm run typecheck
```

Schema DDL lives in `db/migrations` (idempotent, additive). The package ships
TypeScript source and expects `transpilePackages: ["cube"]` in the host's Next
config. Client code must import the `cube/schema`, `cube/react`, or
`cube/editor` subpaths rather than the package root, which pulls in
server-only modules.
