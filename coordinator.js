/**
 * coordinator.js — Distribuidor de cuentas entre workers
 * 
 * Corre en el VPS principal. Divide las cuentas entre los workers
 * disponibles y recopila resultados.
 * 
 * Incluye integración con CapSolver para resolver Cloudflare Turnstile.
 */

const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch (e) {}

const TURNSTILE_SITEKEY = "0x4AAAAAADqlWZzvgyd1vKlq";
const TURNSTILE_URL = "https://comedor.uncp.edu.pe/charola";
const CAPSOLVER_API = "https://api.capsolver.com";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════
// CAPSOLVER: Generar pool de tokens Turnstile
// ══════════════════════════════════════════
async function createTurnstileTask(apiKey) {
  try {
    const res = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "AntiTurnstileTaskProxyLess",
          websiteURL: TURNSTILE_URL,
          websiteKey: TURNSTILE_SITEKEY
        }
      }),
      signal: AbortSignal.timeout(30000)
    });
    const json = await res.json();
    if (json.errorId !== 0) {
      console.log(`[CAPSOLVER] Error createTask: ${json.errorDescription}`);
      return null;
    }
    return json.taskId;
  } catch (e) {
    console.log(`[CAPSOLVER] Error createTask: ${e.message}`);
    return null;
  }
}

async function getTurnstileResult(apiKey, taskId) {
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    try {
      const res = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(15000)
      });
      const json = await res.json();
      if (json.status === "ready" && json.solution?.token) {
        return json.solution.token;
      }
      if (json.errorId !== 0 || json.status === "failed") {
        console.log(`[CAPSOLVER] Task ${taskId} falló: ${json.errorDescription}`);
        return null;
      }
    } catch (e) {
      // Timeout temporal, seguir intentando
    }
  }
  console.log(`[CAPSOLVER] Task ${taskId} timeout (90s)`);
  return null;
}

async function generateTurnstilePool(count, apiKey, log = console.log) {
  log(`[CAPSOLVER] Generando ${count} tokens Turnstile en paralelo...`);
  const startTime = Date.now();

  const taskPromises = [];
  for (let i = 0; i < count; i++) {
    taskPromises.push(
      (async () => {
        const taskId = await createTurnstileTask(apiKey);
        if (!taskId) return null;
        return getTurnstileResult(apiKey, taskId);
      })()
    );
  }

  const results = await Promise.all(taskPromises);
  const tokens = results.filter(t => t !== null);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  log(`[CAPSOLVER] ✅ ${tokens.length}/${count} tokens listos en ${elapsed}s (expiran en 5 min)`);
  return tokens;
}

// ══════════════════════════════════════════
// Health Check
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
      results.push({ url, ...data, status: "online" });
    } catch (e) {
      results.push({ url, status: "offline", error: e.message });
    }
  }

  return results;
}

// ══════════════════════════════════════════
// Intercalar cuentas por dueño
// ══════════════════════════════════════════
function interleaveByOwner(accounts) {
  const vipAccounts = [];
  const normalAccounts = [];
  
  for (const acc of accounts) {
    if (acc.nombre && acc.nombre.toLowerCase().includes('vip')) {
      vipAccounts.push(acc);
    } else {
      normalAccounts.push(acc);
    }
  }

  const byOwner = {};
  for (const acc of normalAccounts) {
    const key = acc.ownerChatId || 'default';
    if (!byOwner[key]) byOwner[key] = [];
    byOwner[key].push(acc);
  }
  
  const owners = Object.values(byOwner);
  let interleavedNormal = [];
  
  if (owners.length <= 1) {
    interleavedNormal = normalAccounts;
  } else {
    const maxLen = Math.max(...owners.map(o => o.length));
    for (let i = 0; i < maxLen; i++) {
      for (const ownerAccs of owners) {
        if (i < ownerAccs.length) interleavedNormal.push(ownerAccs[i]);
      }
    }
  }
  
  return [...vipAccounts, ...interleavedNormal];
}

// ══════════════════════════════════════════
// Distribuir cuentas equitativamente (round-robin)
// ══════════════════════════════════════════
function distributeAccounts(accounts, workerCount) {
  const groups = Array.from({ length: workerCount }, () => []);
  accounts.forEach((acc, i) => {
    groups[i % workerCount].push(acc);
  });
  return groups;
}

