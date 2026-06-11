/**
 * charola-engine.js — Motor de ejecución RAW para el comedor UNCP
 * 
 * Módulo exportable usado por:
 *   - worker-server.js (en cada VPS worker)
 *   - charola-auto.js (ejecución local / fallback)
 * 
 * Exporta: warmUpWaitForApiOpen, processAccountRawPost, processAccountRawRescue, executeRawBatch
 */

const API_URL = "https://comensales.uncp.edu.pe/api/registros";

// ── Helpers ──
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FATAL_KEYWORDS = [
  "DNI NO VALIDO", "CODIGO NO VALIDO", "NO EXISTE", "ELIMINADO",
  "SUSPENDIDO", "BLOQUEADO", "INHABILITADO", "DATOS INCORRECTOS"
];

function isFatalError(msg) {
  const upper = String(msg || "").toUpperCase();
  return FATAL_KEYWORDS.some(kw => upper.includes(kw));
}

// ═══════════════════════════════════════════════════════════════
// WARM-UP: sondear la API hasta que abra y asegure cupo con la sonda
// FILOSOFÍA: REINTENTAR SIEMPRE salvo éxito definitivo (200/201)
// ═══════════════════════════════════════════════════════════════
async function warmUpWaitForApiOpen(probeAccount, maxWaitMs) {
  const maxWait = maxWaitMs || 10 * 60 * 1000;
  const probeIntervalMs = 1500;
  const startTime = Date.now();
  let attempt = 0;
  let lastMsg = '';

  console.log(`[WARMUP] Sondeando API con DNI ${probeAccount.dni} hasta que abra... (máx ${Math.round(maxWait / 1000)}s)`);

  while (Date.now() - startTime < maxWait) {
    attempt++;
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: probeAccount.dni, t1_codigo: probeAccount.codigo }));

      const res = await fetch(API_URL, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(8000)
      });

      const json = await res.json();
      const msg = String(json.message || "").toUpperCase().trim();
      lastMsg = json.message || '';

      if (attempt <= 3 || attempt % 10 === 0) {
        console.log(`[WARMUP] Intento ${attempt} (${Math.round((Date.now() - startTime) / 1000)}s): code=${json.code} message="${json.message}"`);
      }

      // ═══ ÚNICO CASO DE ÉXITO: código 200 o 201 ═══
      if (json.code === 200 || json.code === 201) {
        console.log(`[WARMUP] ¡API ABIERTA! Cupo asegurado en sondeo para DNI ${probeAccount.dni} (intento ${attempt}, ${Math.round((Date.now() - startTime) / 1000)}s)`);
        console.log(`[RAW_SUCCESS] DNI: ${probeAccount.dni}`);
        return { open: true, probeSuccess: true, dni: probeAccount.dni };
      }

      // "YA UTILIZADO" = API activa, ya tiene ticket
      if (msg.includes("YA UTILIZADO")) {
        console.log(`[WARMUP] API activa — cuenta sonda ya tiene ticket. Lanzando ataque.`);
        return { open: true, probeSuccess: true, dni: probeAccount.dni };
      }

      // Error FATAL de datos (DNI inválido, etc.) — no tiene sentido seguir sondeando con esta cuenta
      if (isFatalError(msg)) {
        console.log(`[WARMUP] Error fatal de datos: "${json.message}". Considerando API abierta pero sonda falló.`);
        return { open: true, probeSuccess: false, dni: probeAccount.dni, reason: json.message };
      }

      // ═══ CUALQUIER OTRA RESPUESTA → REINTENTAR ═══
      // Esto incluye: 404, 500, "CUPOS AGOTADOS", "FUERA DE HORARIO",
      // "SERVICIO NO DISPONIBLE", mensajes vacíos, y CUALQUIER
      // respuesta desconocida. La API no está abierta hasta que
      // devuelva 200/201.
      await sleep(probeIntervalMs);

    } catch (e) {
      if (attempt <= 3 || attempt % 10 === 0) {
        console.log(`[WARMUP] Intento ${attempt}: Timeout/Error de red (${e.message}), reintentando...`);
      }
      await sleep(probeIntervalMs);
    }
  }

  console.log(`[WARMUP] Tiempo máximo de espera agotado (${Math.round(maxWait / 1000)}s). Último msg: "${lastMsg}". Lanzando ataque de todas formas.`);
  return { open: false, probeSuccess: false };
}

