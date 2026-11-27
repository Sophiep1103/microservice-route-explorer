# Train Ticket Graph Query Engine

A Node.js (Express) REST API that loads the Train Ticket microservices topology from a JSON file and answers one question: **which routes exist between services, optionally filtered?**

Filters are small pluggable predicates, so security questions such as "internet to database through a vulnerable service" are expressed by combining them. Responses are returned as `nodes` + `edges`, so a client can draw them directly. A small optional viewer is served at `/`.

By default only **complete routes** are returned, meaning routes that cannot be extended at either end. Add `maximal=false` to get every path, including pieces of longer routes.

JavaScript (ES modules) was chosen deliberately.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restart on file changes
npm test           # Vitest + Supertest
```

Environment variables: `PORT` (default `3000`) and `GRAPH_DATA_PATH` (default `data/train-ticket-be.json`).

Try these:

```text
GET /routes?startNode=user-service&endSink=true
GET /routes?endSink=true&hasVulnerability=true
GET /routes?endSink=true&hasVulnerability=true&maximal=false   # every path, including sub-routes
```

## 1. Definitions and assumptions

### What is a route?

A **route** is a simple directed path `v0 -> v1 -> ... -> vk` with `k >= 1` (at least one edge), following the direction of the edges. **No node appears twice in the same route**.

* A route can start and end at any node.
* Because every path counts, **every sub-path of a longer path is also a route**: `A->B` and `A->B->C` are both routes. By default the API hides these sub-routes (see `maximal` below); `maximal=false` returns all of them.
* **Why simple paths:** microservice graphs can contain cycles, and the "no repeated node" rule guarantees that the search ends. It also keeps every filter a plain predicate over a route.
* **`maxDepth`** limits the number of **edges** in a route (default 20, maximum 50).

### Hiding sub-routes: `maximal` (default `true`)

With `maximal=true` (the default) the API returns only **maximal routes**, which are routes that cannot be extended:

* the last node has no neighbour that is not already on the route, and
* no node outside the route points to its first node.

When `startNode` is given, the start is fixed by the caller, so only the end is checked. A route cut short by `maxDepth` counts as final, and `truncated` is set (see the response format).

| Query | `maximal=true` (default) | `maximal=false` (all routes) |
| :--- | ---: | ---: |
| no filters | 217 | 440 |
| `hasVulnerability` | 60 | 121 |
| `endSink` | 30 | 41 |
| `publicStart` | 5 | 6 |
| `startNode=user-service` | 2 | 3 |

Filters are applied after the routes are enumerated, so `maximal` decides which routes exist and the filters then keep a subset of them.

`maximal` is a parameter of the enumeration and not a registered filter, because it changes which paths are generated rather than testing a finished path.

### Filters

| Filter | A route matches when |
| :--- | :--- |
| `publicStart` | its first node is a `service` with `publicExposed: true` |
| `endSink` | its last node is an `rds/sql` sink |
| `hasVulnerability` | at least one node on the route has a non-empty `vulnerabilities` array |

* **Sink rule:** `kind` is `rds` or `sql` (case-insensitive), or `metadata.engine` contains `postgres`, `mysql`, `mariadb`, `sqlserver` or `oracle`. Other infrastructure, such as `prod-sqs` (`kind: "sqs"`), is not a sink.
* **Combining filters:** all active filters must pass (**logical AND**).

## 2. Data loading

`train-ticket-be.json` has quirks that the loader (`graphLoader.js`) normalizes:

1. **`edge.to` is sometimes a string and sometimes an array** (`consign-service` uses a string). Both become an array of targets.
2. **Dangling reference:** `assurance-service` appears in edges but not in `nodes`. The loader creates a placeholder node (`kind: "unknown"`, `publicExposed: false`, no vulnerabilities) and logs a warning. This is why the graph has 47 nodes while the file lists 46.
3. **Defaults:** `publicExposed` defaults to `false` (only the boolean `true` counts, so the text `"false"` is not treated as public) and `vulnerabilities` to `[]`.
4. **Duplicates and self-loops:** duplicate edges and self-loops are dropped. A duplicate node name keeps the last entry, with a warning.
5. **Validation:** if `nodes` or `edges` is not an array, the server stops at startup with a clear error.

Internal structures, built once at startup:

| Structure | Shape | Used for |
| :--- | :--- | :--- |
| `nodesByName` | `Map<name, node>` | node lookup by name |
| `adjacency` | `Map<name, { target, edge }[]>` | the neighbours the DFS walks; the edge object is shared, so nothing is allocated per step |
| `edges` | `{ id, source, target }[]` | edges returned to the client |

## 3. Observation about the dataset

On this snapshot, **`publicStart=true&endSink=true` returns 0 routes**. This is the correct result for this file, not a bug:

* Only `frontend` and `gateway-service` are public.
* `gateway-service` has **no outgoing edges**.
* `frontend` has a single edge, to `admin-basic-info-service`. In total it reaches only 6 services, and none of them is a database.
* The only database is `prod-postgresdb`. 20 services can reach it, and none of them is public.

In a real system the gateway would forward traffic to services such as `preserve-service` or `travel-plan-service`, so these edges look like they are missing from the file. The code does not invent them.

Other combinations do return results. `endSink=true&hasVulnerability=true` returns the same routes as `endSink=true` (30, or 41 with `maximal=false`), because the database is only reachable through `auth-service` and `order-service`, and both have vulnerabilities.

## 4. Algorithm

1. **Parse and validate** the query string into `{ activeFilters, startNode, maxDepth, maximal }`.
2. **Enumerate** simple paths with a depth-first search. It starts from `startNode` if given, otherwise from every node. A `visited` set keeps a node from appearing twice on the same path.
3. **Filter:** a route is kept only if every active filter returns true.
4. **Shape the response:** merge the surviving routes into unique `nodes` and `edges`, plus the routes as lists of node names.

```text
dfs(current):
  if the path has at least one edge: record a copy of it as a route
  if the path has maxDepth edges: stop
  for each neighbour not in visited:
    add it to the path and visited
    dfs(neighbour)
    remove it again            <- backtracking
