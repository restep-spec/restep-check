# restep-check

Conformance checker for [Restep 1](https://restep.wubytes.com/1/) APIs. Point it at your API root:
it reads the discovery document, tries every requirement your server announces (`core`, `query`,
`writes`, `cache`, `relations`, `actions`, `oauth`, `inherit`, subcollections; draft 6) and tells you which ones it meets, which ones it breaks, and where the specification
says so.

```sh
npx restep-check https://api.example.com/                  # read only
npx restep-check http://localhost:8080/ --writes           # also POST, PATCH, DELETE (only its own items)
npx restep-check https://api.example.com/ -H "Authorization: Bearer $TOKEN"
npx restep-check http://localhost:8080/ --junit > restep.xml
```

It also validates documents against the Restep JSON Schemas, which ship in the package:

```sh
npx restep-check --schema discovery https://api.example.com/
npx restep-check --schema problem error.json other-error.json
curl -s https://api.example.com/nope | npx restep-check --schema problem -
```

A discovery document also goes through the rules of the text that a JSON Schema cannot express and
that need no request: a named filter called like a key of `filter`, a subcollection whose path does
not start with its parent's, a filter or sort key through a to-many relationship, a collection with
`sync` without `id` in `filter` with `in`, and the rest of the `discovery.*` checks (all but those
that look at the server's response), plus `query.filter.lists` and `query.language.declared` when it
declares `query`. The report gives the schema and those rules apart; with `--json`, each document
carries `valid` (the schema), `rules` and `conforms`. It exits with 1 when the schema or a MUST fails.

Exit code: 0 when no MUST fails, 1 when one does, 2 when the checker cannot run. Run
`npx restep-check --help` for every option, and see <https://restep.wubytes.com/tools/> for what it
checks and what it does not.

With `--writes` it creates items by copying one it read. If your API has unique fields, give it
bodies that differ: repeat `--fixture` for several bodies, used in turn, or put `{{n}}` in a string,
which becomes a value unique to each POST:

```sh
npx restep-check http://localhost:8080/ --writes --fixture 'stations={"code":"RC-{{n}}","name":"Test {{n}}"}'
```

A `409 conflict` to a POST meant to create is reported as skipped, not failed. Resources that
require `Idempotency-Key` (400) or `If-Match` (428) get them on a retry.

Node 18 or later. The checker itself has no dependencies (you can also download the single file
from the site); `ajv` and `ajv-formats` are only loaded for `--schema`. The single file finds them
installed next to it or in the current directory, and without them says so and gives the `npx` command.

## Source and issues

Code and issues: <https://github.com/restep-spec/restep-check>. That repository is generated from
the Restep site, where the checker is developed alongside the specification and the reference
server. `npm test` runs the checker against the reference server, then against mutated copies of it
that each break one requirement, and expects the matching check to fail.

MIT licensed.
