import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

dotenv.config();

import authRoutes       from "./routes/auth";
import attendanceRoutes from "./routes/attendance";
import outingRoutes     from "./routes/outing";
import adminRoutes      from "./routes/admin";
import settingsRoutes   from "./routes/settings";
import exportRoutes     from "./routes/export";
import auditRoutes      from "./routes/audit";
import worksiteRoutes   from "./routes/worksites";
import scheduleRoutes   from "./routes/schedules";
import securityRoutes   from "./routes/security";
import taskRoutes       from "./routes/tasks";
import routeRoutes      from "./routes/route";
import fuelRoutes       from "./routes/fuel";       // ← FUEL MODULE

const app = express();
const PORT = process.env.PORT || 4000;

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = [
  "http://localhost:3000",
  "https://brightsky-frontend.vercel.app",
  "https://brightsky-api.sahilswarajjena456.workers.dev",
  process.env.FRONTEND_URL,
].filter(Boolean).map(o => (o as string).replace(/\/$/, ""));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes((origin || "").replace(/\/$/, ""))) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

app.use(morgan("dev"));

// ── Body parsers — MUST be large enough for base64 photo payloads ────────────
// Default limit is 100kb; fuel entries include two base64 JPEG images (~200KB each).
// We set 25MB to be safe for any future file uploads.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(cookieParser());

// ── API routes ───────────────────────────────────────────────────────────────
app.use("/api/auth",       authRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/attendance", outingRoutes);   // outing sub-routes share /api/attendance prefix
app.use("/api/admin",      adminRoutes);
app.use("/api/settings",   settingsRoutes);
app.use("/api/export",     exportRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/worksites",  worksiteRoutes);
app.use("/api/employees",  scheduleRoutes);
app.use("/api/security",   securityRoutes);
app.use("/api/tasks",      taskRoutes);
app.use("/api/route",      routeRoutes);
app.use("/api/fuel",       fuelRoutes);     // ← FUEL MODULE REGISTERED

// ── Health / version endpoints ───────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/_version", (_req, res) => {
  const fuelPaths: string[] = [];
  app._router.stack.forEach((layer: any) => {
    if (layer.name === "router" && layer.handle?.stack) {
      layer.handle.stack.forEach((s: any) => {
        if (s.route?.path) {
          fuelPaths.push(
            `${Object.keys(s.route.methods).join(",").toUpperCase()} ${s.route.path}`
          );
        }
      });
    }
  });
  res.json({
    sha:          process.env.RAILWAY_GIT_COMMIT_SHA  || "unknown",
    branch:       process.env.RAILWAY_GIT_BRANCH      || "unknown",
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID   || "unknown",
    routes:       fuelPaths,
    bootedAt:     new Date().toISOString(),
  });
});

// ── Global JSON error handler — always return JSON, never HTML ───────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled error]", err?.message || err);
  // Payload-too-large from the body parser
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Request payload too large. Compress photos and retry." });
    return;
  }
  // SyntaxError from malformed JSON body
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Invalid JSON in request body." });
    return;
  }
  res.status(err?.status || 500).json({ error: err?.message || "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`Bright Sky API running on http://localhost:${PORT}`);
});