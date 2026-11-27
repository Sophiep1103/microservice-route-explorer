import fs from "fs";
import path from "path";

export function loadGraphFromFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const rawJson = fs.readFileSync(resolvedPath, "utf-8");
  const data = JSON.parse(rawJson);

  return normalizeGraphData(data);
}

export function normalizeGraphData(data) {
  if (!Array.isArray(data?.nodes) || !Array.isArray(data?.edges)) {
    throw new Error("Invalid graph file: 'nodes' and 'edges' must be arrays");
  }

  const nodesByName = new Map();

  for (const rawNode of data.nodes) {
    const name = typeof rawNode?.name === "string" ? rawNode.name.trim() : "";
    if (!name) continue;
    if (nodesByName.has(name)) console.warn(`Duplicate node '${name}', last one wins`);

    nodesByName.set(name, {
      ...rawNode,
      name,
      publicExposed: rawNode.publicExposed === true,
      vulnerabilities: Array.isArray(rawNode.vulnerabilities) ? rawNode.vulnerabilities : [],
    });
  }

  const adjacency = new Map();
  const edgeMap = new Map();

  for (const rawEdge of data.edges) {
    const source = typeof rawEdge?.from === "string" ? rawEdge.from.trim() : "";
    if (!source) continue;

    if (!nodesByName.has(source)) {
      nodesByName.set(source, createFallbackNode(source));
    }

    const rawTargets = Array.isArray(rawEdge.to) ? rawEdge.to : [rawEdge.to];

    for (const rawTarget of rawTargets) {
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
      if (!target || target === source) continue;

      if (!nodesByName.has(target)) {
        nodesByName.set(target, createFallbackNode(target));
      }

      const edgeId = `${source}->${target}`;
      if (edgeMap.has(edgeId)) continue;

      const edge = { id: edgeId, source, target };
      edgeMap.set(edgeId, edge);

      const neighbors = adjacency.get(source) ?? [];
      neighbors.push({ target, edge });
      adjacency.set(source, neighbors);
    }
  }

  return { nodesByName, adjacency, edges: Array.from(edgeMap.values()) };
}

function createFallbackNode(name) {
  console.warn(`Edge references unknown node '${name}', created placeholder`);
  return { name, kind: "unknown", publicExposed: false, vulnerabilities: [] };
}