```

A route is recorded at **every step**, not only at dead ends. This matters for `endSink`: a path that ends at a database is a route even if the search could have continued.

### Complexity and trade-offs

* The number of simple paths can grow exponentially with branching. That is the worst case, `maxDepth` (maximum 50) bounds the path length, and a safety cap of 200,000 DFS steps per query bounds the work. If the cap is hit, the response has `truncated: true`.
* On this graph it is small: 47 nodes, 98 edges, **no cycles**, longest route 5 edges, 440 routes in total (217 complete routes). Cycle protection is therefore covered by a unit test and not by the real data.
* Filters run after enumeration. This keeps the design simple and generic, but work is wasted when few routes match.
* Possible improvements for larger graphs (not implemented): start only from public nodes when `publicStart` is active, prune branches that cannot reach a sink, add pagination, and cache results, since the graph does not change.

## 5. API

### `GET /graph`

Returns the full graph: `{ "nodes": [...], "edges": [...] }`.

### `GET /routes`

| Parameter | Value | Description |
| :--- | :--- | :--- |
| `publicStart` | `true` / `false` | Turn the filter on or off |
| `endSink` | `true` / `false` | Turn the filter on or off |
| `hasVulnerability` | `true` / `false` | Turn the filter on or off |
| `filters` | comma-separated names | Same as the flags, e.g. `filters=publicStart,endSink`. A flag wins over the list, so `filters=endSink&endSink=false` leaves the filter off |
| `startNode` | node name | Only enumerate routes that start at this node |
| `maxDepth` | integer 1 to 50 | Maximum number of edges per route (default 20) |
| `maximal` | `true` / `false` | Default `true`. When `true`, sub-routes are not returned (see section 1) |

#### Response

`GET /routes?startNode=user-service&endSink=true`

```json
{
  "count": 1,
  "truncated": false,
  "nodes": [ { "name": "user-service", "...": "..." }, { "name": "auth-service", "...": "..." }, { "name": "prod-postgresdb", "...": "..." } ],
  "edges": [
    { "id": "user-service->auth-service", "source": "user-service", "target": "auth-service" },
    { "id": "auth-service->prod-postgresdb", "source": "auth-service", "target": "prod-postgresdb" }
  ],
  "routes": [ ["user-service", "auth-service", "prod-postgresdb"] ]
}
```

* `nodes` and `edges` are the unique nodes and edges of all matching routes (node objects are shortened above).
* `truncated` is `true` when `maxDepth` stopped a route that could have continued, or when the step cap stopped the search, so a cut-off is never silent.

#### Errors

| Status | When |
| :--- | :--- |
| `400` | Unknown query parameter or filter name, a flag that is not `true`/`false`, a repeated parameter, an empty `startNode`, or an invalid `maxDepth` (not plain digits, below 1 or above 50) |
| `404` | Unknown `startNode`, or unknown endpoint |
| `200` | A valid query with no matches: `count: 0` and empty lists |
| `500` | Unexpected error, returned as a generic message with no stack trace |

Unknown parameters are rejected on purpose: a typo such as `endsink=true` would otherwise return the unfiltered result and look like it worked.

## 6. Project structure

```text
src/
├── server.js        # entry point: loads data, wires dependencies, starts the server
├── app.js           # Express app, query parsing and validation, error handling
├── queryEngine.js   # DFS enumeration, filter pipeline, response shaping
├── filters.js       # FilterRegistry and the built-in filters
└── graphLoader.js   # JSON loading and normalization
data/train-ticket-be.json
public/index.html    # optional viewer
tests/routes.test.js
```

Dependencies are injected (`createApp(queryEngine, filterRegistry)`), so each layer can be tested on its own.

## 7. Adding a filter

A filter is a function `(route, context) => boolean`, where `route.nodes` is the list of nodes and `route.edges` the list of edges. Register it in `createDefaultFilterRegistry()` in `src/filters.js`:

```js
registry.register("allInternal", (route) =>
  route.nodes.every((node) => !node.publicExposed)
);
```

It is then available as `?allInternal=true` and in `?filters=...`, with no change to the parser or the traversal. The names `filters`, `startNode`, `maxDepth` and `maximal` are reserved.

Current limits of this design: a filter only sees a finished route, so it cannot take parameters or cut the search early. `context` is reserved for that and is empty today. Filters combine with AND only.

## 8. Tests

`npm test` runs Vitest with Supertest. It covers the DFS on small graphs (cycles and `maxDepth`), the filters and the sink rule, and the API, including the 400 and 404 cases and the results on the real dataset.

## 9. Viewer (optional)

Open `http://localhost:3000/` to see the graph. Tick the options, choose a start service if you like, and select **Find routes**. Select a route to highlight it, or a service to see its vulnerabilities.
