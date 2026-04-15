import express from "express";
import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import http from "http";

import { auth } from "./lib/auth";
import router from "./router";
import { initSocket } from "./sockets";
import { startSweeper, stopSweeper } from "./lib/sweeper";
import { emailWorker } from "./queues/email.worker";
import { connection as redisConnection } from "./queues/connection";

const app = express();
const server = http.createServer(app);

// CORS
app.use(
  cors({
    origin: ["http://localhost:3000", "http://localhost:8000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// Better Auth FIRST
app.all("/api/auth/*splat", toNodeHandler(auth));

// JSON middleware AFTER auth
app.use(express.json());

// Routes
app.use("/api", router);

// Health
app.get("/", (_, res) => {
  res.send("API running 🚀");
});

// Socket
initSocket(server);

// Start
server.listen(3005, () => {
  console.log("Server running on 3005");
  startSweeper();
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received — shutting down");
  stopSweeper();
  await emailWorker.close();
  redisConnection.quit();
  server.close(() => process.exit(0));
})

process.on("SIGINT", async () => {
  stopSweeper();
  await emailWorker.close();
  redisConnection.quit();
  server.close(() => process.exit(0));
})