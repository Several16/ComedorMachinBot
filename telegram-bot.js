const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const crypto = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID || "";
const PANEL_PORT = Number(process.env.ADMIN_PANEL_PORT || 4020);
const PANEL_KEY = process.env.ADMIN_PANEL_KEY || crypto.randomBytes(8).toString("hex");
const PANEL_PUBLIC_URL_ENV = process.env.ADMIN_PANEL_PUBLIC_URL || "";
const IS_WINDOWS = process.platform === "win32";

const BASE_DIR = __dirname;
const BOT_SCRIPT = path.join(BASE_DIR, "charola-auto.js");
const TASK_PS1 = path.join(BASE_DIR, "register-ticket.ps1");
const LOGS_DIR = path.join(BASE_DIR, "logs");
const RUNS_DIR = path.join(BASE_DIR, "runs");
const DATA_DIR = path.join(BASE_DIR, "data");
const PANEL_DIR = path.join(BASE_DIR, "panel");
const LICENSE_FILE = path.join(DATA_DIR, "licenses.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const TASK_NAME = process.env.CHAROLA_TASK_NAME || "CharolaUNCPAutoTicketTG";
const TASK_ACTION = IS_WINDOWS ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""${TASK_PS1}""` : "";
const SCHEDULER_UNSUPPORTED_MESSAGE =
  "Este comando de tarea programada solo funciona en Windows. En VPS Linux usa PM2 o cron.";

const DEFAULTS = {
  dni: process.env.CHAROLA_DNI || "73968815",
  codigo: process.env.CHAROLA_CODIGO || "2023200615D",
  maxAttempts: Number(process.env.CHAROLA_MAX_ATTEMPTS || 1200),
  retryDelayMs: Number(process.env.CHAROLA_RETRY_DELAY_MS || 800),
  turboMode: process.env.CHAROLA_TURBO_MODE !== "false",
};
const MAX_PARALLEL_JOBS = Math.max(1, safeNumber(process.env.CHAROLA_MAX_PARALLEL_JOBS, 60));
const MAX_PARALLEL_JOBS_PER_CHAT = Math.max(1, safeNumber(process.env.CHAROLA_MAX_PARALLEL_JOBS_PER_CHAT, 30));
const LOADING_ACTION_INTERVAL_MS = Math.max(2000, safeNumber(process.env.CHAROLA_LOADING_ACTION_INTERVAL_MS, 4000));
const NOTIFY_JOB_FINISH = process.env.CHAROLA_NOTIFY_ON_FINISH !== "false";
const AUTO_PRESTART_MINUTES = Math.max(0, Math.min(59, safeNumber(process.env.CHAROLA_AUTO_PRESTART_MINUTES, 3)));
const AUTO_START_JITTER_MAX_MS = Math.max(0, safeNumber(process.env.CHAROLA_AUTO_JITTER_MAX_MS, 15000));
const LICENSE_EXPIRY_REMINDER_DAYS = Math.max(1, Math.min(30, safeNumber(process.env.LICENSE_EXPIRY_REMINDER_DAYS, 3)));
const LICENSE_REMINDER_CHECK_MINUTES = Math.max(10, safeNumber(process.env.LICENSE_REMINDER_CHECK_MINUTES, 60));

const emptyLicenses = () => ({ users: {}, codes: {} });
const emptySettings = () => ({ adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || "" });

let activePanelPort = PANEL_PORT;
const chatFlows = new Map();
const runningJobs = new Map();
const lastExitsByChat = new Map();
const recentExits = [];
const loadingIntervalsByChat = new Map();
const sentLicenseReminderKeys = new Set();
let telegramBotClient = null;
let lastDuplicatePollingAlertMs = 0;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN.");
  console.error("Ejemplo: setx TELEGRAM_BOT_TOKEN \"TU_TOKEN\"");
  process.exit(1);
}
if (!fs.existsSync(BOT_SCRIPT)) {
  console.error(`No existe ${BOT_SCRIPT}`);
  process.exit(1);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return nowIso().replace(/[:.]/g, "-");
}

function compact(v) {
  return v === undefined || v === null || v === "" ? "-" : String(v);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseHourMinute(text) {
  const raw = String(text || "").trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) return null;
  const [hh, mm] = raw.split(":").map((x) => Number(x));
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function subtractMinutesFromTime(time, minutes) {
  const parsed = parseHourMinute(time);
  if (!parsed) return null;
  const safeMinutes = Math.max(0, Math.floor(minutes));
  const total = (((parsed.hh * 60 + parsed.mm - safeMinutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function getLimaNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

function limaDateKey() {
  const p = getLimaNowParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function nextAutoRunLabel(targetTime) {
  const startTime = subtractMinutesFromTime(targetTime, AUTO_PRESTART_MINUTES);
  if (!startTime) return "-";
  const nowParts = getLimaNowParts();
  const nowTotal = Number(nowParts.hour) * 60 + Number(nowParts.minute);
  const parsedStart = parseHourMinute(startTime);
  if (!parsedStart) return "-";
  const startTotal = parsedStart.hh * 60 + parsedStart.mm;
  const dayLabel = nowTotal < startTotal ? "Hoy" : "Mañana";
  return `${dayLabel} ${startTime} (Lima)`;
}

function panelPublicUrl() {
  return PANEL_PUBLIC_URL_ENV || `http://localhost:${activePanelPort}`;
}

function loadJson(filePath, fallbackFactory) {
  try {
    if (!fs.existsSync(filePath)) return fallbackFactory();
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackFactory();
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function parseListOutput(text) {
  const map = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return map;
}

function runCommand(command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (error) => {
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

function tailFile(filePath, maxLines = 20) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const txt = fs.readFileSync(filePath, "utf8");
  const lines = txt.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function listRecentRunImages(limit = 20) {
  ensureDir(RUNS_DIR);
  return fs
    .readdirSync(RUNS_DIR)
    .map((name) => {
      const fullPath = path.join(RUNS_DIR, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, stat };
    })
    .filter((x) => x.stat.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(x.name))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, limit);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function clearRunCaptures() {
  ensureDir(RUNS_DIR);
  const files = fs
    .readdirSync(RUNS_DIR)
    .map((name) => path.join(RUNS_DIR, name))
    .filter((fullPath) => fs.statSync(fullPath).isFile() && /\.(png|jpg|jpeg|webp)$/i.test(path.basename(fullPath)));
  let removed = 0;
  let totalBytes = 0;
  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    totalBytes += stat.size;
    fs.unlinkSync(filePath);
    removed += 1;
  }
  return { removed, totalBytes, formatted: formatBytes(totalBytes) };
}

ensureDir(LOGS_DIR);
ensureDir(RUNS_DIR);
ensureDir(DATA_DIR);
ensureDir(PANEL_DIR);

const licenses = loadJson(LICENSE_FILE, emptyLicenses);
const settings = loadJson(SETTINGS_FILE, emptySettings);
if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
  settings.adminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID);
}
saveJson(SETTINGS_FILE, settings);
saveJson(LICENSE_FILE, licenses);

function saveState() {
  saveJson(LICENSE_FILE, licenses);
  saveJson(SETTINGS_FILE, settings);
}

function adminChatId() {
  return settings.adminChatId ? String(settings.adminChatId) : "";
}

function isAdmin(chatId) {
  return adminChatId() && String(chatId) === adminChatId();
}

function chatAllowed(msg) {
  if (!TELEGRAM_ALLOWED_CHAT_ID) return true;
  return String(msg.chat.id) === String(TELEGRAM_ALLOWED_CHAT_ID);
}

function parseCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return { command: "", args: [] };
  const [command, ...args] = raw.split(/\s+/);
  const normalizedCommand = command.toLowerCase().split("@")[0];
  return { command: normalizedCommand, args };
}

function updateUserProfile(msg) {
  const chatId = String(msg.chat.id);
  const u = licenses.users[chatId] || { chatId, expiresAt: null };
  u.chatId = chatId;
  u.firstName = msg.from && msg.from.first_name ? msg.from.first_name : "";
  u.lastName = msg.from && msg.from.last_name ? msg.from.last_name : "";
  u.username = msg.from && msg.from.username ? msg.from.username : "";
  u.lastSeenAt = nowIso();
  licenses.users[chatId] = u;
}

function ensureUserProfile(chatId) {
  const id = String(chatId);
  const user = licenses.users[id] || { chatId: id, expiresAt: null };
  user.chatId = id;
  licenses.users[id] = user;
  return user;
}

function ensureUserAutoRun(chatId) {
  const user = ensureUserProfile(chatId);
  if (!user.autoRun) {
    user.autoRun = { enabled: false, time: "07:00", dni: "", codigo: "", turboMode: true };
  }
  return user;
}

