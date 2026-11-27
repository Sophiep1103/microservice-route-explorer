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
    let depthLimited = false;

    const candidateStarts = options.startNode
      ? [options.startNode].filter((name) => this.#graph.nodesByName.has(name))
      : Array.from(this.#graph.nodesByName.keys());

    const dfs = (currentName, visited, pathNodes, pathEdges) => {
      if (pathEdges.length > 0) {
        routes.push({ nodes: [...pathNodes], edges: [...pathEdges] });
      }

      const neighbors = this.#graph.adjacency.get(currentName) ?? [];

      if (pathEdges.length >= maxDepth) {
        if (neighbors.some(({ target }) => !visited.has(target))) depthLimited = true;
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
      }
    };

    for (const startName of candidateStarts) {
      const startNode = this.#graph.nodesByName.get(startName);
      dfs(startName, new Set([startName]), [startNode], []);
    }

    return { routes, depthLimited };
  }

  findRoutes(options = {}) {
    const { activeFilters = [], startNode, maxDepth } = options;

    const { routes: allRoutes, depthLimited } = this.enumerateSimplePaths({ startNode, maxDepth });
    const matchedRoutes = this.#filterRegistry.applyAll(allRoutes, activeFilters, {});

    const uniqueNodes = new Map();
    const uniqueEdges = new Map();
    for (const route of matchedRoutes) {
      for (const node of route.nodes) uniqueNodes.set(node.name, node);
      for (const edge of route.edges) uniqueEdges.set(edge.id, edge);
    }

    return {
      count: matchedRoutes.length,
      truncated: depthLimited,
      nodes: Array.from(uniqueNodes.values()),
      edges: Array.from(uniqueEdges.values()),
      routes: matchedRoutes.map((route) => route.nodes.map((node) => node.name)),
    };
  }
}