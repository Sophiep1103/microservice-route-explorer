import path from "path";
import { fileURLToPath } from "url";
import { createApp } from "./app.js";
import { createDefaultFilterRegistry } from "./filters.js";
import { loadGraphFromFile } from "./graphLoader.js";
import { GraphQueryEngine } from "./queryEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}
const DATA_PATH =
  process.env.GRAPH_DATA_PATH ?? path.resolve(__dirname, "../data/train-ticket-be.json");

try {
  const loadedGraph = loadGraphFromFile(DATA_PATH);
  const filterRegistry = createDefaultFilterRegistry();
  const queryEngine = new GraphQueryEngine(loadedGraph, filterRegistry);
  const app = createApp(queryEngine, filterRegistry);

  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  server.on("error", (err) => {
    console.error("Server error:", err);
    process.exit(1);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} catch (err) {
  console.error("Failed to start server:", err);
  process.exit(1);
}