// ══════════════════════════════════════════
// Distribuir CON REDUNDANCIA
// ══════════════════════════════════════════
function distributeWithRedundancy(accounts, workerCount) {
  const groups = Array.from({ length: workerCount }, () => []);
  accounts.forEach((acc, i) => {
    const primary = i % workerCount;
    groups[primary].push({ ...acc, _redundancyRole: 'primary' });
  });
  return groups;
}

// ══════════════════════════════════════════
// Distribuir pool de turnstile entre workers
// ══════════════════════════════════════════
function distributeTurnstilePool(pool, groups) {
  const workerPools = Array.from({ length: groups.length }, () => []);
  let tokenIndex = 0;
  
  for (let w = 0; w < groups.length; w++) {
    let tokensNeeded = 0;
    for (const acc of groups[w]) {
      const isVip = acc.nombre && acc.nombre.toLowerCase().includes('vip');
      tokensNeeded += isVip ? 3 : 1;
    }
    tokensNeeded += Math.ceil(tokensNeeded * 0.15);
    
    for (let t = 0; t < tokensNeeded && tokenIndex < pool.length; t++) {
      workerPools[w].push(pool[tokenIndex++]);
    }
  }
  
  return workerPools;
}

// ══════════════════════════════════════════
// Ejecutar distribuidamente en workers
// ══════════════════════════════════════════
async function executeDistributed(accounts, config = {}, onProgress = null, logger = null) {
  const log = logger || ((...args) => console.log(...args));
  const logError = logger || ((...args) => console.error(...args));
  const workerUrls = getWorkerUrls();
  const apiKey = getApiKey();
  const jobId = `exec-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startTime = Date.now();

  log(`[COORD] ═══════════════════════════════`);
  log(`[COORD] Job: ${jobId}`);
  log(`[COORD] Cuentas totales: ${accounts.length}`);
  log(`[COORD] Workers configurados: ${workerUrls.length}`);

  // 1. Health check
  log(`[COORD] Verificando workers...`);
  const health = await healthCheckAll();
  const onlineWorkers = health.filter(w => w.status === "online");
  const offlineWorkers = health.filter(w => w.status !== "online");

  for (const w of health) {
    log(`[COORD]   ${w.status === "online" ? "🟢" : "🔴"} ${w.url} → ${w.status} ${w.workerId ? `(${w.workerId})` : ""}`);
  }

  if (offlineWorkers.length > 0) {
    log(`[COORD] ⚠️ ${offlineWorkers.length} worker(s) offline`);
  }

  if (onlineWorkers.length === 0) {
    log(`[COORD] ❌ No hay workers online. Ejecutando LOCALMENTE...`);
    const { executeRawBatch } = require("./charola-engine");
    const result = await executeRawBatch(accounts, config);
    return { jobId, mode: "local-fallback", totalWorkers: 0, ...result, durationMs: Date.now() - startTime };
  }

  // 2. GENERAR POOL DE TURNSTILE (solo si useTurnstile está activo)
  let turnstilePool = [];
  const useTurnstile = config.useTurnstile === true && config.capsolverApiKey;
  
  if (useTurnstile) {
    const vipCount = accounts.filter(a => a.nombre && a.nombre.toLowerCase().includes('vip')).length;
    const normalCount = accounts.length - vipCount;
    const totalTokens = (vipCount * 3 + normalCount) + Math.ceil((vipCount * 3 + normalCount) * 0.2);
    log(`[COORD] 🛡️ Modo Turnstile activo. Necesita ~${totalTokens} tokens (${vipCount} VIP×3 + ${normalCount} normales + 20% margen)`);
    
    turnstilePool = await generateTurnstilePool(totalTokens, config.capsolverApiKey, log);
    
    if (turnstilePool.length < accounts.length) {
      log(`[COORD] ⚠️ Solo se obtuvieron ${turnstilePool.length}/${totalTokens} tokens. Algunas cuentas pueden fallar.`);
    }
    
    // Verificar tiempo restante antes de que expiren (5 min)
    const elapsedGen = Math.round((Date.now() - startTime) / 1000);
    const remainingValidity = 300 - elapsedGen;
    log(`[COORD] ⏱️ Tokens válidos por ${remainingValidity}s más. Debe completar antes de que expiren.`);
  } else {
    log(`[COORD] ℹ️ Modo Turnstile DESACTIVADO (sin capsolverApiKey o useTurnstile=false)`);
  }

  // 3. WARMUP CENTRALIZADO
  log(`[COORD] Iniciando WARM-UP centralizado...`);
  const { warmUpWaitForApiOpen, getCsrfToken, generateFingerprint } = require("./charola-engine");
  const probeAccount = accounts[0];
  const maxWarmupMs = config.maxWarmupMs || 10 * 60 * 1000;
  
  const warmupConfig = {
    ...config,
    turnstilePool: turnstilePool.length > 0 ? turnstilePool : undefined,
  };
  
  const warmup = await warmUpWaitForApiOpen(probeAccount, maxWarmupMs, warmupConfig);
  if (warmup.probeSuccess) {
    log(`[COORD] ⚡ ¡API ABIERTA! Sonda (${probeAccount.dni}) asegurada. Disparando workers...`);
  } else {
    log(`[COORD] ⚠️ Warmup sin éxito confirmado. Disparando workers de todas formas...`);
  }

  // 4. Preparar cuentas para workers
  let accountsToDistribute = accounts;
  if (warmup.probeSuccess) {
    accountsToDistribute = accounts.filter(a => a.dni !== probeAccount.dni);
    log(`[COORD] Sonda excluida. ${accountsToDistribute.length} cuentas por distribuir.`);
  }
  accountsToDistribute = interleaveByOwner(accountsToDistribute);
  
  const onlineUrls = onlineWorkers.map(w => w.url);
  const groups = distributeWithRedundancy(accountsToDistribute, onlineUrls.length);

  // 5. Distribuir pool de turnstile entre workers
  let workerTurnstilePools = [];
  if (turnstilePool.length > 0) {
    workerTurnstilePools = distributeTurnstilePool(turnstilePool, groups);
  }

  log(`[COORD] Distribución:`);
  onlineUrls.forEach((url, i) => {
    const workerName = onlineWorkers[i].workerId || `worker-${i + 1}`;
    const ttCount = workerTurnstilePools[i] ? workerTurnstilePools[i].length : 0;
    log(`[COORD]   ${workerName} (${url}): ${groups[i].length} cuentas${ttCount > 0 ? `, ${ttCount} turnstile tokens` : ''}`);
  });

  // 6. CSRF token compartido (1 solo, reusable por 5 min)
  let sharedCsrfToken = warmup.csrfToken || null;
  if (!sharedCsrfToken && turnstilePool.length > 0) {
    sharedCsrfToken = await getCsrfToken();
    if (sharedCsrfToken) {
      log(`[COORD] 🎫 CSRF token compartido obtenido`);
    }
  }
  const sharedFingerprint = warmup.fingerprint || generateFingerprint();

  // 7. Enviar a workers
  log(`[COORD] Enviando a ${onlineUrls.length} workers simultáneamente...`);

  const workerPromises = onlineUrls.map(async (url, i) => {
    const workerName = onlineWorkers[i].workerId || `worker-${i + 1}`;
    const workerAccounts = groups[i];

    if (workerAccounts.length === 0) {
      return { workerId: workerName, url, total: 0, successes: 0, failures: 0, results: [], durationMs: 0 };
    }

    try {
      log(`[COORD] → ${workerName} con ${workerAccounts.length} cuentas...`);

      const workerConfig = {
        skipWarmup: true,
        maxPostAttempts: 60,
        retryDelayMs: 250,
        max500Retries: 3,
        delay500Ms: 2000,
        globalTimeoutMs: 25000,
        staggerMs: 15,
        staggerOffset: i * 2,
        cookies: warmup.cookies || null,
      };

      if (workerTurnstilePools[i] && workerTurnstilePools[i].length > 0) {
        workerConfig.turnstilePool = workerTurnstilePools[i];
        workerConfig._csrfToken = sharedCsrfToken;
        workerConfig._fingerprint = sharedFingerprint + '-' + (i + 1);
      }

      const res = await fetch(`${url}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          jobId: `${jobId}-${workerName}`,
          accounts: workerAccounts,
          config: workerConfig
        }),
        signal: AbortSignal.timeout(900000)
      });

      const startData = await res.json();
      if (!res.ok || startData.error) {
        throw new Error(`Worker falló: ${startData.error || res.statusText}`);
      }

      // Polling cada 1s
      const targetJobId = `${jobId}-${workerName}`;
      let finalData = null;
      
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const statRes = await fetch(`${url}/status`, {
            headers: { "Authorization": `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10000)
          });
          const stat = await statRes.json();
          
          if (stat.running === false && stat.lastExecution && stat.lastExecution.jobId === targetJobId) {
            finalData = stat.lastExecution.result;
            break;
          }
        } catch (pollErr) {
          // Ignorar timeouts de polling
        }
      }

      if (finalData.error) {
        throw new Error(`Worker error: ${finalData.error}`);
      }

      log(`[COORD] ← ${workerName}: ${finalData.successes}/${finalData.total} éxitos (${Math.round(finalData.durationMs / 1000)}s)`);
      if (onProgress) onProgress({ workerId: workerName, ...finalData });
      return { workerId: workerName, url, ...finalData };

    } catch (e) {
      logError(`[COORD] ← ${workerName}: ERROR — ${e.message}`);
      log(`[COORD] Fallback local para ${workerName}...`);
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
            success: false, dni: a.dni, nombre: a.nombre,
            reason: `Worker error: ${e.message}`
          })),
          durationMs: 0
        };
      }
    }
  });

  const workerResults = await Promise.all(workerPromises);

  // 8. Agregar resultados
  const allResults = [];
  if (warmup.probeSuccess) {
    allResults.push({ success: true, dni: probeAccount.dni, nombre: probeAccount.nombre, method: "warmup-probe" });
  }
  for (const wr of workerResults) {
    if (wr.results) allResults.push(...wr.results);
  }

  const totalSuccesses = allResults.filter(r => r.success).length;
  const totalFailures = allResults.filter(r => !r.success).length;
  const durationMs = Date.now() - startTime;

  // 9. Resumen
  log(`\n[COORD] ═══════════════════════════════`);
  log(`[COORD] RESUMEN FINAL`);
  log(`[COORD] Total: ${accounts.length} | Éxitos: ${totalSuccesses} | Fallos: ${totalFailures}`);
  log(`[COORD] Duración total: ${Math.round(durationMs / 1000)}s`);
  for (const wr of workerResults) {
    const ws = wr.results ? wr.results.filter(r => r.success).length : 0;
    const wt = wr.results ? wr.results.length : 0;
    const icon = wr.error ? "🔴" : (ws === wt ? "🟢" : "🟡");
    log(`[COORD]   ${icon} ${wr.workerId}: ${ws}/${wt} éxitos${wr.fallback ? " (fallback)" : ""}`);
  }
  log(`[COORD] ═══════════════════════════════\n`);

  for (const r of allResults) {
    const label = r.nombre ? `${r.nombre} (${r.dni})` : `DNI: ${r.dni}`;
    if (r.success) {
      log(`[COORD]   ✅ ${label}`);
    } else {
      log(`[COORD]   ❌ ${label} → ${r.reason || "desconocido"}`);
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
// CLI
// ══════════════════════════════════════════
if (require.main === module) {
  const arg = process.argv[2];

  if (arg === "--health") {
    healthCheckAll().then(results => {
      console.log("\n=== Health Check ===");
      for (const r of results) {
        const uptimeStr = r.uptime ? `(Uptime: ${Math.round(r.uptime/60)}m)` : "";
        console.log(`${r.status === "online" ? "🟢" : "🔴"} ${r.url} → ${r.status} ${r.workerId ? `(${r.workerId})` : ""} ${uptimeStr} ${r.error || ""}`);
      }
      process.exit(0);
    });
  } else if (arg === "--test-turnstile") {
    const capsolverKey = process.env.CAPSOLVER_API_KEY;
    if (!capsolverKey) {
      console.log("Falta CAPSOLVER_API_KEY en .env");
      process.exit(1);
    }
    console.log("Generando 3 tokens Turnstile de prueba...");
    generateTurnstilePool(3, capsolverKey).then(tokens => {
      console.log(`\nTokens obtenidos: ${tokens.length}`);
      for (const t of tokens) {
        console.log(`  ${t.substring(0, 60)}...`);
      }
      process.exit(0);
    });
  } else {
    console.log("Uso:");
    console.log("  node coordinator.js --health          → Verificar workers");
    console.log("  node coordinator.js --test-turnstile   → Probar CapSolver (3 tokens)");
    process.exit(0);
  }
}

module.exports = {
  executeDistributed,
  healthCheckAll,
  distributeAccounts,
  getWorkerUrls,
  generateTurnstilePool
};
