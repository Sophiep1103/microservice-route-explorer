import express from "express";
import { fileURLToPath } from "url";
import { RESERVED_PARAMS } from "./filters.js";
const MAX_DEPTH_LIMIT = 50;

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
}

export function createApp(queryEngine, filterRegistry) {
  const app = express();
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));

  app.use(express.static(publicDir));

  app.get("/graph", (_req, res, next) => {
    try {
      const graph = queryEngine.getFullGraph();
      res.status(200).json(graph);
    } catch (err) {
      next(err);
    }
  });

  app.get("/routes", (req, res, next) => {
    try {
      const parsed = parseRoutesQuery(req.query, filterRegistry);
      if (parsed.startNode && !queryEngine.hasNode(parsed.startNode)) {
        throw new HttpError(404, `Unknown startNode '${parsed.startNode}'`);
      }

      const result = queryEngine.findRoutes(parsed);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // 404 handler for unknown endpoints
  app.use((_req, _res, next) => {
    next(new HttpError(404, "Endpoint not found"));
  });

  // Centralized error handler
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }

    console.error("Unexpected error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function parseRoutesQuery(query, filterRegistry) {
  const activeFilters = [];


  const allowed = new Set([...RESERVED_PARAMS, ...filterRegistry.getAvailableFilters()]);
  const params = Object.create(null);

  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key)) {
      throw new HttpError(400, `Unknown query parameter '${key}'`);
    }
    if (Array.isArray(value)) {
      throw new HttpError(400, `Duplicate query parameter '${key}' is not supported`);
    }
    if (typeof value === "string" && !RESERVED_PARAMS.has(key)) {
      params[key] = value;
    }
  }

  // Optional comma-separated filter list: ?filters=publicStart,endSink
  if (typeof query.filters === "string" && query.filters.trim().length > 0) {
    const requested = query.filters
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    for (const filterName of requested) {
      if (!filterRegistry.has(filterName)) {
        throw new HttpError(400, `Unknown filter '${filterName}'`);
      }
      if (!activeFilters.includes(filterName)) {
        activeFilters.push(filterName);
      }
    }
  }

  // Boolean filter flags: ?publicStart=true&endSink=true&hasVulnerability=true
  for (const filterName of filterRegistry.getAvailableFilters()) {
    const rawFlag = query[filterName];
    if (rawFlag === undefined) continue;

    if (rawFlag === "true") {
      if (!activeFilters.includes(filterName)) {
        activeFilters.push(filterName);
      }
    } else if (rawFlag === "false") {
      const idx = activeFilters.indexOf(filterName);
      if (idx !== -1) {
        activeFilters.splice(idx, 1);
      }
    } else {
      throw new HttpError(
        400,
        `Invalid value for filter '${filterName}': expected 'true' or 'false'`
      );
    }
  }

  // Optional startNode filter
  let startNode;
  if (query.startNode !== undefined) {
    if (typeof query.startNode !== "string" || query.startNode.trim() === "") {
      throw new HttpError(400, "Query parameter 'startNode' must be a non-empty string");
    }
    startNode = query.startNode.trim();
  }

  // Optional maxDepth bound
  let maxDepth;
  if (query.maxDepth !== undefined) {
    if (typeof query.maxDepth !== "string") {
      throw new HttpError(400, "Query parameter 'maxDepth' must be a positive integer");
    }
    const parsedDepth = Number(query.maxDepth);
    if (!Number.isInteger(parsedDepth) || parsedDepth < 1) {
      throw new HttpError(400, "Query parameter 'maxDepth' must be a positive integer");
    }
    if (parsedDepth > MAX_DEPTH_LIMIT) {
      throw new HttpError(400, `Query parameter 'maxDepth' must be at most ${MAX_DEPTH_LIMIT}`);
    }
    maxDepth = parsedDepth;
  }

  return {
    activeFilters,
    params,
    startNode,
    maxDepth,
  };
}