// ═══════════════════════════════════════════════════════════════
// ATAQUE RAW: procesar UNA cuenta con reintentos agresivos
// FILOSOFÍA: REINTENTAR SIEMPRE salvo éxito o error fatal de datos
// ═══════════════════════════════════════════════════════════════
async function processAccountRawPost(account, config = {}) {
  const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] [RAW]`;
  const maxPostAttempts = config.maxPostAttempts || 150;
  const retryDelayPostMs = config.retryDelayMs || 250;

  for (let attempt = 1; attempt <= maxPostAttempts; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: account.dni, t1_codigo: account.codigo }));

      const res = await fetch(API_URL, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(8000)
      });

      const json = await res.json();
      const msg = String(json.message || "").toUpperCase().trim();

      // ═══ ÉXITO ═══
      if (json.code === 200 || json.code === 201) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni}`);
        return { success: true, dni: account.dni, nombre: account.nombre };
      }

      // "YA UTILIZADO" = ya tiene cupo
      if (msg.includes("YA UTILIZADO")) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni} (ticket ya existía en BD)`);
        return { success: true, dni: account.dni, nombre: account.nombre, note: "Ya tenía ticket" };
      }

      // ═══ ERROR FATAL DE DATOS → no reintentar ═══
      if (isFatalError(msg)) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR FATAL: ${json.message} (code=${json.code})`);
        return { success: false, dni: account.dni, nombre: account.nombre, reason: json.message };
      }

      // ═══ CUALQUIER OTRA RESPUESTA → REINTENTAR ═══
      // 404, 500, "CUPOS", "HORARIO", mensajes desconocidos — TODO se reintenta
      if (attempt % 15 === 0) {
        console.log(`${prefix} Intento ${attempt}/${maxPostAttempts}: code=${json.code} msg="${json.message || 'sin mensaje'}", reintentando...`);
      }
      await sleep(retryDelayPostMs);

    } catch (e) {
      if (attempt % 15 === 0) console.log(`${prefix} Intento ${attempt}: Timeout/Error red (${e.message}), reintentando...`);
      await sleep(retryDelayPostMs);
    }
  }
  console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR: Max intentos post-apertura agotado (${maxPostAttempts})`);
  return { success: false, dni: account.dni, nombre: account.nombre, reason: `Max intentos post-apertura agotado (${maxPostAttempts})` };
}

// ═══════════════════════════════════════════════════════════════
// RESCATE: reintentos individuales con más paciencia
// ═══════════════════════════════════════════════════════════════
async function processAccountRawRescue(account, config = {}) {
  const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] [RESCATE]`;
  const maxRescueAttempts = config.maxRescueAttempts || 80;
  const rescueDelayMs = config.rescueDelayMs || 1000;
  const rescueTimeoutMs = config.rescueTimeoutMs || 15000;

  console.log(`${prefix} Iniciando rescate (${maxRescueAttempts} intentos, ${rescueDelayMs}ms delay)...`);

  for (let attempt = 1; attempt <= maxRescueAttempts; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: account.dni, t1_codigo: account.codigo }));

      const res = await fetch(API_URL, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(rescueTimeoutMs)
      });

      const json = await res.json();
      const msg = String(json.message || "").toUpperCase().trim();

      if (json.code === 200 || json.code === 201) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni} (rescatado en intento ${attempt})`);
        return { success: true, dni: account.dni, nombre: account.nombre, note: "Rescatado" };
      }

      if (msg.includes("YA UTILIZADO")) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni} (rescate: ticket ya existía)`);
        return { success: true, dni: account.dni, nombre: account.nombre, note: "Ya tenía ticket" };
      }

      // Error fatal de datos — no reintentar
      if (isFatalError(msg)) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR FATAL (rescate): ${json.message}`);
        return { success: false, dni: account.dni, nombre: account.nombre, reason: json.message };
      }

      if (msg.includes("AGOTADOS") || msg.includes("SIN CUPOS")) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR: Cupos agotados (rescate)`);
        return { success: false, dni: account.dni, nombre: account.nombre, reason: "Cupos agotados" };
      }

      if (attempt % 10 === 0) {
        console.log(`${prefix} Intento ${attempt}/${maxRescueAttempts}: code=${json.code} msg="${json.message || 'sin mensaje'}"`);
      }

      await sleep(rescueDelayMs);

    } catch (e) {
      if (attempt % 10 === 0) console.log(`${prefix} Intento ${attempt}: ${e.message}`);
      await sleep(rescueDelayMs);
    }
  }
  console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR: Rescate agotado (${maxRescueAttempts} intentos)`);
  return { success: false, dni: account.dni, nombre: account.nombre, reason: `Rescate agotado (${maxRescueAttempts} intentos)` };
}

// ═══════════════════════════════════════════════════════════════
// EJECUTAR BATCH COMPLETO: warmup → oleadas → rescate
// ═══════════════════════════════════════════════════════════════
async function executeRawBatch(accounts, config = {}) {
  const waveSize = config.waveSize || 4;
  const waveDelayMs = config.waveDelayMs || 500;
  const maxWarmupMs = config.maxWarmupMs || 10 * 60 * 1000;
  const startTime = Date.now();

  console.log(`[ENGINE] Iniciando ejecución RAW para ${accounts.length} cuenta(s).`);
  console.log(`[ENGINE] Config: waveSize=${waveSize}, waveDelay=${waveDelayMs}ms, maxAttempts=${config.maxPostAttempts || 150}`);

  // ── FASE A: Warm-up ──
  const probeAccount = accounts[0];
  const warmup = await warmUpWaitForApiOpen(probeAccount, maxWarmupMs);

  let pendingAccounts;
  const results = [];

  if (warmup.probeSuccess) {
    pendingAccounts = accounts.filter(a => a.dni !== probeAccount.dni);
    results.push({ success: true, dni: probeAccount.dni, nombre: probeAccount.nombre, method: "warmup" });
    console.log(`[ENGINE] Cuenta sonda (${probeAccount.dni}) asegurada. Atacando ${pendingAccounts.length} restantes...`);
  } else {
    pendingAccounts = [...accounts];
    console.log(`[ENGINE] API ${warmup.open ? 'abierta' : 'estado desconocido'}. Atacando TODAS las ${pendingAccounts.length} cuentas...`);
  }

  // ── FASE B: Oleadas ──
  if (pendingAccounts.length > 0) {
    const waves = [];
    for (let i = 0; i < pendingAccounts.length; i += waveSize) {
      waves.push(pendingAccounts.slice(i, i + waveSize));
    }

    console.log(`[ENGINE] Dividiendo ${pendingAccounts.length} cuentas en ${waves.length} oleada(s) de máx ${waveSize}...`);

    const allWavePromises = waves.map((wave, w) => {
      return (async () => {
        if (w > 0) await sleep(w * waveDelayMs);
        console.log(`[ENGINE] ═══ OLEADA ${w + 1}/${waves.length}: ${wave.length} cuentas ═══`);
        const waveResults = await Promise.all(wave.map(acc => processAccountRawPost(acc, config)));
        const successes = waveResults.filter(r => r.success).length;
        console.log(`[ENGINE] Oleada ${w + 1} finalizada: ${successes}/${wave.length} éxitos`);
        return waveResults.map(r => ({ ...r, method: `wave-${w + 1}` }));
      })();
    });

    const allWaveResults = await Promise.all(allWavePromises);
    for (const wr of allWaveResults) results.push(...wr);
  }

  // ── FASE C: Rescate ──
  const phase1Failures = results.filter(r => !r.success);
  if (phase1Failures.length > 0) {
    console.log(`[ENGINE] ${phase1Failures.length} cuenta(s) fallaron. Esperando 5s para rescate...`);
    await sleep(5000);
    console.log(`[ENGINE] Iniciando rescate individual...`);
    for (const fail of phase1Failures) {
      const account = accounts.find(a => a.dni === fail.dni);
      if (!account) continue;
      console.log(`[ENGINE] Rescatando DNI: ${account.dni}...`);
      const rescue = await processAccountRawRescue(account, config);
      const idx = results.findIndex(r => r.dni === fail.dni);
      if (idx !== -1) results[idx] = { ...rescue, method: "rescue" };
    }
  }

  // ── Resumen ──
  const successes = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success);
  const durationMs = Date.now() - startTime;

  console.log(`\n[ENGINE] ═══════════════════════════════`);
  console.log(`[ENGINE] Total: ${accounts.length} | Éxitos: ${successes} | Fallos: ${failures.length} | Duración: ${Math.round(durationMs / 1000)}s`);
  for (const r of results) {
    const label = r.nombre ? `${r.nombre} (${r.dni})` : `DNI: ${r.dni}`;
    if (r.success) {
      console.log(`[ENGINE]   ✅ ${label}`);
    } else {
      console.log(`[ENGINE]   ❌ ${label} → ${r.reason || 'desconocido'}`);
    }
  }
  console.log(`[ENGINE] ═══════════════════════════════\n`);

  return {
    total: accounts.length,
    successes,
    failures: failures.length,
    results,
    durationMs
  };
}

module.exports = {
  warmUpWaitForApiOpen,
  processAccountRawPost,
  processAccountRawRescue,
  executeRawBatch,
  sleep
};
