import Redis from "ioredis";
import "dotenv/config";

// Must be the TCP/TLS connection string from Upstash (e.g., rediss://default:password@endpoint:port)
const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.warn("[Redis] REDIS_URL is not defined in environment.");
}

// ioredis requires maxRetriesPerRequest to be null for BullMQ
export const connection = new Redis(redisUrl || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  tls: redisUrl?.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined
});

connection.on("message", (msg) =>{
  console.log("[Redis] Message retreived", msg)
})

connection.on("error", (err) => {
  console.error("[Redis] Connection error:", err);
});
