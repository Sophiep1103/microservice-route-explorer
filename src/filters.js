export const RESERVED_PARAMS = new Set(["filters", "startNode", "maxDepth", "maximal"]);
const SINK_KINDS = new Set(["rds", "sql"]);
const SQL_ENGINES = ["postgres", "mysql", "mariadb", "sqlserver", "oracle"];
export function isPublicService(node) {
  return node.kind === "service" && node.publicExposed === true;
}

export function isRdsOrSqlSink(node) {
  const kind = String(node.kind ?? "").toLowerCase();
  if (SINK_KINDS.has(kind)) return true;

  const engine = String(node.metadata?.engine ?? "").toLowerCase();
  return SQL_ENGINES.some((e) => engine.includes(e));
}

export function hasNodeVulnerability(node) {
  return Array.isArray(node.vulnerabilities) && node.vulnerabilities.length > 0;
}

export class FilterRegistry {
  #filters = new Map();

  register(name, predicate) {
    if (RESERVED_PARAMS.has(name)) throw new Error(`'${name}' is a reserved name`);
    if (typeof predicate !== "function") throw new Error("predicate must be a function");
    this.#filters.set(name, predicate);
    return this;
  }

  has(name) {
    return this.#filters.has(name);
  }

  get(name) {
    return this.#filters.get(name);
  }

  getAvailableFilters() {
    return Array.from(this.#filters.keys());
  }

  applyAll(routes, activeFilterNames, context) {
    if (!Array.isArray(activeFilterNames) || activeFilterNames.length === 0) {
      return routes;
    }

    const predicates = activeFilterNames.map((name) => {
      const predicate = this.#filters.get(name);
      if (!predicate) throw new Error(`Unknown filter '${name}'`);
      return predicate;
    });

    return routes.filter((route) =>
      predicates.every((predicate) => predicate(route, context))
    );
  }
}

export function createDefaultFilterRegistry() {
  const registry = new FilterRegistry();

  registry.register("publicStart", (route) => {
    if (!Array.isArray(route.nodes) || route.nodes.length === 0) return false;
    return isPublicService(route.nodes[0]);
  });

  registry.register("endSink", (route) => {
    if (!Array.isArray(route.nodes) || route.nodes.length === 0) return false;
    return isRdsOrSqlSink(route.nodes[route.nodes.length - 1]);
  });

  registry.register("hasVulnerability", (route) => {
    return Array.isArray(route.nodes) && route.nodes.some(hasNodeVulnerability);
  });

  return registry;
}