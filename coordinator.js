/**
 * coordinator.js — Distribuidor de cuentas entre workers
 * 
 * Corre en el VPS principal. Divide las cuentas entre los workers
 * disponibles y recopila resultados.
 * 
 * Uso desde telegram-bot.js:
 *   const { executeDistributed, healthCheckAll } = require("./coordinator");
 *   const result = await executeDistributed(accounts, config);
 * 
 * Uso desde CLI (test):
 *   node coordinator.js --test
 *   node coordinator.js --health
 */

const path = require("path");

// Cargar .env si existe
try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch (e) {
  // dotenv no es obligatorio
}

// ── Configuración de Workers ──
function getWorkerUrls() {
  const urls = [];
  for (let i = 1; i <= 10; i++) {
    const url = process.env[`WORKER_${i}_URL`];
    if (url) urls.push(url);
  }
  return urls;
}

function getApiKey() {
  return process.env.WORKER_API_KEY || "dev-key";
}

// ══════════════════════════════════════════
// Health Check — verificar que workers estén vivos
// ══════════════════════════════════════════
async function healthCheckAll() {
  const workerUrls = getWorkerUrls();
  const apiKey = getApiKey();
  const results = [];

  for (const url of workerUrls) {
    try {
      const res = await fetch(`${url}/health`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      results.push({ url, status: "online", ...data });
    } catch (e) {
      results.push({ url, status: "offline", error: e.message });
    }
  }

  return results;
}

// ══════════════════════════════════════════
// Distribuir cuentas equitativamente
// ══════════════════════════════════════════
function distributeAccounts(accounts, workerCount) {
  const groups = Array.from({ length: workerCount }, () => []);
  accounts.forEach((acc, i) => {
    groups[i % workerCount].push(acc);
  });
  return groups;
}

// ══════════════════════════════════════════
// Ejecutar distribuidamente en workers
// ══════════════════════════════════════════
async function executeDistributed(accounts, config = {}, onProgress = null) {
  const workerUrls = getWorkerUrls();
  const apiKey = getApiKey();
  const jobId = `exec-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startTime = Date.now();

  console.log(`[COORD] ═══════════════════════════════`);
  console.log(`[COORD] Job: ${jobId}`);
  console.log(`[COORD] Cuentas totales: ${accounts.length}`);
  console.log(`[COORD] Workers configurados: ${workerUrls.length}`);

  // 1. Health check
  console.log(`[COORD] Verificando workers...`);
  const health = await healthCheckAll();
  const onlineWorkers = health.filter(w => w.status === "online");
  const offlineWorkers = health.filter(w => w.status !== "online");

  for (const w of health) {
    console.log(`[COORD]   ${w.status === "online" ? "🟢" : "🔴"} ${w.url} → ${w.status} ${w.workerId ? `(${w.workerId})` : ""}`);
  }

  if (offlineWorkers.length > 0) {
    console.log(`[COORD] ⚠️ ${offlineWorkers.length} worker(s) offline: ${offlineWorkers.map(w => w.url).join(", ")}`);
  }

  // 2. Fallback: si no hay workers online, ejecutar localmente
  if (onlineWorkers.length === 0) {
    console.log(`[COORD] ❌ No hay workers online. Ejecutando LOCALMENTE...`);
    const { executeRawBatch } = require("./charola-engine");
    const result = await executeRawBatch(accounts, config);
    return {
      jobId,
      mode: "local-fallback",
      totalWorkers: 0,
      ...result,
      durationMs: Date.now() - startTime
    };
  }

  // 3. Distribuir cuentas
  const onlineUrls = onlineWorkers.map(w => w.url);
  const groups = distributeAccounts(accounts, onlineUrls.length);

  console.log(`[COORD] Distribución:`);
  onlineUrls.forEach((url, i) => {
    const workerName = onlineWorkers[i].workerId || `worker-${i + 1}`;
    console.log(`[COORD]   ${workerName} (${url}): ${groups[i].length} cuentas`);
  });

  // 4. Enviar a todos los workers en PARALELO
  console.log(`[COORD] Enviando a ${onlineUrls.length} workers simultáneamente...`);

  const workerPromises = onlineUrls.map(async (url, i) => {
    const workerName = onlineWorkers[i].workerId || `worker-${i + 1}`;
    const workerAccounts = groups[i];

    if (workerAccounts.length === 0) {
      return { workerId: workerName, url, total: 0, successes: 0, failures: 0, results: [], durationMs: 0 };
    }

    try {
      console.log(`[COORD] → Enviando ${workerAccounts.length} cuentas a ${workerName}...`);

      const res = await fetch(`${url}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          jobId: `${jobId}-${workerName}`,
          accounts: workerAccounts,
          config: {
            waveSize: config.waveSize || 4,
            waveDelayMs: config.waveDelayMs || 500,
            maxPostAttempts: config.maxPostAttempts || 150,
            retryDelayMs: config.retryDelayMs || 250,
            maxRescueAttempts: config.maxRescueAttempts || 80,
            rescueDelayMs: config.rescueDelayMs || 1000
          }
        }),
        signal: AbortSignal.timeout(900000) // 15 minutos timeout (warmup puede tardar hasta 10min)
      });

      const data = await res.json();
      console.log(`[COORD] ← ${workerName}: ${data.successes}/${data.total} éxitos (${Math.round(data.durationMs / 1000)}s)`);

      if (onProgress) onProgress({ workerId: workerName, ...data });

      return { workerId: workerName, url, ...data };

    } catch (e) {
      console.error(`[COORD] ← ${workerName}: ERROR — ${e.message}`);

      // Fallback: intentar ejecutar localmente las cuentas de este worker
      console.log(`[COORD] Ejecutando cuentas de ${workerName} LOCALMENTE como fallback...`);
      try {
        const { executeRawBatch } = require("./charola-engine");
        const localResult = await executeRawBatch(workerAccounts, config);
        return {
          workerId: `${workerName}-local-fallback`,
          url,
          total: localResult.total,
          successes: localResult.successes,
          failures: localResult.failures,
          results: localResult.results,
          durationMs: localResult.durationMs,
          fallback: true
        };
      } catch (e2) {
        return {
          workerId: workerName,
          url,
          error: e.message,
          total: workerAccounts.length,
          successes: 0,
          failures: workerAccounts.length,
          results: workerAccounts.map(a => ({
            success: false,
            dni: a.dni,
            nombre: a.nombre,
            reason: `Worker error: ${e.message}`
          })),
          durationMs: 0
        };
      }
    }
  });

  const workerResults = await Promise.all(workerPromises);

  // 5. Agregar resultados
  const allResults = [];
  let totalSuccesses = 0;
  let totalFailures = 0;

  for (const wr of workerResults) {
    if (wr.results) allResults.push(...wr.results);
    totalSuccesses += wr.successes || 0;
    totalFailures += wr.failures || 0;
  }

  const durationMs = Date.now() - startTime;

  // 6. Resumen
  console.log(`\n[COORD] ═══════════════════════════════`);
  console.log(`[COORD] RESUMEN FINAL`);
  console.log(`[COORD] Total: ${accounts.length} | Éxitos: ${totalSuccesses} | Fallos: ${totalFailures}`);
  console.log(`[COORD] Duración total: ${Math.round(durationMs / 1000)}s`);
  for (const wr of workerResults) {
    const icon = wr.error ? "🔴" : (wr.failures === 0 ? "🟢" : "🟡");
    console.log(`[COORD]   ${icon} ${wr.workerId}: ${wr.successes || 0}/${wr.total || 0} éxitos${wr.fallback ? " (fallback local)" : ""}`);
  }
  console.log(`[COORD] ═══════════════════════════════\n`);

  for (const r of allResults) {
    const label = r.nombre ? `${r.nombre} (${r.dni})` : `DNI: ${r.dni}`;
    if (r.success) {
      console.log(`[COORD]   ✅ ${label}`);
    } else {
      console.log(`[COORD]   ❌ ${label} → ${r.reason || "desconocido"}`);
    }
  }

  return {
    jobId,
    mode: "distributed",
    totalWorkers: onlineUrls.length,
    total: accounts.length,
    successes: totalSuccesses,
    failures: totalFailures,
    results: allResults,
    workerDetails: workerResults,
    durationMs
  };
}

