import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import auditRoutes from "./routes/audit";
import securityRoutes from "./routes/security";


dotenv.config();

import authRoutes from "./routes/auth";
import attendanceRoutes from "./routes/attendance";
import adminRoutes from "./routes/admin";
import settingsRoutes from "./routes/settings";
import exportRoutes from "./routes/export";
import worksiteRoutes from "./routes/worksites";
import scheduleRoutes from "./routes/schedules";
import taskRoutes from "./routes/tasks";
import routeRoutes from "./routes/route";
import outingRoutes from "./routes/outing";   // 👈 new import for project outings
import notificationRoutes from "./routes/notifications";


const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
const allowedOrigins = [
  "http://localhost:3000",
  "https://brightsky-frontend.vercel.app",
  "https://brightsky-api.sahilswarajjena456.workers.dev",
  process.env.FRONTEND_URL,
].filter(Boolean).map(o => o.replace(/\/$/, ""));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));
app.use(morgan("dev"));
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth",       authRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/attendance", outingRoutes);      // 👈 new – mounts under the same base path
app.use("/api/admin",      adminRoutes);
app.use("/api/settings",   settingsRoutes);
app.use("/api/export",     exportRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/worksites", worksiteRoutes);
app.use("/api/employees", scheduleRoutes);
app.use("/api/security", securityRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/route", routeRoutes);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/_version", (_req, res) => {
  const outingPaths: string[] = [];
  app._router.stack.forEach((layer: any) => {
    if (layer.name === "router" && layer.handle?.stack) {
      layer.handle.stack.forEach((s: any) => {
        if (s.route?.path?.includes("outing")) {
          outingPaths.push(
            `${Object.keys(s.route.methods).join(",").toUpperCase()} ${s.route.path}`
          );
        }
      });
    }
  });
  res.json({
    sha: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
    branch: process.env.RAILWAY_GIT_BRANCH || "unknown",
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || "unknown",
    outingRoutes: outingPaths,
    bootedAt: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Bright Sky API running on http://localhost:${PORT}`);
});