function hasAutoCredentials(autoRun) {
  if (!autoRun) return false;
  const dni = String(autoRun.dni || "").replace(/\D/g, "");
  const codigo = String(autoRun.codigo || "").trim();
  return dni.length >= 8 && codigo.length >= 4;
}

function describeLastExit(exitInfo) {
  if (!exitInfo) return "Nunca";
  return `${exitCodeLabel(exitInfo.code)} (${exitInfo.at})`;
}

function hasActiveLicense(chatId) {
  if (isAdmin(chatId)) return true;
  const u = licenses.users[String(chatId)];
  if (!u || !u.expiresAt) return false;
  return new Date(u.expiresAt).getTime() > Date.now();
}

function grantLicense(chatId, days, grantedBy = "admin", source = "manual") {
  const id = String(chatId);
  const user = licenses.users[id] || { chatId: id };
  const start = user.expiresAt && new Date(user.expiresAt).getTime() > Date.now() ? user.expiresAt : nowIso();
  user.expiresAt = addDays(start, safeNumber(days, 30));
  user.grantedBy = grantedBy;
  user.source = source;
  user.grantedAt = nowIso();
  licenses.users[id] = user;
  saveState();
  return user;
}

function revokeLicense(chatId) {
  const id = String(chatId);
  const user = licenses.users[id] || { chatId: id };
  user.expiresAt = null;
  user.revokedAt = nowIso();
  licenses.users[id] = user;
  saveState();
  return user;
}

function generateLicenseCode(days, quantity, by) {
  const created = [];
  const d = safeNumber(days, 30);
  const q = Math.min(100, Math.max(1, safeNumber(quantity, 1)));
  for (let i = 0; i < q; i += 1) {
    let code = "";
    do {
      code = crypto.randomBytes(4).toString("hex").toUpperCase();
    } while (licenses.codes[code]);
    licenses.codes[code] = {
      code,
      days: d,
      createdAt: nowIso(),
      createdBy: String(by || "admin"),
      usedBy: null,
      usedAt: null,
      revokedAt: null,
    };
    created.push(code);
  }
  saveState();
  return created;
}

function activateCode(chatId, code) {
  const key = String(code || "").trim().toUpperCase();
  const lic = licenses.codes[key];
  if (!lic) return { ok: false, reason: "Código inválido." };
  if (lic.revokedAt) return { ok: false, reason: "Código revocado." };
  if (lic.usedBy) return { ok: false, reason: "Código ya usado." };
  const user = grantLicense(chatId, lic.days, "code", `code:${key}`);
  lic.usedBy = String(chatId);
  lic.usedAt = nowIso();
  saveState();
  return { ok: true, user, code: key, days: lic.days };
}

function listActiveUsers() {
  return Object.values(licenses.users)
    .filter((u) => u.expiresAt && new Date(u.expiresAt).getTime() > Date.now())
    .sort((a, b) => new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime());
}

function adminRequired(chatId) {
  return isAdmin(chatId);
}

function setFlow(chatId, flow) {
  chatFlows.set(String(chatId), flow);
}

function getFlow(chatId) {
  return chatFlows.get(String(chatId));
}

function clearFlow(chatId) {
  chatFlows.delete(String(chatId));
}

function generateJobId(chatId) {
  return `${String(chatId)}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
}

function listRunningJobs(chatId) {
  const allJobs = Array.from(runningJobs.values());
  const filtered = chatId === undefined ? allJobs : allJobs.filter((job) => job.chatId === String(chatId));
  return filtered.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function pushRecentExit(exitInfo) {
  lastExitsByChat.set(exitInfo.chatId, exitInfo);
  recentExits.unshift(exitInfo);
  if (recentExits.length > 100) recentExits.length = 100;
}

function latestLogPath() {
  if (!fs.existsSync(LOGS_DIR)) return null;
  const files = fs
    .readdirSync(LOGS_DIR)
    .map((n) => path.join(LOGS_DIR, n))
    .filter((p) => fs.statSync(p).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function stopLoadingIndicator(chatId) {
  const key = String(chatId);
  const interval = loadingIntervalsByChat.get(key);
  if (interval) {
    clearInterval(interval);
    loadingIntervalsByChat.delete(key);
  }
}

function startLoadingIndicator(chatId) {
  if (!telegramBotClient) return;
  const key = String(chatId);
  if (loadingIntervalsByChat.has(key)) return;

  const tick = async () => {
    if (!telegramBotClient) return;
    if (!listRunningJobs(key).length) {
      stopLoadingIndicator(key);
      return;
    }
    try {
      await telegramBotClient.sendChatAction(key, "typing");
    } catch {}
  };

  tick().catch(() => {});
  const interval = setInterval(() => {
    tick().catch(() => {});
  }, LOADING_ACTION_INTERVAL_MS);
  loadingIntervalsByChat.set(key, interval);
}

function extractLastArtifactPaths(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return { fullPath: null, qrPath: null };
  const text = fs.readFileSync(logPath, "utf8");
  let fullPath = null;
  let qrPath = null;
  const captureRegex = /captura:\s*(.+)\s*$/gm;
  const qrRegex = /qr:\s*(.+)\s*$/gm;
  let match = null;
  while ((match = captureRegex.exec(text)) !== null) {
    fullPath = String(match[1] || "").trim();
  }
  while ((match = qrRegex.exec(text)) !== null) {
    qrPath = String(match[1] || "").trim();
  }
  return {
    fullPath: fullPath && fs.existsSync(fullPath) ? fullPath : null,
    qrPath: qrPath && fs.existsSync(qrPath) ? qrPath : null,
  };
}

function exitCodeLabel(code) {
  if (code === 0) return "✅ Éxito";
  if (code === 2) return "⛔ Error de datos (fatal)";
  if (code === 1) return "⚠️ Sin ticket en este intento";
  return "❌ Error inesperado";
}

async function notifyJobFinished(exitInfo) {
  if (!NOTIFY_JOB_FINISH || !telegramBotClient || !exitInfo) return;
  const { chatId, code, jobId, pid, logPath } = exitInfo;
  const label = exitCodeLabel(code);
  const lines = [
    `🔔 *Reporte de Ejecución*`,
    `───────────────`,
    `*Estado:* ${label}`,
    `*Job ID:* \`${jobId}\``,
    `*PID:* ${pid}`,
    `*Código:* ${code}`,
    `*Hora:* ${exitInfo.at}`
  ];
  try {
    const artifacts = extractLastArtifactPaths(logPath);
    const preferredImage = artifacts.qrPath || artifacts.fullPath;
    if (preferredImage) {
      await telegramBotClient.sendPhoto(chatId, fs.createReadStream(preferredImage), {
        caption: `${label}\nJob: ${jobId}\nPID: ${pid}`,
      });
    }
    await telegramBotClient.sendMessage(chatId, lines.join("\n"), {
      reply_markup: userKeyboard(isAdmin(chatId)),
    });
  } catch (error) {
    console.error(`No se pudo notificar cierre de job ${jobId}:`, error.message);
  }
}

function startBot(chatId, config) {
  const ownerChatId = String(chatId);
  const ownRunningJobs = listRunningJobs(ownerChatId);
  if (ownRunningJobs.length >= MAX_PARALLEL_JOBS_PER_CHAT) {
    return {
      started: false,
      reason: `Ya tienes ${ownRunningJobs.length} proceso(s) en ejecución (máximo ${MAX_PARALLEL_JOBS_PER_CHAT}).`,
    };
  }
  if (runningJobs.size >= MAX_PARALLEL_JOBS) {
    return {
      started: false,
      reason: `Capacidad global ocupada (${runningJobs.size}/${MAX_PARALLEL_JOBS}). Intenta en unos minutos.`,
    };
  }
  const env = { ...process.env };
  env.CHAROLA_DNI = String(config.dni || "");
  env.CHAROLA_CODIGO = String(config.codigo || "");
  env.CHAROLA_MAX_ATTEMPTS = String(safeNumber(config.maxAttempts, DEFAULTS.maxAttempts));
  env.CHAROLA_RETRY_DELAY_MS = String(safeNumber(config.retryDelayMs, DEFAULTS.retryDelayMs));
  env.CHAROLA_AFTER_SUBMIT_WAIT_MS = String(safeNumber(config.afterSubmitWaitMs, 6000));
  env.CHAROLA_TURBO_MODE = config.turboMode === false ? "false" : "true";
  env.CHAROLA_HEADLESS = config.headless === false ? "false" : "true";

  const jobId = generateJobId(ownerChatId);
  const logPath = path.join(LOGS_DIR, `tg-${ownerChatId}-${stamp()}-${jobId}.log`);
  const startedAt = nowIso();

  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(process.execPath, [BOT_SCRIPT], { cwd: BASE_DIR, env, windowsHide: true });
  const job = {
    jobId,
    chatId: ownerChatId,
    pid: child.pid,
    startedAt,
    logPath,
    turboMode: env.CHAROLA_TURBO_MODE !== "false",
    dni: env.CHAROLA_DNI,
    codigo: env.CHAROLA_CODIGO,
    process: child,
  };
  runningJobs.set(jobId, job);
  startLoadingIndicator(ownerChatId);

  stream.write(`[${nowIso()}] Job iniciado desde Telegram | jobId=${jobId} | chatId=${ownerChatId}\n`);
  child.stdout.on("data", (c) => stream.write(String(c)));
  child.stderr.on("data", (c) => stream.write(String(c)));
  child.on("close", async (code) => {
    stream.write(`\n[${nowIso()}] Bot finalizado con código ${code}\n`);
    stream.end();
    runningJobs.delete(jobId);
    if (!listRunningJobs(ownerChatId).length) {
      stopLoadingIndicator(ownerChatId);
    }
    const exitInfo = {
      jobId,
      chatId: ownerChatId,
      pid: child.pid,
      code,
      at: nowIso(),
      logPath,
    };
    pushRecentExit(exitInfo);
    await notifyJobFinished(exitInfo);
  });
  child.on("error", (error) => stream.write(`\n[${nowIso()}] Error del proceso: ${error.message}\n`));
  return {
    started: true,
    jobId,
    pid: child.pid,
    logPath,
    runningGlobal: runningJobs.size,
    runningUser: ownRunningJobs.length + 1,
  };
}

