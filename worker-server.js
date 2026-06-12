/**
 * worker-server.js — Servidor Express para VPS workers
 * 
 * Corre en cada worker VPS ($6/mes). Recibe cuentas del coordinador,
 * ejecuta charola-engine.js, y devuelve resultados.
 * 
 * Endpoints:
 *   POST /execute  → Ejecutar cuentas
 *   GET  /health   → Health check
 *   GET  /status   → Estado de ejecución actual
 *   POST /abort    → Cancelar ejecución en curso
 * 
 * Configuración via .env:
 *   WORKER_PORT=4000
 *   WORKER_API_KEY=<shared-key>
 *   WORKER_ID=worker-1
 */

const path = require("path");

// Cargar .env si existe
try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch (e) {
  // dotenv no es obligatorio si las variables están en el entorno
}

const express = require("express");
const { executeRawBatch } = require("./charola-engine");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.WORKER_PORT || 4000;
const API_KEY = process.env.WORKER_API_KEY || "dev-key";
const WORKER_ID = process.env.WORKER_ID || "worker-unknown";

// Estado global del worker
let currentExecution = null;
let lastExecution = null;
const startTime = Date.now();

// ── Middleware de autenticación ──
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized", workerId: WORKER_ID });
  }
  next();
}

app.use(authMiddleware);

// ══════════════════════════════════════════
// GET /health — Health check
// ══════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    workerId: WORKER_ID,
    uptime: Math.round((Date.now() - startTime) / 1000),
    running: currentExecution !== null,
    lastExecution: lastExecution ? {
      jobId: lastExecution.jobId,
      completedAt: lastExecution.completedAt,
      successes: lastExecution.result?.successes,
      total: lastExecution.result?.total
    } : null,
    timestamp: new Date().toISOString()
  });
});

// ══════════════════════════════════════════
// GET /status — Estado de ejecución actual
// ══════════════════════════════════════════
app.get("/status", (req, res) => {
  if (!currentExecution) {
    return res.json({
      workerId: WORKER_ID,
      running: false,
      lastExecution: lastExecution ? {
        jobId: lastExecution.jobId,
        result: lastExecution.result,
        completedAt: lastExecution.completedAt
      } : null
    });
  }

  res.json({
    workerId: WORKER_ID,
    running: true,
    jobId: currentExecution.jobId,
    accounts: currentExecution.accountCount,
    startedAt: currentExecution.startedAt,
    elapsedMs: Date.now() - new Date(currentExecution.startedAt).getTime()
  });
});

// ══════════════════════════════════════════
// POST /execute — Ejecutar cuentas
// ══════════════════════════════════════════
app.post("/execute", async (req, res) => {
  const { jobId, accounts, config } = req.body;

  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: "No accounts provided", workerId: WORKER_ID });
  }

  console.log(`\n[WORKER:${WORKER_ID}] ════════════════════════════════`);
  console.log(`[WORKER:${WORKER_ID}] Job: ${jobId}`);
  console.log(`[WORKER:${WORKER_ID}] Cuentas: ${accounts.length}`);
  console.log(`[WORKER:${WORKER_ID}] Config: ${JSON.stringify(config || {})}`);
  console.log(`[WORKER:${WORKER_ID}] ════════════════════════════════\n`);

  currentExecution = {
    jobId,
    accountCount: accounts.length,
    startedAt: new Date().toISOString(),
    aborted: false
  };

  try {
    const result = await executeRawBatch(accounts, config || {});

    const response = {
      jobId,
      workerId: WORKER_ID,
      total: result.total,
      successes: result.successes,
      failures: result.failures,
      results: result.results,
      durationMs: result.durationMs
    };

    lastExecution = {
      jobId,
      result: response,
      completedAt: new Date().toISOString()
    };

    console.log(`[WORKER:${WORKER_ID}] Job ${jobId} completado: ${result.successes}/${result.total} éxitos en ${Math.round(result.durationMs / 1000)}s`);

    res.json(response);

  } catch (error) {
    console.error(`[WORKER:${WORKER_ID}] Error en job ${jobId}:`, error.message);
    res.status(500).json({
      error: error.message,
      workerId: WORKER_ID,
      jobId
    });
  } finally {
    currentExecution = null;
  }
});

// ══════════════════════════════════════════
// POST /abort — Cancelar ejecución
// ══════════════════════════════════════════
app.post("/abort", (req, res) => {
  if (!currentExecution) {
    return res.json({ message: "No execution running", workerId: WORKER_ID });
  }
  // Por ahora solo marca como abortado (el engine no soporta cancelación mid-flight)
  currentExecution.aborted = true;
  res.json({ message: "Abort signal sent", workerId: WORKER_ID, jobId: currentExecution.jobId });
});

// ── Iniciar servidor ──
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[WORKER:${WORKER_ID}] Servidor iniciado en puerto ${PORT}`);
  console.log(`[WORKER:${WORKER_ID}] Esperando instrucciones del coordinador...`);
});