// ══════════════════════════════════════════
// CLI: test y health check
// ══════════════════════════════════════════
if (require.main === module) {
  const arg = process.argv[2];

  if (arg === "--health") {
    healthCheckAll().then(results => {
      console.log("\n=== Health Check ===");
      for (const r of results) {
        console.log(`${r.status === "online" ? "🟢" : "🔴"} ${r.url} → ${r.status} ${r.workerId ? `(${r.workerId})` : ""} ${r.error || ""}`);
      }
      process.exit(0);
    });
  } else if (arg === "--test") {
    // Test con 1 cuenta ficticia (recibirá code=300 fuera de horario)
    console.log("Ejecutando test distribuido con 1 cuenta...");
    const testAccounts = [{ dni: "00000000", codigo: "TEST", nombre: "Test" }];
    executeDistributed(testAccounts, {}).then(result => {
      console.log("\nResultado:", JSON.stringify(result, null, 2));
      process.exit(0);
    });
  } else {
    console.log("Uso:");
    console.log("  node coordinator.js --health   → Verificar workers");
    console.log("  node coordinator.js --test     → Test con cuenta ficticia");
    process.exit(0);
  }
}

module.exports = {
  executeDistributed,
  healthCheckAll,
  distributeAccounts,
  getWorkerUrls
};