async function stopSingleJob(job) {
  if (!job || !job.process) return { jobId: job && job.jobId, pid: job && job.pid, stopped: false, details: "Proceso no encontrado." };
  if (IS_WINDOWS) {
    const r = await runCommand("taskkill", ["/PID", String(job.pid), "/T", "/F"]);
    return { jobId: job.jobId, pid: job.pid, stopped: r.ok, details: (r.stdout || r.stderr || "").trim() };
  }
  try {
    job.process.kill("SIGTERM");
    return { jobId: job.jobId, pid: job.pid, stopped: true, details: "Proceso detenido con SIGTERM." };
  } catch (error) {
    return { jobId: job.jobId, pid: job.pid, stopped: false, details: String(error && error.message ? error.message : error) };
  }
}

async function stopJobs(chatId, stopAll = false) {
  const targetJobs = stopAll ? listRunningJobs() : listRunningJobs(chatId);
  if (!targetJobs.length) {
    return {
      stopped: false,
      stoppedCount: 0,
      total: 0,
      reason: stopAll ? "No hay procesos en ejecución." : "No tienes procesos en ejecución.",
      results: [],
    };
  }
  const results = await Promise.all(targetJobs.map((job) => stopSingleJob(job)));
  const stoppedCount = results.filter((r) => r.stopped).length;
  return {
    stopped: stoppedCount > 0,
    stoppedCount,
    total: targetJobs.length,
    failedCount: targetJobs.length - stoppedCount,
    results,
  };
}

const userCronJobs = new Map();

function getAutoMenuPayload(chatId) {
  const user = ensureUserAutoRun(chatId);
  const auto = user.autoRun;
  const startAt = subtractMinutesFromTime(auto.time, AUTO_PRESTART_MINUTES) || "-";
  const credentialsOk = hasAutoCredentials(auto);
  const txt = [
    "⚙️ *Tarea Automática (Diaria)*",
    "───────────────",
    `*Estado:* ${auto.enabled ? "✅ Habilitada" : "❌ Deshabilitada"}`,
    `*Hora objetivo:* ${auto.time}`,
    `*Inicio real:* ${startAt} (Lima)`,
    `*Próxima ejecución:* ${auto.enabled ? nextAutoRunLabel(auto.time) : "-"}`,
    `*Cuentas registradas:* ${Array.isArray(auto.accounts) ? auto.accounts.length : 0} cuenta(s)`, // Cambiado de Credenciales
    `*Modo:* ${auto.turboMode ? "⚡ TURBO" : "🐢 NORMAL"}`,
    "",
    "Selecciona una acción:",
  ].join("\n");
  const opts = {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: auto.enabled ? "❌ Deshabilitar" : "✅ Habilitar", callback_data: auto.enabled ? "cron_disable" : "cron_enable" },
          { text: "▶️ Probar ahora", callback_data: "cron_run_now" },
        ],
        [{ text: "🕒 Cambiar Hora", callback_data: "cron_time" }, { text: "➕ Añadir Cuenta", callback_data: "cron_credentials" }],
        [{ text: "📋 Ver Cuentas", callback_data: "cron_view_accounts" }, { text: "🗑️ Limpiar Cuentas", callback_data: "cron_clear_accounts" }],
        [{ text: `⚡ Modo: ${auto.turboMode ? "TURBO" : "NORMAL"}`, callback_data: "cron_mode" }],
      ],
    },
  };
  return { txt, opts };
}

async function renderAutoMenu(bot, chatId, messageId) {
  const { txt, opts } = getAutoMenuPayload(chatId);
  if (messageId) {
    try {
      await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, ...opts });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, txt, opts);
}

function setupUserCron(chatId) {
  const id = String(chatId);
  const existingJob = userCronJobs.get(id);
  if (existingJob) {
    existingJob.stop();
    userCronJobs.delete(id);
  }

  const u = ensureUserAutoRun(id);
  if (!u || !u.autoRun || !u.autoRun.enabled || !u.autoRun.time) return;

  if (!hasActiveLicense(id)) return;

  const time = u.autoRun.time;
  const startTime = subtractMinutesFromTime(time, AUTO_PRESTART_MINUTES);
  if (!startTime) return;
  const [hh, mm] = startTime.split(":");

  const job = cron.schedule(`${mm} ${hh} * * *`, () => {
    if (!hasActiveLicense(id)) {
      job.stop();
      userCronJobs.delete(id);
      return;
    }

    if (!hasAutoCredentials(u.autoRun)) {
      if (telegramBotClient) {
        telegramBotClient
          .sendMessage(
            id,
            "⏰ No se ejecutó tu tarea automática porque faltan credenciales.\nUsa ⏰ Auto -> ➕ Añadir Cuenta para registrar al menos una cuenta."
          )
          .catch(() => {});
      }
      return;
    }

    const launch = () => {
      const result = startBot(id, {
        dni: u.autoRun.dni,
        codigo: u.autoRun.codigo,
        turboMode: u.autoRun.turboMode !== false
      });

      if (result.started && telegramBotClient) {
        telegramBotClient
          .sendMessage(
            id,
            `⏰ Bot iniciado automáticamente. Hora objetivo: ${u.autoRun.time} | inicio real: ${startTime} (Lima).`
          )
          .catch(() => {});
      } else if (telegramBotClient) {
        telegramBotClient.sendMessage(id, `⏰ Falló el inicio automático: ${result.reason}`).catch(() => {});
      }
    };

    if (AUTO_START_JITTER_MAX_MS > 0) {
      const delay = Math.floor(Math.random() * (AUTO_START_JITTER_MAX_MS + 1));
      setTimeout(launch, delay);
    } else {
      launch();
    }
  }, {
    scheduled: true,
    timezone: "America/Lima"
  });

  userCronJobs.set(id, job);
}

function initializeAllCrons() {
  for (const id of Object.keys(licenses.users)) {
    setupUserCron(id);
  }
}

