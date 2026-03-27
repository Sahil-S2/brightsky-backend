"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const dotenv_1 = __importDefault(require("dotenv"));
const audit_1 = __importDefault(require("./routes/audit"));
const security_1 = __importDefault(require("./routes/security"));
dotenv_1.default.config();
const auth_1 = __importDefault(require("./routes/auth"));
const attendance_1 = __importDefault(require("./routes/attendance"));
const admin_1 = __importDefault(require("./routes/admin"));
const settings_1 = __importDefault(require("./routes/settings"));
const export_1 = __importDefault(require("./routes/export"));
const worksites_1 = __importDefault(require("./routes/worksites"));
const schedules_1 = __importDefault(require("./routes/schedules"));
const tasks_1 = __importDefault(require("./routes/tasks"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 4000;
app.use((0, helmet_1.default)());
const allowedOrigins = [
    "http://localhost:3000",
    "https://brightsky-frontend.vercel.app",
    "https://brightsky-api.sahilswarajjena456.workers.dev",
    process.env.FRONTEND_URL,
].filter(Boolean).map(o => o.replace(/\/$/, ""));
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
            callback(null, true);
        }
        else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
}));
app.use((0, morgan_1.default)("dev"));
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
app.use("/api/auth", auth_1.default);
app.use("/api/attendance", attendance_1.default);
app.use("/api/admin", admin_1.default);
app.use("/api/settings", settings_1.default);
app.use("/api/export", export_1.default);
app.use("/api/audit-logs", audit_1.default);
app.use("/api/worksites", worksites_1.default);
app.use("/api/employees", schedules_1.default);
app.use("/api/security", security_1.default);
app.use("/api/tasks", tasks_1.default);
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.listen(PORT, () => {
    console.log(`Bright Sky API running on http://localhost:${PORT}`);
});
