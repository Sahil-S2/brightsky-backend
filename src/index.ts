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
app.use("/api/admin",      adminRoutes);
app.use("/api/settings",   settingsRoutes);
app.use("/api/export",     exportRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/worksites", worksiteRoutes);
app.use("/api/employees", scheduleRoutes);
app.use("/api/security", securityRoutes);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Bright Sky API running on http://localhost:${PORT}`);
});