async function notifyLicenseExpirations() {
  if (!telegramBotClient) return;
  const dayKey = limaDateKey();
  const nowMs = Date.now();
  for (const user of Object.values(licenses.users)) {
    if (!user || !user.chatId || !user.expiresAt) continue;
    const chatId = String(user.chatId);
    if (isAdmin(chatId)) continue;
    const expiresMs = new Date(user.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    const daysLeft = Math.ceil((expiresMs - nowMs) / 86400000);
    if (daysLeft < 1 || daysLeft > LICENSE_EXPIRY_REMINDER_DAYS) continue;
    const reminderKey = `${chatId}:${daysLeft}:${dayKey}`;
    if (sentLicenseReminderKeys.has(reminderKey)) continue;
    sentLicenseReminderKeys.add(reminderKey);
    if (sentLicenseReminderKeys.size > 5000) sentLicenseReminderKeys.clear();
    await telegramBotClient
      .sendMessage(
        chatId,
        `🔔 Tu licencia vence en ${daysLeft} día(s).\nRenueva con /activar CODIGO para evitar interrupciones.`,
        { reply_markup: userKeyboard(isAdmin(chatId)) }
      )
      .catch(() => {});
  }
}

function startLicenseReminderLoop() {
  const everyMs = LICENSE_REMINDER_CHECK_MINUTES * 60 * 1000;
  setInterval(() => {
    notifyLicenseExpirations().catch(() => {});
  }, everyMs);
  setTimeout(() => {
    notifyLicenseExpirations().catch(() => {});
  }, 10000);
}

async function getTaskStatus() {
  return {
    exists: true,
    state: "Multi-usuario",
    nextRun: "-",
    lastRun: "-",
    lastResult: "-",
    taskState: `Activas: ${userCronJobs.size}`,
  };
}

// Initialize all user crons on startup
setTimeout(initializeAllCrons, 2000);
startLicenseReminderLoop();

function userKeyboard(isAdminUser) {
  const base = [
    ["🚀 Iniciar", "⚙️ Configurar"],
    ["📊 Estado", "🧵 Procesos", "🛑 Detener"],
    ["🖼️ Foto", "🔐 Licencia", "⏰ Auto"],
    ["❓ Ayuda", "🆔 Mi ID"]
  ];
  if (isAdminUser) {
    base.push(["🛠️ Admin", "📋 Licencias", "🧹 Limpiar"]);
  }
  return { keyboard: base, resize_keyboard: true };
}

function licenseStatusText(chatId) {
  if (isAdmin(chatId)) return "👑 Eres ADMIN.";
  const u = licenses.users[String(chatId)];
  if (!u || !u.expiresAt) return "❌ No tienes licencia activa. Usa /activar CODIGO";
  const valid = new Date(u.expiresAt).getTime() > Date.now();
  return valid ? `✅ Licencia activa hasta: ${u.expiresAt}` : `❌ Licencia vencida: ${u.expiresAt}`;
}

function helpText(isAdminUser) {
  const base = [
    "Comandos principales:",
    "/start, /menu - Abrir menú con botones",
    "/status - Estado",
    "/mis_procesos - Ver tus procesos activos",
    "/iniciar [dni] [codigo] [turbo|normal] - Inicio rápido",
    "/config_iniciar - Inicio guiado paso a paso",
    "/menu_tarea - Configurar automático diario",
    "/diagnostico - Estado técnico resumido",
    "/detener - Detener tus procesos activos",
    "/foto - Última captura",
    "Mientras corre verás al bot en 'escribiendo...' y un mensaje de '⏳ Procesando...'.",
    "Al finalizar un proceso te llega aviso automático con resultado.",
    "/mi_licencia - Ver estado de licencia",
    "/activar CODIGO - Activar licencia",
    "/cancel - Cancelar flujo guiado",
    "/myid - Ver tu chat_id",
  ];
  if (isAdminUser) {
    base.push(
      "",
      "Admin:",
      "/hacer_admin (solo 1ra vez)",
      "/set_admin <chat_id>",
      "/crear_licencia <dias> [cantidad]",
      "/dar_licencia <chat_id> <dias>",
      "/quitar_licencia <chat_id>",
      "/licencias",
      "/limpiar_capturas",
      "/crear_tarea [HH:mm], /hora HH:mm, /ejecutar, /parar_tarea, /habilitar, /deshabilitar"
    );
  }
  return base.join("\n");
}

async function sendStatus(bot, chatId) {
  const ownJobs = listRunningJobs(chatId);
  const latestOwnExit = lastExitsByChat.get(String(chatId));
  const ownJobPids = ownJobs.slice(0, 5).map((j) => `${j.pid}`).join(", ");

  const licenseText = licenseStatusText(chatId);
  const licenseEmoji = licenseText.includes("❌") ? "❌" : "✅";

  const u = ensureUserAutoRun(chatId);
  const auto = u.autoRun;
  const startAt = subtractMinutesFromTime(auto.time, AUTO_PRESTART_MINUTES) || "-";
  const nextRun = auto.enabled ? nextAutoRunLabel(auto.time) : "-";
  const credentialsOk = hasAutoCredentials(auto);
  const ownLastExit = describeLastExit(latestOwnExit);
  const recommendation = !hasActiveLicense(chatId)
    ? "🔐 Activa licencia con /activar CODIGO."
    : auto.enabled && !credentialsOk
    ? "⚠️ Completa DNI/Código en ⏰ Auto para que corra diario."
    : ownJobs.length > 0
    ? "⏳ Tu bot está trabajando ahora."
    : "✅ Todo listo para iniciar.";

  const lines = [
    "📊 *Estado del Sistema*",
    "───────────────",
    `*Procesos Globales:* ${runningJobs.size}/${MAX_PARALLEL_JOBS}`,
    `*Tus Procesos:* ${ownJobs.length}/${MAX_PARALLEL_JOBS_PER_CHAT}`,
    `*Tus PIDs activos:* ${compact(ownJobPids || "Ninguno")}`,
    "",
    "⏱️ *Última Ejecución*",
    `*Resultado:* ${ownLastExit}`,
    "",
    "⚙️ *Tu Tarea Automática*",
    `*Estado:* ${auto.enabled ? "✅ Habilitada" : "❌ Deshabilitada"}`,
    `*Hora objetivo:* ${auto.time}`,
    `*Inicio real:* ${startAt} (Lima)`,
    `*Próxima ejecución:* ${nextRun}`,
    `*Cuentas:* ${credentialsOk ? `${(auto.accounts || []).length} registradas` : "❌ Faltan cuentas"}`,
    "",
    `${licenseEmoji} *Licencia*`,
    licenseText,
    "",
    `*Siguiente paso:* ${recommendation}`,
  ];
  await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", reply_markup: userKeyboard(isAdmin(chatId)) });
}

async function sendDiagnostics(bot, chatId) {
  const isAdminUser = isAdmin(chatId);
  const ownJobs = listRunningJobs(chatId);
  const ownLastExit = lastExitsByChat.get(String(chatId));
  const user = ensureUserAutoRun(chatId);
  const auto = user.autoRun;
  const startAt = subtractMinutesFromTime(auto.time, AUTO_PRESTART_MINUTES) || "-";
  const nextRun = auto.enabled ? nextAutoRunLabel(auto.time) : "-";
  const duplicateDetected = Date.now() - lastDuplicatePollingAlertMs < 6 * 60 * 60 * 1000;
  const lines = [
    "🩺 *Diagnóstico rápido*",
    "───────────────",
    `*Node:* ${process.version}`,
    `*Plataforma:* ${process.platform}`,
    `*Jobs globales:* ${runningJobs.size}/${MAX_PARALLEL_JOBS}`,
    `*Tus jobs:* ${ownJobs.length}/${MAX_PARALLEL_JOBS_PER_CHAT}`,
    `*Crons activos:* ${userCronJobs.size}`,
    `*Último resultado:* ${describeLastExit(ownLastExit)}`,
    "",
    "⚙️ *Automático*",
    `*Estado:* ${auto.enabled ? "ON" : "OFF"}`,
    `*Hora objetivo:* ${auto.time}`,
    `*Inicio real:* ${startAt} (Lima)`,
    `*Próxima ejecución:* ${nextRun}`,
    `*Cuentas:* ${hasAutoCredentials(auto) ? (auto.accounts || []).length : "0"}`,
    `*Pre-arranque:* ${AUTO_PRESTART_MINUTES} minuto(s)`,
    `*Jitter:* ${AUTO_START_JITTER_MAX_MS} ms`,
    "",
    `*Conflicto 409 reciente:* ${duplicateDetected ? "Sí" : "No"}`,
  ];
  if (isAdminUser) {
    lines.push(
      "",
      "👑 *Admin*",
      `*Panel:* ${panelPublicUrl()}`,
      `*Admin chat_id:* ${adminChatId() || "-"}`,
    );
  }
  await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", reply_markup: userKeyboard(isAdminUser) });
}

async function sendOwnJobs(bot, chatId) {
  const ownJobs = listRunningJobs(chatId);
  if (!ownJobs.length) {
    const lastExit = lastExitsByChat.get(String(chatId));
    const text = lastExit
      ? `No tienes procesos en ejecución.\nÚltimo cierre: ${lastExit.at} | code ${lastExit.code} | PID ${lastExit.pid}`
      : "No tienes procesos en ejecución.";
    await bot.sendMessage(chatId, text, { reply_markup: userKeyboard(isAdmin(chatId)) });
    return;
  }
  const lines = ownJobs.slice(0, 10).map(
    (j) => `- job ${j.jobId}\n  PID ${j.pid} | modo ${j.turboMode ? "TURBO" : "NORMAL"} | inicio ${j.startedAt}`
  );
  await bot.sendMessage(chatId, `🧵 Tus procesos activos (${ownJobs.length}):\n${lines.join("\n")}`, {
    reply_markup: userKeyboard(isAdmin(chatId)),
  });
}

async function sendLastPhoto(bot, chatId) {
  const images = listRecentRunImages(1);
  if (!images.length) {
    await bot.sendMessage(chatId, "No encontré capturas todavía.");
    return;
  }
  const last = images[0];
  await bot.sendPhoto(chatId, fs.createReadStream(last.fullPath), { caption: `Última captura: ${last.name}` });
}

async function sendAdminPanelHint(bot, chatId) {
  const txt = [
    "🛠️ Panel admin activo",
    `URL: ${panelPublicUrl()}`,
    `Clave panel: ${PANEL_KEY}`,
    "Tip: guárdala y luego cámbiala usando ADMIN_PANEL_KEY.",
  ].join("\n");
  await bot.sendMessage(chatId, txt, { reply_markup: userKeyboard(true) });
}

function requireUseAccess(chatId) {
  if (isAdmin(chatId)) return { ok: true };
  if (hasActiveLicense(chatId)) return { ok: true };
  return { ok: false, message: "❌ No tienes licencia activa. Usa /activar CODIGO" };
}

function cancelKeyboard() {
  return { keyboard: [["❌ Cancelar"]], resize_keyboard: true, one_time_keyboard: true };
}

function modeKeyboard() {
  return {
    keyboard: [["⚡ TURBO", "🐢 NORMAL"], ["❌ Cancelar"]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

async function beginActivationFlow(bot, chatId) {
  setFlow(chatId, { type: "activate_code", step: "code" });
  await bot.sendMessage(chatId, "Envíame tu código de activación (ejemplo: A1B2C3D4).", {
    reply_markup: cancelKeyboard(),
  });
}

async function beginStartFlow(bot, chatId) {
  setFlow(chatId, { type: "start_config", step: "dni", data: {} });
  await bot.sendMessage(chatId, "Vamos paso a paso.\n1/3 Envíame tu DNI (solo números).", {
    reply_markup: cancelKeyboard(),
  });
}

async function handleFlowInput(bot, msg) {
  const chatId = msg.chat.id;
  const admin = isAdmin(chatId);
  const flow = getFlow(chatId);
  const text = String(msg.text || "").trim();
  if (!flow || !text) return false;
  const lowered = text.toLowerCase();

  if (lowered === "/cancel" || text === "❌ Cancelar") {
    clearFlow(chatId);
    await bot.sendMessage(chatId, "Operación cancelada.", { reply_markup: userKeyboard(admin) });
    return true;
  }

  if (text.startsWith("/")) return false;

  
  if (flow.type === "cron_time") {
    const time = text.trim();
    if (!/^\d{2}:\d{2}$/.test(time)) {
      await bot.sendMessage(chatId, "Formato inválido. Usa HH:mm (ejemplo 07:00).", { reply_markup: cancelKeyboard() });
      return true;
    }
    clearFlow(chatId);

    const u = ensureUserAutoRun(chatId);
    u.autoRun.time = time;
    saveState();
    setupUserCron(chatId);

    const startAt = subtractMinutesFromTime(time, AUTO_PRESTART_MINUTES) || time;
    await bot.sendMessage(
      chatId,
      `✅ Hora objetivo actualizada a ${time} (Perú).\nEl bot arrancará a las ${startAt} (pre-arranque ${AUTO_PRESTART_MINUTES} min).`,
      { reply_markup: userKeyboard(admin) }
    );
    return true;
  }

  if (flow.type === "cron_credentials") {
    if (flow.step === "dni") {
      const dni = text.replace(/\D/g, "");
      if (dni.length < 8 || dni.length > 12) {
        await bot.sendMessage(chatId, "DNI inválido. Debe tener entre 8 y 12 dígitos.", { reply_markup: cancelKeyboard() });
        return true;
      }
      flow.data.dni = dni;
      flow.step = "codigo";
      setFlow(chatId, flow);
      await bot.sendMessage(chatId, "2/2 Envíame tu código (ejemplo: 2023200615D).", { reply_markup: cancelKeyboard() });
      return true;
    }
    if (flow.step === "codigo") {
      const codigo = text.trim();
      if (codigo.length < 4) {
        await bot.sendMessage(chatId, "Código inválido.", { reply_markup: cancelKeyboard() });
        return true;
      }
      clearFlow(chatId);
      const u = ensureUserAutoRun(chatId);
      u.autoRun.dni = flow.data.dni;
      u.autoRun.codigo = codigo;
      saveState();
      setupUserCron(chatId);
      await bot.sendMessage(chatId, `✅ Credenciales guardadas. DNI: ${flow.data.dni}, Código: ${codigo}`, { reply_markup: userKeyboard(admin) });
      return true;
    }
  }

  if (flow.type === "activate_code") {
    const result = activateCode(chatId, text);
    clearFlow(chatId);
    if (!result.ok) {
      await bot.sendMessage(chatId, `❌ ${result.reason}`, { reply_markup: userKeyboard(admin) });
      return true;
    }
    await bot.sendMessage(chatId, `✅ Licencia activada por ${result.days} días.\nVence: ${result.user.expiresAt}`, {
      reply_markup: userKeyboard(admin),
    });
    return true;
  }

  if (flow.type === "start_config") {
    if (flow.step === "dni") {
      const dni = text.replace(/\D/g, "");
      if (dni.length < 8 || dni.length > 12) {
        await bot.sendMessage(chatId, "DNI inválido. Debe tener entre 8 y 12 dígitos.", {
          reply_markup: cancelKeyboard(),
        });
        return true;
      }
      flow.data.dni = dni;
      flow.step = "codigo";
      setFlow(chatId, flow);
      await bot.sendMessage(chatId, "2/3 Envíame tu código (ejemplo: 2023200615D).", {
        reply_markup: cancelKeyboard(),
      });
      return true;
    }

    if (flow.step === "codigo") {
      const codigo = text.trim();
      if (codigo.length < 4) {
        await bot.sendMessage(chatId, "Código inválido. Debe tener al menos 4 caracteres.", {
          reply_markup: cancelKeyboard(),
        });
        return true;
      }
      flow.data.codigo = codigo;
      flow.step = "modo";
      setFlow(chatId, flow);
      await bot.sendMessage(chatId, "3/3 Elige modo de ejecución:", { reply_markup: modeKeyboard() });
      return true;
    }

    if (flow.step === "modo") {
      let turboMode = null;
      const modeText = text.toUpperCase();
      if (modeText.includes("TURBO")) turboMode = true;
      if (modeText.includes("NORMAL")) turboMode = false;
      if (turboMode === null) {
        await bot.sendMessage(chatId, "Elige una opción: ⚡ TURBO o 🐢 NORMAL.", {
          reply_markup: modeKeyboard(),
        });
        return true;
      }
      const dni = flow.data.dni || "";
      const codigo = flow.data.codigo || "";
      clearFlow(chatId);
      const result = startBot(chatId, {
        dni,
        codigo,
        turboMode,
        maxAttempts: DEFAULTS.maxAttempts,
        retryDelayMs: DEFAULTS.retryDelayMs,
      });
      if (!result.started) {
        await bot.sendMessage(chatId, `No se pudo iniciar: ${result.reason}`, { reply_markup: userKeyboard(admin) });
        return true;
      }
      await bot.sendMessage(
        chatId,
        `🚀 Bot iniciado con configuración guiada.\nJob: ${result.jobId}\nPID: ${result.pid}\nDNI: ${dni}\nCódigo: ${codigo}\nModo: ${
          turboMode ? "TURBO" : "NORMAL"
        }\nActivos: ${result.runningGlobal}/${MAX_PARALLEL_JOBS}\n\n⏳ *Procesando...*\nEl bot está interactuando con la página web y buscando cupo.\n_Espera unos segundos, recibirás un reporte al terminar._`,
        { reply_markup: userKeyboard(admin) }
      );
      return true;
    }
  }

  return false;
}

async function onCommand(bot, msg, command, args) {
  const chatId = msg.chat.id;
  const admin = isAdmin(chatId);
  const access = requireUseAccess(chatId);

  if (command === "/hacer_admin") {
    if (adminChatId()) {
      await bot.sendMessage(chatId, "Ya existe un admin configurado.");
      return;
    }
    settings.adminChatId = String(chatId);
    saveState();
    await bot.sendMessage(chatId, "✅ Ahora eres el admin principal.", { reply_markup: userKeyboard(true) });
    return;
  }

  if (command === "/start" || command === "/menu") {
    clearFlow(chatId);
    const onboarding = hasActiveLicense(chatId)
      ? "✅ Ya puedes usar 🚀 Iniciar o configurar tu automático en ⏰ Auto."
      : "🔐 Para comenzar: usa /activar y pega tu código de licencia.";
    const welcome = [
      "👋 *Bienvenido al bot Charola*",
      "─────────────────",
      licenseStatusText(chatId),
      admin ? "👑 _Modo administrador habilitado_" : "",
      onboarding,
      "",
      "👇 *Selecciona una opción del menú inferior*",
      "_O escribe /help para ver todos los comandos._",
    ]
      .filter(Boolean)
      .join("\n");
    await bot.sendMessage(chatId, welcome, { parse_mode: "Markdown", reply_markup: userKeyboard(admin) });
    return;
  }

  
  if (command === "/menu_tarea") {
    if (!hasActiveLicense(chatId)) {
      await bot.sendMessage(chatId, "No tienes licencia activa.");
      return;
    }
    ensureUserAutoRun(chatId);
    saveState();
    await renderAutoMenu(bot, chatId);
    return;
  }

  if (command === "/cancel") {
    clearFlow(chatId);
    await bot.sendMessage(chatId, "Operación cancelada.", { reply_markup: userKeyboard(admin) });
    return;
  }

  if (command === "/help" || command === "/ayuda") {
    await bot.sendMessage(chatId, helpText(admin), { reply_markup: userKeyboard(admin) });
    return;
  }

  if (command === "/myid") {
    await bot.sendMessage(chatId, `Tu chat_id: ${chatId}`, { reply_markup: userKeyboard(admin) });
    return;
  }

  if (command === "/mi_licencia") {
    await bot.sendMessage(chatId, licenseStatusText(chatId), { reply_markup: userKeyboard(admin) });
    return;
  }

  if (command === "/activar") {
    const code = args[0];
    if (!code) {
      await beginActivationFlow(bot, chatId);
      return;
    }
    const result = activateCode(chatId, code);
    if (!result.ok) {
      await bot.sendMessage(chatId, `❌ ${result.reason}`);
      return;
    }
    await bot.sendMessage(chatId, `✅ Licencia activada por ${result.days} días.\nVence: ${result.user.expiresAt}`, {
      reply_markup: userKeyboard(admin),
    });
    return;
  }

  if (command === "/status") {
    if (!access.ok && !admin) {
      await bot.sendMessage(chatId, access.message, { reply_markup: userKeyboard(admin) });
      return;
    }
    await sendStatus(bot, chatId);
    return;
  }

  if (command === "/diagnostico") {
    if (!access.ok && !admin) {
      await bot.sendMessage(chatId, access.message, { reply_markup: userKeyboard(admin) });
      return;
    }
    await sendDiagnostics(bot, chatId);
    return;
  }

  if (command === "/mis_procesos") {
    if (!access.ok && !admin) {
      await bot.sendMessage(chatId, access.message, { reply_markup: userKeyboard(admin) });
      return;
    }
    await sendOwnJobs(bot, chatId);
    return;
  }

  if (command === "/foto") {
    if (!access.ok) {
      await bot.sendMessage(chatId, access.message);
      return;
    }
    await sendLastPhoto(bot, chatId);
    return;
  }

  if (command === "/iniciar") {
    if (!access.ok) {
      await bot.sendMessage(chatId, access.message);
      return;
    }
    const u = ensureUserAutoRun(chatId);
    let dni, codigo, turboMode;

    if (args.length === 1) {
      await bot.sendMessage(chatId, "Uso: /iniciar [dni] [codigo] [turbo|normal]\nO usa ⚙️ Configurar inicio.", {
        reply_markup: userKeyboard(admin),
      });
      return;
    }

    if (args.length >= 2) {
      [dni, codigo] = args;
      turboMode = DEFAULTS.turboMode;
      if (args.length >= 3) {
        if (args[2].toLowerCase() === "normal") turboMode = false;
        if (args[2].toLowerCase() === "turbo") true; // Typo fix
        if (args[2].toLowerCase() === "turbo") turboMode = true;
      }
    } else {
      if (!hasAutoCredentials(u.autoRun)) {
        await bot.sendMessage(chatId, "❌ No tienes credenciales guardadas.\nPor favor, usa ⚙️ Configurar, o ve a ⏰ Auto -> 🔑 Credenciales.", { reply_markup: userKeyboard(admin) });
        return;
      }
      dni = u.autoRun.dni;
      codigo = u.autoRun.codigo;
      turboMode = u.autoRun.turboMode !== false;
    }
    const result = startBot(chatId, {
      dni,
      codigo,
      turboMode,
      maxAttempts: DEFAULTS.maxAttempts,
      retryDelayMs: DEFAULTS.retryDelayMs,
    });
    if (!result.started) {
      await bot.sendMessage(chatId, result.reason);
      return;
    }
    await bot.sendMessage(
      chatId,
      `🚀 Bot iniciado.\nJob: ${result.jobId}\nPID: ${result.pid}\nModo: ${
        turboMode ? "TURBO" : "NORMAL"
      }\nActivos: ${result.runningGlobal}/${MAX_PARALLEL_JOBS}\n\n⏳ *Procesando...*\nEl bot está interactuando con la página web y buscando cupo.\n_Espera unos segundos, recibirás un reporte al terminar._`,
    );
    return;
  }

  if (command === "/config_iniciar") {
    if (!access.ok) {
      await bot.sendMessage(chatId, access.message, { reply_markup: userKeyboard(admin) });
      return;
    }
    await beginStartFlow(bot, chatId);
    return;
  }

  if (command === "/detener") {
    if (!access.ok) {
      await bot.sendMessage(chatId, access.message);
      return;
    }
    const stopAll = admin && args[0] && ["all", "todos"].includes(String(args[0]).toLowerCase());
    const result = await stopJobs(chatId, stopAll);
    if (!result.stopped) {
      await bot.sendMessage(chatId, result.reason || "No se pudieron detener procesos.");
      return;
    }
    await bot.sendMessage(
      chatId,
      `🛑 Procesos detenidos: ${result.stoppedCount}/${result.total}${
        result.failedCount ? ` | fallidos: ${result.failedCount}` : ""
      }`
    );
    return;
  }

  if (!adminRequired(chatId)) {
    await bot.sendMessage(chatId, "⛔ Este comando es solo para admin.");
    return;
  }

  if (command === "/admin") {
    await sendAdminPanelHint(bot, chatId);
    return;
  }

  if (command === "/limpiar_capturas") {
    const result = clearRunCaptures();
    await bot.sendMessage(
      chatId,
      result.removed
        ? `🧹 Capturas eliminadas: ${result.removed}\nEspacio liberado: ${result.formatted}`
        : "🧹 No había capturas para eliminar."
    );
    return;
  }

  if (command === "/set_admin") {
    const newAdmin = args[0];
    if (!newAdmin) {
      await bot.sendMessage(chatId, "Usa: /set_admin <chat_id>");
      return;
    }
    settings.adminChatId = String(newAdmin);
    saveState();
    await bot.sendMessage(chatId, `✅ Admin cambiado a ${newAdmin}`);
    return;
  }

  if (command === "/crear_licencia") {
    const days = safeNumber(args[0], 30);
    const qty = safeNumber(args[1], 1);
    const codes = generateLicenseCode(days, qty, chatId);
    await bot.sendMessage(chatId, `✅ Códigos creados (${days} días):\n${codes.join("\n")}`);
    return;
  }

  if (command === "/dar_licencia") {
    const target = args[0];
    const days = safeNumber(args[1], 30);
    if (!target) {
      await bot.sendMessage(chatId, "Usa: /dar_licencia <chat_id> <dias>");
      return;
    }
    const user = grantLicense(target, days, chatId, "manual-admin");
    await bot.sendMessage(chatId, `✅ Licencia otorgada a ${target}\nVence: ${user.expiresAt}`);
    return;
  }

  if (command === "/quitar_licencia") {
    const target = args[0];
    if (!target) {
      await bot.sendMessage(chatId, "Usa: /quitar_licencia <chat_id>");
      return;
    }
    revokeLicense(target);
    await bot.sendMessage(chatId, `✅ Licencia revocada a ${target}`);
    return;
  }

  if (command === "/licencias") {
    const users = listActiveUsers().slice(0, 20);
    if (!users.length) {
      await bot.sendMessage(chatId, "No hay licencias activas.");
      return;
    }
    const text = users
      .map((u) => `- ${u.chatId} | @${u.username || "-"} | vence ${u.expiresAt}`)
      .join("\n");
    await bot.sendMessage(chatId, `Licencias activas (top 20):\n${text}`);
    return;
  }

  if (command === "/crear_tarea") {
    const hour = args[0] && /^\d{2}:\d{2}$/.test(args[0]) ? args[0] : "07:00";
    const r = await ensureTaskAt(hour);
    if (!r.ok) {
      await bot.sendMessage(chatId, (r.stderr || r.stdout || "").trim() || "No se pudo crear tarea");
      return;
    }
    await bot.sendMessage(chatId, `✅ Tarea creada/actualizada a las ${hour}.`);
    return;
  }

  if (command === "/hora") {
    const hour = args[0];
    if (!hour || !/^\d{2}:\d{2}$/.test(hour)) {
      await bot.sendMessage(chatId, "Usa: /hora HH:mm  (ejemplo: /hora 06:58)");
      return;
    }
    const r = await ensureTaskAt(hour);
    if (!r.ok) {
      await bot.sendMessage(chatId, (r.stderr || r.stdout || "").trim() || "No se pudo cambiar hora");
      return;
    }
    await bot.sendMessage(chatId, `✅ Hora actualizada a ${hour}.`);
    return;
  }

  if (command === "/ejecutar") {
    const r = await runTaskCommand(["/Run", "/TN", TASK_NAME]);
    if (!r.ok) {
      await bot.sendMessage(chatId, (r.stderr || r.stdout || "").trim() || "No se pudo ejecutar");
      return;
    }
    await bot.sendMessage(chatId, "✅ Tarea ejecutada.");
    return;
  }

  if (command === "/parar_tarea") {
    const r = await runTaskCommand(["/End", "/TN", TASK_NAME]);
    if (!r.ok) {
      await bot.sendMessage(chatId, (r.stderr || r.stdout || "").trim() || "No se pudo detener tarea");
      return;
    }
    await bot.sendMessage(chatId, "✅ Tarea detenida.");
    return;
  }

  if (command === "/habilitar") {
    const r = await runTaskCommand(["/Change", "/TN", TASK_NAME, "/ENABLE"]);
    if (!r.ok) {
      await bot.sendMessage(chatId, (r.stderr || r.stdout || "").trim() || "No se pudo habilitar");
      return;
    }
    await bot.sendMessage(chatId, "✅ Tarea habilitada.");
    return;
  }

  if (command === "/deshabilitar") {
    const r = await runTaskCommand(["/Change", "/TN", TASK_NAME, "/DISABLE"]);
    if (!r.ok) {
      await bot.sendMessage(chatId, (r.stderr || r.stdout || "").trim() || "No se pudo deshabilitar");
      return;
    }
    await bot.sendMessage(chatId, "✅ Tarea deshabilitada.");
    return;
  }

  await bot.sendMessage(chatId, "Comando no reconocido. Usa /help o /menu.", { reply_markup: userKeyboard(admin) });
}

function normalizeIncomingCommand(msg) {
  if (!msg.text) return "";
  const t = msg.text.trim();
  const mapping = {
    "🚀 Iniciar": "/iniciar",
    "⚙️ Configurar": "/config_iniciar",
    "📊 Estado": "/status",
    "🧵 Procesos": "/mis_procesos",
    "🛑 Detener": "/detener",
    "🖼️ Foto": "/foto",
    "🔐 Licencia": "/mi_licencia",
    "❓ Ayuda": "/help",
    "🆔 Mi ID": "/myid",
    "🛠️ Admin": "/admin",
    "📋 Licencias": "/licencias",
    "🧹 Limpiar": "/limpiar_capturas",
    "⏰ Auto": "/menu_tarea",
    "❌ Cancelar": "/cancel",
  };
  return mapping[t] || t;
}

const pollingIntervalMs = safeNumber(process.env.TELEGRAM_POLLING_INTERVAL_MS, 1000);
const pollingTimeoutSec = safeNumber(process.env.TELEGRAM_POLLING_TIMEOUT_S, 30);
const pollingRetryBaseMs = safeNumber(process.env.TELEGRAM_POLLING_RETRY_MS, 5000);
const pollingRetryMaxMs = safeNumber(process.env.TELEGRAM_POLLING_RETRY_MAX_MS, 60000);
let pollingRetryMs = pollingRetryBaseMs;
let pollingRestartTimer = null;
let pollingStarting = false;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: {
    autoStart: false,
    interval: pollingIntervalMs,
    params: { timeout: pollingTimeoutSec },
  },
});
telegramBotClient = bot;

bot
  .setMyCommands([
    { command: "start", description: "Abrir menú" },
    { command: "menu", description: "Mostrar botones" },
    { command: "status", description: "Ver estado" },
    { command: "diagnostico", description: "Ver diagnóstico rápido" },
    { command: "mis_procesos", description: "Ver procesos activos" },
    { command: "iniciar", description: "Iniciar rápido" },
    { command: "config_iniciar", description: "Iniciar paso a paso" },
    { command: "menu_tarea", description: "Configurar automático" },
    { command: "detener", description: "Detener tus procesos" },
    { command: "limpiar_capturas", description: "Borrar capturas (admin)" },
    { command: "mi_licencia", description: "Estado de licencia" },
    { command: "activar", description: "Activar licencia por código" },
    { command: "myid", description: "Ver chat_id" },
    { command: "cancel", description: "Cancelar flujo en curso" },
    { command: "help", description: "Ayuda" },
  ])
  .catch(() => {});

async function startPolling(origin = "startup") {
  if (pollingStarting) return;
  pollingStarting = true;
  try {
    await bot.startPolling();
    pollingRetryMs = pollingRetryBaseMs;
    console.log(`Polling Telegram activo (${origin}).`);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error(`No se pudo iniciar polling (${origin}):`, message);
    schedulePollingRestart("start-failed");
  } finally {
    pollingStarting = false;
  }
}

function schedulePollingRestart(reason = "unknown") {
  if (pollingRestartTimer) return;
  const delay = Math.min(pollingRetryMs, pollingRetryMaxMs);
  console.error(`Reintentando polling en ${delay}ms (${reason}).`);
  pollingRestartTimer = setTimeout(async () => {
    pollingRestartTimer = null;
    try {
      await bot.stopPolling({ cancel: true });
    } catch {}
    await startPolling("retry");
  }, delay);
  pollingRetryMs = Math.min(pollingRetryMaxMs, Math.max(pollingRetryBaseMs, pollingRetryMs * 2));
}

bot.on("message", async (msg) => {
  if (!chatAllowed(msg)) return;
  updateUserProfile(msg);

  try {
    if (await handleFlowInput(bot, msg)) return;
  } catch (error) {
    try {
      await bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    } catch {}
    return;
  }

  const normalized = normalizeIncomingCommand(msg);
  if (!normalized || !normalized.startsWith("/")) return;
  const { command, args } = parseCommand(normalized);
  onCommand(bot, msg, command, args).catch(async (error) => {
    try {
      await bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    } catch {}
  });
});


bot.on("callback_query", async (query) => {
  if (!query.message || !query.message.chat) {
    await bot.answerCallbackQuery(query.id, { text: "No se pudo procesar el botón." }).catch(() => {});
    return;
  }
  const chatId = query.message.chat.id;
  if (!hasActiveLicense(chatId)) return bot.answerCallbackQuery(query.id, { text: "No tienes licencia activa.", show_alert: true });

  const data = query.data;
  const u = ensureUserAutoRun(chatId);

  try {
    if (data === "cron_enable") {
      if (!hasAutoCredentials(u.autoRun)) {
        await bot.answerCallbackQuery(query.id, { text: "Primero configura DNI/Código.", show_alert: true });
        await bot.sendMessage(chatId, "Antes de habilitar automático, añade una cuenta en ⏰ Auto -> ➕ Añadir Cuenta.");
        await renderAutoMenu(bot, chatId, query.message.message_id);
        return;
      }
      u.autoRun.enabled = true;
      saveState();
      setupUserCron(chatId);
      await bot.answerCallbackQuery(query.id, { text: "Tarea habilitada." });
      await renderAutoMenu(bot, chatId, query.message.message_id);
    } else if (data === "cron_disable") {
      u.autoRun.enabled = false;
      saveState();
      setupUserCron(chatId);
      await bot.answerCallbackQuery(query.id, { text: "Tarea deshabilitada." });
      await renderAutoMenu(bot, chatId, query.message.message_id);
    } else if (data === "cron_time") {
      setFlow(chatId, { type: "cron_time", step: "time" });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        `Envíame la nueva hora objetivo en formato HH:mm (ejemplo: 07:00). El bot arrancará ${AUTO_PRESTART_MINUTES} minutos antes.`,
        { reply_markup: cancelKeyboard() }
      );
    } else if (data === "cron_credentials") {
      setFlow(chatId, { type: "cron_credentials", step: "dni", data: {} });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, "Vamos a configurar tus datos automáticos.\n1/2 Envíame tu DNI (solo números).", { reply_markup: cancelKeyboard() });
    } else if (data === "cron_view_accounts") {
      const accs = u.autoRun.accounts || [];
      if (!accs.length) {
        await bot.answerCallbackQuery(query.id, { text: "No hay cuentas registradas.", show_alert: true });
        return;
      }
      const list = accs.map((a, i) => `${i + 1}. DNI: ${a.dni}`).join("\n");
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, `📋 *Tus cuentas registradas:*\n\n${list}`, { parse_mode: "Markdown" });
    } else if (data === "cron_clear_accounts") {
      u.autoRun.accounts = [];
      saveState();
      await bot.answerCallbackQuery(query.id, { text: "Todas las cuentas eliminadas.", show_alert: true });
      await renderAutoMenu(bot, chatId, query.message.message_id);
    } else if (data === "cron_mode") {
      u.autoRun.turboMode = !u.autoRun.turboMode;
      saveState();
      await bot.answerCallbackQuery(query.id, { text: `Modo cambiado a ${u.autoRun.turboMode ? "TURBO" : "NORMAL"}` });
      await renderAutoMenu(bot, chatId, query.message.message_id);
    } else if (data === "cron_run_now") {
      if (!hasAutoCredentials(u.autoRun)) {
        await bot.answerCallbackQuery(query.id, { text: "Faltan credenciales.", show_alert: true });
        await bot.sendMessage(chatId, "Configura primero DNI/Código en ⏰ Auto -> 🔑 Credenciales.");
        return;
      }
      const result = startBot(chatId, {
        dni: u.autoRun.dni,
        codigo: u.autoRun.codigo,
        turboMode: u.autoRun.turboMode !== false,
        maxAttempts: DEFAULTS.maxAttempts,
        retryDelayMs: DEFAULTS.retryDelayMs,
      });
      if (!result.started) {
        await bot.answerCallbackQuery(query.id, { text: "No se pudo iniciar.", show_alert: true });
        await bot.sendMessage(chatId, `No se pudo iniciar la prueba automática: ${result.reason}`);
        return;
      }
      await bot.answerCallbackQuery(query.id, { text: "Prueba iniciada." });
      await bot.sendMessage(
        chatId,
        `▶️ Prueba automática iniciada.\nJob: ${result.jobId}\nPID: ${result.pid}\nModo: ${u.autoRun.turboMode ? "TURBO" : "NORMAL"}`
      );
      await renderAutoMenu(bot, chatId, query.message.message_id);
    }
  } catch (err) {
    console.error(err);
  }
});
bot.on("polling_error", (error) => {
  const message = String(error && error.message ? error.message : error);
  console.error("Polling error:", message);
  if (/409|terminated by other getUpdates request/i.test(message)) {
    const now = Date.now();
    if (now - lastDuplicatePollingAlertMs > 10 * 60 * 1000) {
      lastDuplicatePollingAlertMs = now;
      const adminId = adminChatId();
      if (adminId && telegramBotClient) {
        telegramBotClient
          .sendMessage(
            adminId,
            "⚠️ Detecté conflicto 409 de Telegram: hay otra instancia usando el mismo token.\nApaga la otra instancia o reinicia PM2 del servidor correcto."
          )
          .catch(() => {});
      }
    }
    schedulePollingRestart("duplicate-instance");
    return;
  }
  if (/(ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|429|502|503|504|network)/i.test(message)) {
    schedulePollingRestart("network");
  }
});

