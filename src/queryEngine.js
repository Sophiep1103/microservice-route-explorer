const DEFAULT_MAX_DEPTH = 20;

export class GraphQueryEngine {
  #graph;
  #filterRegistry;

  constructor(graph, filterRegistry) {
    this.#graph = graph;
    this.#filterRegistry = filterRegistry;
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
    const routes = [];

    const startOk = options.startPredicate ?? (() => true);
    const candidateStarts = options.startNode
      ? [options.startNode].filter((n) => this.#graph.nodesByName.has(n))
      : Array.from(this.#graph.nodesByName.values()).filter(startOk).map((n) => n.name);

    const dfs = (currentName, visited, pathNodes, pathEdges) => {
      if (pathEdges.length > 0) {
        routes.push({
          nodes: [...pathNodes],
          edges: [...pathEdges],
        });
      }

      if (pathEdges.length >= maxDepth) {
        return;
      }

      const neighbors = this.#graph.adjacency.get(currentName) ?? [];
      for (const { target: nextName, edge } of neighbors) {
        if (visited.has(nextName)) continue;
        const nextNode = this.#graph.nodesByName.get(nextName);

        visited.add(nextName);
        pathNodes.push(nextNode);
        pathEdges.push(edge);

        dfs(nextName, visited, pathNodes, pathEdges);

        pathEdges.pop();
        pathNodes.pop();
        visited.delete(nextName);
      }
    };

    for (const startName of candidateStarts) {
      const startNode = this.#graph.nodesByName.get(startName);
      if (!startNode) continue;

      const visited = new Set([startName]);
      dfs(startName, visited, [startNode], []);
    }

    return routes;
  }

  findRoutes(options = {}) {
    const {
      activeFilters = [],
      params = {},
      startNode,
      maxDepth,
    } = options;

    const allRoutes = this.enumerateSimplePaths({ startNode, maxDepth });
    const context = { params };
    const matchedRoutes = this.#filterRegistry.applyAll(allRoutes, activeFilters, context);

    const uniqueNodes = new Map();
    const uniqueEdges = new Map();

    for (const route of matchedRoutes) {
      for (const node of route.nodes) {
        uniqueNodes.set(node.name, node);
      }
      for (const edge of route.edges) {
        uniqueEdges.set(edge.id, edge);
      }
    }

    return {
      count: matchedRoutes.length,
      nodes: Array.from(uniqueNodes.values()),
      edges: Array.from(uniqueEdges.values()),
      routes: matchedRoutes.map((route) => route.nodes.map((node) => node.name)),
    };
  }
}