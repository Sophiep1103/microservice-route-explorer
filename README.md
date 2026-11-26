# Train Ticket Graph Query Engine

A Node.js (Express) REST API that loads the Train Ticket microservices topology from a JSON file, and lets a client query **routes** between services with pluggable filters. Responses are shaped as `nodes` + `edges`, so they can be rendered directly. A small optional viewer UI is served at `/`.

## 1. Core assumptions and definitions

### What is a route?

A **route** is any simple directed path `v0 -> v1 -> ... -> vk` with `k >= 1` (at least one edge), following the direction of the edges. **No node appears twice in the same route.**

* A route may start and end at **any** node. Every prefix of a longer path is also a route (`A->B` and `A->B->C` are both routes).
* **Why simple paths:** microservice graphs can contain cycles, and the "no repeated node" rule guarantees the traversal terminates. It also keeps every filter a plain predicate over a route.
* **`maxDepth`** limits the number of **edges** in a route (default 20, maximum 50).

### Filters

| Filter | A route matches when |
| :--- | :--- |
| `publicStart` | its first node is a `service` with `publicExposed: true` |
| `endSink` | its last node is an `rds/sql` sink |
| `hasVulnerability` | at least one node on the route has a non-empty `vulnerabilities` array |

* **Sink rule:** `kind` is `rds` or `sql` (case-insensitive), or `metadata.engine` contains `postgres`, `mysql`, `mariadb`, `sqlserver` or `oracle`. Other infrastructure such as `prod-sqs` (`kind: "sqs"`) is not a sink.
* **Combining filters:** all active filters must pass (**logical AND**).

## 2. Data loading and normalization

`train-ticket-be.json` has a few quirks that the loader handles:

1. **`edge.to` is sometimes a string** (`consign-service`) and sometimes an array. Both are normalized to an array.
2. **Dangling references:** `assurance-service` appears in edges but not in `nodes`. The loader creates a placeholder node (`kind: "unknown"`, `publicExposed: false`, no vulnerabilities) and logs a warning.
3. **Defaults:** `publicExposed` defaults to `false`, `vulnerabilities` to `[]`.
4. **Duplicate edges and self-loops** are dropped. Duplicate node names: the last one wins, with a warning.
5. **Validation:** if `nodes` or `edges` is not an array, the server fails at startup with a clear error.

### Observation about this dataset

Only `frontend` and `gateway-service` are public. `gateway-service` has no outgoing edges, and `frontend` only reaches the `admin-basic-info-service` subtree, which contains no database. So `publicStart=true&endSink=true` correctly returns **0 routes** on this snapshot. `endSink=true&hasVulnerability=true` returns routes that end at `prod-postgresdb` through `auth-service` or `order-service`.

## 3. Algorithm

1. **Parse and validate** the query string into `{ activeFilters, params, startNode, maxDepth }`.
2. **Enumerate** simple paths with a DFS. It starts from `startNode` if given, otherwise from every node. A `visited` set prevents cycles, and every path with at least one edge is recorded.
3. **Filter** the routes: each active filter is a predicate, and a route is kept only if all of them pass.
4. **Shape the response:** the surviving routes are merged into unique `nodes` and `edges`, plus the list of routes as arrays of node names.

### Complexity and trade-offs

The number of simple paths can grow exponentially with branching, so enumeration is worst-case exponential. This is acceptable for this graph (about 45 nodes) and is bounded by `maxDepth` (max 50). Filters currently run **after** enumeration, which keeps the design simple and generic.

Possible optimizations for larger graphs (not implemented): start the DFS only from public nodes when `publicStart` is active, prune branches that cannot reach a sink when `endSink` is active, and add a `limit` on the number of routes.

## 4. Project structure

```text
src/
├── server.js        # Entry point: loads data, wires dependencies, starts the server
├── app.js           # Express app, query parsing and validation, error handling
├── queryEngine.js   # DFS path enumeration + filter pipeline + response shaping
├── filters.js       # FilterRegistry and built-in filters
└── graphLoader.js   # JSON loading and normalization
data/train-ticket-be.json
public/index.html    # Optional graph viewer UI
tests/routes.test.js # Vitest + Supertest
```

Dependencies are injected (`createApp(queryEngine, filterRegistry)`), so each layer can be tested on its own.

## 5. API

### `GET /graph`

Returns the full graph: `{ "nodes": [...], "edges": [...] }`.

### `GET /routes`

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `publicStart` | `true` / `false` | Enable or disable the `publicStart` filter |
| `endSink` | `true` / `false` | Enable or disable the `endSink` filter |
| `hasVulnerability` | `true` / `false` | Enable or disable the `hasVulnerability` filter |
| `filters` | string | Comma-separated filter names, e.g. `filters=publicStart,endSink` (same effect as the flags) |
| `startNode` | string | Only enumerate routes that start at this node |
| `maxDepth` | integer 1 to 50 | Maximum number of edges per route (default 20) |

If a filter is given both in `filters` and as a flag, the flag wins (`filters=endSink&endSink=false` disables it).

**Examples**

```text
GET /routes?startNode=user-service&endSink=true
GET /routes?endSink=true&hasVulnerability=true
GET /routes?filters=publicStart,hasVulnerability&maxDepth=6
```

**Response**

```json
{
  "count": 1,
  "nodes": [{ "name": "user-service" }, { "name": "auth-service" }, { "name": "prod-postgresdb" }],
  "edges": [
    { "id": "user-service->auth-service", "source": "user-service", "target": "auth-service" },
    { "id": "auth-service->prod-postgresdb", "source": "auth-service", "target": "prod-postgresdb" }
  ],
  "routes": [["user-service", "auth-service", "prod-postgresdb"]]
}
```

(Node objects are shortened here; the real response includes all node fields.)

### Errors

| Status | When |
| :--- | :--- |
| `400` | Unknown query parameter or filter name, a filter flag that is not `true`/`false`, a duplicated parameter, or an invalid `maxDepth` (not an integer, below 1, or above 50) |
| `404` | Unknown `startNode`, or unknown endpoint |
| `200` | Valid query with no matches: `count: 0` and empty arrays |
| `500` | Unexpected error, returned as a generic message without a stack trace |

## 6. Adding a new filter

A filter is a function `(route, context) => boolean`, where `route.nodes` is the list of nodes and `route.edges` the list of edges. Register it in `createDefaultFilterRegistry()` in `src/filters.js`:

```js
registry.register("hasPrivateOnly", (route) =>
  route.nodes.every((node) => !node.publicExposed)
);
```

It is immediately available as `?hasPrivateOnly=true` and in `?filters=...`, with no changes to the parser or the traversal. The names `filters`, `startNode` and `maxDepth` are reserved.

## 7. Running

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restart on file changes
npm test           # run the test suite
```

Environment variables: `PORT` (default `3000`) and `GRAPH_DATA_PATH` (default `data/train-ticket-be.json`).

Open `http://localhost:3000/` for the optional viewer: it draws the graph, lets you toggle filters, and highlights a route when you click it.