const app = express();
app.use(express.json());
app.use("/", express.static(PANEL_DIR));

function panelAuth(req, res, next) {
  const key = String(req.headers["x-admin-key"] || req.query.key || "");
  if (key !== PANEL_KEY) {
    return res.status(401).json({ ok: false, message: "No autorizado" });
  }
  return next();
}

app.get("/api/admin/summary", panelAuth, async (_req, res) => {
  const activeUsers = listActiveUsers();
  const totalCodes = Object.keys(licenses.codes).length;
  const availableCodes = Object.values(licenses.codes).filter((c) => !c.usedBy && !c.revokedAt).length;
  const usedCodes = Object.values(licenses.codes).filter((c) => c.usedBy).length;
  const task = await getTaskStatus();
  res.json({
    ok: true,
    adminChatId: adminChatId(),
    panelPort: activePanelPort,
    panelUrl: panelPublicUrl(),
    botRunning: runningJobs.size > 0,
    runningJobs: runningJobs.size,
    maxParallelJobs: MAX_PARALLEL_JOBS,
    maxParallelPerChat: MAX_PARALLEL_JOBS_PER_CHAT,
    activeLicenses: activeUsers.length,
    totalCodes,
    availableCodes,
    usedCodes,
    task,
  });
});

app.get("/api/admin/users", panelAuth, (_req, res) => {
  const users = Object.values(licenses.users).sort((a, b) => {
    const ta = new Date(a.lastSeenAt || 0).getTime();
    const tb = new Date(b.lastSeenAt || 0).getTime();
    return tb - ta;
  });
  res.json({ ok: true, users });
});

