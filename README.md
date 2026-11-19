# restep-check

Conformance checker for [Restep 1](https://restep.wubytes.com/1/) APIs. Point it at your API root:
it reads the discovery document, tries every requirement your server announces (`core`, `query`,
`writes`, `oauth`) and tells you which ones it meets, which ones it breaks, and where the specification
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

Exit code: 0 when no MUST fails, 1 when one does, 2 when the checker cannot run. Run
`npx restep-check --help` for every option, and see <https://restep.wubytes.com/tools/> for what it
checks and what it does not.

Node 18 or later. The checker itself has no dependencies (you can also download the single file
from the site); `ajv` is only loaded for `--schema`.

## Source and issues

Code and issues: <https://github.com/restep-spec/restep-check>. That repository is generated from
the Restep site, where the checker is developed alongside the specification and the reference
server. `npm test` runs the checker against the reference server, then against mutated copies of it
that each break one requirement, and expects the matching check to fail.

MIT licensed.
