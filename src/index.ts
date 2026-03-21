import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import auditRoutes from "./routes/audit";

dotenv.config();

import authRoutes from "./routes/auth";
import attendanceRoutes from "./routes/attendance";
import adminRoutes from "./routes/admin";
import settingsRoutes from "./routes/settings";
import exportRoutes from "./routes/export";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
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

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Bright Sky API running on http://localhost:${PORT}`);
});