app.get("/api/admin/codes", panelAuth, (_req, res) => {
  const codes = Object.values(licenses.codes).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
  res.json({ ok: true, codes });
});

app.post("/api/admin/create-codes", panelAuth, (req, res) => {
  const days = safeNumber(req.body && req.body.days, 30);
  const quantity = safeNumber(req.body && req.body.quantity, 1);
  const codes = generateLicenseCode(days, quantity, adminChatId() || "panel");
  res.json({ ok: true, days, quantity, codes });
});

app.post("/api/admin/grant-user", panelAuth, (req, res) => {
  const chatId = String((req.body && req.body.chatId) || "").trim();
  const days = safeNumber(req.body && req.body.days, 30);
  if (!chatId) return res.status(400).json({ ok: false, message: "chatId requerido" });
  const user = grantLicense(chatId, days, adminChatId() || "panel", "panel");
  res.json({ ok: true, user });
});

app.post("/api/admin/revoke-user", panelAuth, (req, res) => {
  const chatId = String((req.body && req.body.chatId) || "").trim();
  if (!chatId) return res.status(400).json({ ok: false, message: "chatId requerido" });
  const user = revokeLicense(chatId);
  res.json({ ok: true, user });
});

app.post("/api/admin/revoke-code", panelAuth, (req, res) => {
  const code = String((req.body && req.body.code) || "").trim().toUpperCase();
  if (!licenses.codes[code]) return res.status(404).json({ ok: false, message: "Código no existe" });
  licenses.codes[code].revokedAt = nowIso();
  saveState();
  res.json({ ok: true });
});

