const DEFAULT_MAX_DEPTH = 20;
// Safety cap: DFS calls per query. Real data needs ~1k; this bounds time/memory on dense graphs.
const MAX_DFS_STEPS = 200_000;

export class UnknownNodeError extends Error {
  constructor(name) {
    super(`Unknown startNode '${name}'`);
    this.name = "UnknownNodeError";
  }
}

export class GraphQueryEngine {
  #graph;
  #filterRegistry;
  #incoming = new Map();

  constructor(graph, filterRegistry) {
    this.#graph = graph;
    this.#filterRegistry = filterRegistry;

    for (const [source, neighbors] of graph.adjacency) {
      for (const { target } of neighbors) {
        const list = this.#incoming.get(target) ?? [];
        list.push(source);
        this.#incoming.set(target, list);
      }
    }
  }

  hasNode(name) {
    return this.#graph.nodesByName.has(name);
  }
  getFullGraph() {
    return {
      nodes: Array.from(this.#graph.nodesByName.values()),
      edges: [...this.#graph.edges],
    };
  }

  enumerateSimplePaths(options = {}) {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maximal = options.maximal === true;
    const routes = [];
    let depthLimited = false;
    let stepLimited = false;
    let steps = 0;
    let currentStart = null;

    const candidateStarts = options.startNode
      ? [options.startNode].filter((n) => this.#graph.nodesByName.has(n))
      : Array.from(this.#graph.nodesByName.keys());

    const dfs = (currentName, visited, pathNodes, pathEdges) => {
      if (++steps > MAX_DFS_STEPS) {
        stepLimited = true;
        return;
      }
      const neighbors = this.#graph.adjacency.get(currentName) ?? [];
      const depthReached = pathEdges.length >= maxDepth;
      const canExtendForward = neighbors.some(({ target }) => !visited.has(target));

      if (pathEdges.length > 0) {
        let keep = true;
        if (maximal) {
          const endIsFinal = !canExtendForward || depthReached;
          const startIsFinal =
            Boolean(options.startNode) ||
            (this.#incoming.get(currentStart) ?? []).every((source) => visited.has(source));
          keep = endIsFinal && startIsFinal;
        }
        if (keep) routes.push({ nodes: [...pathNodes], edges: [...pathEdges] });
      }

      if (depthReached) {
        if (canExtendForward) depthLimited = true;
        return;
      }

      for (const { target: nextName, edge } of neighbors) {
        if (visited.has(nextName)) continue;

        visited.add(nextName);
        pathNodes.push(this.#graph.nodesByName.get(nextName));
        pathEdges.push(edge);

        dfs(nextName, visited, pathNodes, pathEdges);

        pathEdges.pop();
        pathNodes.pop();
        visited.delete(nextName);
        if (stepLimited) return;
      }
    };

    for (const startName of candidateStarts) {
      if (stepLimited) break;
      currentStart = startName;
      dfs(startName, new Set([startName]), [this.#graph.nodesByName.get(startName)], []);
    }

    return { routes, depthLimited, stepLimited };
  }

  findRoutes(options = {}) {
    const { activeFilters = [], startNode, maxDepth, maximal } = options;

    if (startNode !== undefined && !this.hasNode(startNode)) {
      throw new UnknownNodeError(startNode);
    }

    const { routes: allRoutes, depthLimited, stepLimited } =
      this.enumerateSimplePaths({ startNode, maxDepth, maximal });
    const matchedRoutes = this.#filterRegistry.applyAll(allRoutes, activeFilters, {});

    const uniqueNodes = new Map();
    const uniqueEdges = new Map();
    for (const route of matchedRoutes) {
      for (const node of route.nodes) uniqueNodes.set(node.name, node);
      for (const edge of route.edges) uniqueEdges.set(edge.id, edge);
    }

    return {
      count: matchedRoutes.length,
      truncated: depthLimited || stepLimited,
      nodes: Array.from(uniqueNodes.values()),
      edges: Array.from(uniqueEdges.values()),
      routes: matchedRoutes.map((route) => route.nodes.map((node) => node.name)),
    };
  }
}