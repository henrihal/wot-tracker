import "dotenv/config";
import express from "express";
import { prisma } from "./lib/prisma.js";

const PORT = process.env["PORT"] || 3001;
const app = express();

app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    res.status(503).json({ status: "error", database: "unreachable", error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});

export { app };