app.post("/api/admin/clear-captures", panelAuth, (_req, res) => {
  const result = clearRunCaptures();
  res.json({ ok: true, ...result });
});

app.post("/api/admin/set-admin", panelAuth, (req, res) => {
  const newAdmin = String((req.body && req.body.chatId) || "").trim();
  if (!newAdmin) return res.status(400).json({ ok: false, message: "chatId requerido" });
  settings.adminChatId = newAdmin;
  saveState();
  res.json({ ok: true, adminChatId: newAdmin });
});

app.get("/api/admin/log-tail", panelAuth, (_req, res) => {
  const latestLog = latestLogPath();
  const latestRunningJob = listRunningJobs()[0] || null;
  const lastExit = recentExits[0] || null;
  res.json({
    ok: true,
    path: latestLog || null,
    tail: latestLog ? tailFile(latestLog, 40) : "",
    botRunning: runningJobs.size > 0,
    runningJobs: runningJobs.size,
    startedAt: latestRunningJob ? latestRunningJob.startedAt : null,
    lastExit,
  });
});

function startPanelServer(port, retriesLeft = 8) {
  const server = app.listen(port);
  server.once("listening", () => {
    activePanelPort = port;
    console.log(`Panel admin: ${panelPublicUrl()}`);
  });
  server.once("error", (error) => {
    if (error && error.code === "EADDRINUSE" && retriesLeft > 0) {
      const nextPort = port + 1;
      console.error(`Puerto ${port} ocupado. Reintentando panel en ${nextPort}...`);
      startPanelServer(nextPort, retriesLeft - 1);
      return;
    }
    console.error(`No se pudo iniciar panel admin: ${error.message}`);
  });
}

