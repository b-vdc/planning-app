import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { initDb } from "./db/index.js";
import { seedIfEmpty } from "./db/seed.js";
import { registerRoutes } from "./routes/index.js";
import { armCron } from "./worker/cron.js";

const app = Fastify({ logger: true });

const db = await initDb();
await seedIfEmpty(db);
await registerRoutes(app);

// Serve the built SPA (same relative path from server/src and server/dist).
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.status(404).send({ error: "Not found" });
  });
}

await armCron();

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
