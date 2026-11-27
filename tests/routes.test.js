import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDefaultFilterRegistry, isRdsOrSqlSink } from "../src/filters.js";
import { loadGraphFromFile, normalizeGraphData } from "../src/graphLoader.js";
import { GraphQueryEngine } from "../src/queryEngine.js";

function engineFor(graphData) {
  const registry = createDefaultFilterRegistry();
  return { registry, engine: new GraphQueryEngine(normalizeGraphData(graphData), registry) };
}

describe("DFS on a tiny graph", () => {
  it("finds every simple path and handles cycles", () => {
    const { engine } = engineFor({
      nodes: [{ name: "A" }, { name: "B" }, { name: "C" }],
      edges: [{ from: "A", to: "B" }, { from: "B", to: "C" }, { from: "C", to: "A" }],
    });
    const { routes } = engine.findRoutes({});
    expect(routes).toHaveLength(6);
    expect(routes).toContainEqual(["A", "B", "C"]);
    expect(routes).not.toContainEqual(["A", "B", "C", "A"]); // no node repeats
  });

  it("respects maxDepth (counted in edges)", () => {
    const { engine } = engineFor({
      nodes: [{ name: "A" }, { name: "B" }, { name: "C" }],
      edges: [{ from: "A", to: "B" }, { from: "B", to: "C" }],
    });
    expect(engine.findRoutes({ startNode: "A", maxDepth: 1 }).routes).toEqual([["A", "B"]]);
  });

  it("ignores self-loops and creates placeholder nodes", () => {
    const g = normalizeGraphData({
      nodes: [{ name: "A" }],
      edges: [{ from: "A", to: ["A", "Ghost"] }],
    });
    expect(g.nodesByName.get("Ghost").kind).toBe("unknown");
    expect(g.edges).toHaveLength(1);
  });
});

describe("filters", () => {
  it("sink detection", () => {
    expect(isRdsOrSqlSink({ kind: "rds" })).toBe(true);
    expect(isRdsOrSqlSink({ kind: "x", metadata: { engine: "postgres" } })).toBe(true);
    expect(isRdsOrSqlSink({ kind: "nosql" })).toBe(false);
    expect(isRdsOrSqlSink({ kind: "sqs" })).toBe(false);
  });

  it("reserved names cannot be registered", () => {
    expect(() => createDefaultFilterRegistry().register("maxDepth", () => true)).toThrow();
  });

  it("applyAll throws on unknown filter", () => {
    expect(() => createDefaultFilterRegistry().applyAll([{ nodes: [] }], ["nope"], {})).toThrow();
  });
});

describe("GET /routes", () => {
  const registry = createDefaultFilterRegistry();
  const engine = new GraphQueryEngine(loadGraphFromFile("data/train-ticket-be.json"), registry);
  const app = createApp(engine, registry);

  it("startNode only", async () => {
    const res = await request(app).get("/routes?startNode=user-service&maximal=false");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);

    const complete = await request(app).get("/routes?startNode=user-service");
    expect(complete.body.count).toBe(2); // default: maximal=true
  });

  it("startNode + endSink", async () => {
    const res = await request(app).get("/routes?startNode=user-service&endSink=true");
    expect(res.body.routes).toEqual([["user-service", "auth-service", "prod-postgresdb"]]);
    expect(res.body.nodes.length).toBe(3);
    expect(res.body.edges.length).toBe(2);
  });

  it("publicStart + endSink is empty on this dataset", async () => {
    const res = await request(app).get("/routes?publicStart=true&endSink=true");
    expect(res.body.count).toBe(0);
  });

  it("filters list and flags are equivalent", async () => {
    const a = await request(app).get("/routes?startNode=user-service&filters=endSink");
    const b = await request(app).get("/routes?startNode=user-service&endSink=true");
    expect(a.body.routes).toEqual(b.body.routes);
  });

  it("flag=false removes a filter from the list", async () => {
    const res = await request(app).get("/routes?startNode=user-service&filters=endSink&endSink=false&maximal=false");
    expect(res.body.count).toBe(3);
  });

  it.each([
    ["unknown param", "/routes?endsink=true"],
    ["unknown filter", "/routes?filters=nope"],
    ["bad flag value", "/routes?publicStart=maybe"],
    ["duplicate param", "/routes?endSink=true&endSink=false"],
    ["maxDepth 0", "/routes?maxDepth=0"],
    ["maxDepth too big", "/routes?maxDepth=51"],
    ["maxDepth not a number", "/routes?maxDepth=abc"],
  ])("400 on %s", async (_name, url) => {
    expect((await request(app).get(url)).status).toBe(400);
  });

  it("404 on unknown startNode and unknown endpoint", async () => {
    expect((await request(app).get("/routes?startNode=nope")).status).toBe(404);
    expect((await request(app).get("/nope")).status).toBe(404);
  });

  it("GET /graph returns all nodes and edges", async () => {
    const res = await request(app).get("/graph");
    expect(res.status).toBe(200);
    expect(res.body.nodes.length).toBeGreaterThan(40);
  });
});


describe("limits and parsing", () => {
  const app = createApp(
    new GraphQueryEngine(loadGraphFromFile("data/train-ticket-be.json"), createDefaultFilterRegistry()),
    createDefaultFilterRegistry()
  );

  it.each(["0x10", "1e1", "%205", "2.5"])("maxDepth=%s is rejected", async (v) => {
    const res = await request(app).get(`/routes?maxDepth=${v}`);
    expect(res.status).toBe(400);
  });

  it("stops enumerating on a dense graph and reports truncated", () => {
    const L = 9, K = 4, nodes = [], edges = [];
    for (let l = 0; l < L; l++) for (let k = 0; k < K; k++) nodes.push({ name: `n${l}_${k}` });
    for (let l = 0; l < L - 1; l++)
      for (let k = 0; k < K; k++)
        edges.push({ from: `n${l}_${k}`, to: Array.from({ length: K }, (_, j) => `n${l + 1}_${j}`) });
    const dense = new GraphQueryEngine(normalizeGraphData({ nodes, edges }), createDefaultFilterRegistry());
    const result = dense.findRoutes({ maximal: false });
    expect(result.truncated).toBe(true);
  });
});