console.log("Bot Telegram con licencias iniciado.");
console.log(`Proyecto: ${BASE_DIR}`);
console.log(`Tarea: ${TASK_NAME}`);
console.log(`SO detectado: ${process.platform}`);
console.log(`Admin actual: ${adminChatId() || "(no configurado, usa /hacer_admin)"}`);
console.log(`PANEL_KEY: ${PANEL_KEY}`);
if (!TELEGRAM_ALLOWED_CHAT_ID) {
  console.log("Aviso: TELEGRAM_ALLOWED_CHAT_ID no configurado; cualquier chat puede escribir.");
}
if (!IS_WINDOWS) {
  console.log("Aviso: comandos de tarea programada de Windows deshabilitados en este sistema.");
}

startPanelServer(PANEL_PORT);

function killZombies() {
  for (const job of runningJobs.values()) {
    try {
      if (job.process) job.process.kill();
    } catch (e) {}
  }
}

async function gracefulShutdown(signal) {
  console.log(`Recibido ${signal}, cerrando conexiones...`);
  killZombies();
  try {
    console.log("Deteniendo polling de Telegram...");
    await bot.stopPolling();
    console.log("Polling de Telegram detenido correctamente.");
  } catch (err) {
    console.error("Error al detener polling:", err.message);
  }
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

startPolling("startup").catch((error) => {
  console.error("Error iniciando polling:", error.message);
  schedulePollingRestart("startup-catch");
});
