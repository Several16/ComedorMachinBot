/**
 * charola-engine.js — Motor de ejecución RAW para el comedor UNCP
 * 
 * Módulo exportable usado por:
 *   - worker-server.js (en cada VPS worker)
 *   - charola-auto.js (ejecución local / fallback)
 * 
 * Exporta: warmUpWaitForApiOpen, processAccountRawPost, executeRawBatch
 */

const https = require("https");
const dns = require("dns");

const KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  keepAliveMsecs: 30000,
  timeout: 60000,
  scheduling: "lifo"
});

const API_URL = process.env.UNCP_API_URL || "https://comensales.uncp.edu.pe/api/registros";
const WEB_URL = process.env.UNCP_WEB_URL || "https://comedor.uncp.edu.pe/charola";

// ── Helpers ──
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FATAL_KEYWORDS = [
  "DNI NO VALIDO", "CODIGO NO VALIDO", "NO EXISTE", "ELIMINADO",
  "SUSPENDIDO", "BLOQUEADO", "INHABILITADO", "DATOS INCORRECTOS",
  "CUPOS AGOTADOS", "AGOTADO"
];

function isFatalError(msg) {
  const upper = String(msg || "").toUpperCase();
  return FATAL_KEYWORDS.some(kw => upper.includes(kw));
}

// ── Headers de navegador para camuflaje ──
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Origin": "https://comedor.uncp.edu.pe",
  "Referer": "https://comedor.uncp.edu.pe/charola",
  "Sec-Ch-Ua": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site"
};

// ── Construir headers de fetch combinando navegador + cookies opcionales ──
function buildFetchHeaders(config = {}) {
  const headers = { ...BROWSER_HEADERS };
  // Inyectar headers custom si el coordinador los envió
  if (config.headers) Object.assign(headers, config.headers);
  // Inyectar cookie si el coordinador la extrajo del warmup
  if (config.cookies) headers["Cookie"] = config.cookies;
  return headers;
}

// ═══════════════════════════════════════════════════════════════
// WARM-UP: sondear la API hasta que abra y asegure cupo con la sonda
// FILOSOFÍA: REINTENTAR SIEMPRE salvo éxito definitivo (200/201)
// ═══════════════════════════════════════════════════════════════
async function warmUpWaitForApiOpen(probeAccount, maxWaitMs, config = {}) {
  const maxWait = maxWaitMs || 10 * 60 * 1000;
  const startTime = Date.now();
  let attempt = 0;
  let lastMsg = '';
  let extractedCookies = null;

  const fetchHeaders = buildFetchHeaders(config);

  console.log(`[WARMUP] Sondeando API con DNI ${probeAccount.dni} hasta que abra... (máx ${Math.round(maxWait / 1000)}s)`);
  console.log(`[WARMUP] 🛡️ Headers de navegador activados (Chrome 137)`);
  console.log(`[WARMUP] 📈 Sondeo dinámico: 1500ms → 800ms → 400ms cerca de hora cero`);

  while (Date.now() - startTime < maxWait) {
    attempt++;
    // Sondeo dinámico: reducir intervalo al acercarse a hora cero
    const elapsed = Date.now() - startTime;
    const elapsedSec = elapsed / 1000;
    let probeIntervalMs;
    if (elapsedSec < 120) {
      probeIntervalMs = 1500; // Primeros 2 min: sondeo normal
    } else if (elapsedSec < 165) {
      probeIntervalMs = 800;  // Minuto 2-3: sondeo acelerado
    } else {
      probeIntervalMs = 400;  // Últimos 30s antes de hora cero: sondeo agresivo
    }
    try {
      const body = `data=${encodeURIComponent(JSON.stringify({ t1_dni: probeAccount.dni, t1_codigo: probeAccount.codigo }))}`;

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { ...fetchHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        agent: KEEP_ALIVE_AGENT,
        signal: AbortSignal.timeout(8000)
      });

      // ── Extraer cookie PHPSESSID de la respuesta ──
      const setCookieHeader = res.headers.get("set-cookie");
      if (setCookieHeader) {
        const phpMatch = setCookieHeader.match(/PHPSESSID=([^;]+)/);
        if (phpMatch) {
          extractedCookies = `PHPSESSID=${phpMatch[1]}`;
          if (attempt <= 3) {
            console.log(`[WARMUP] 🍪 Cookie extraída: ${extractedCookies.substring(0, 30)}...`);
          }
        }
      }

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
        return { open: true, probeSuccess: true, dni: probeAccount.dni, cookies: extractedCookies };
      }

      // "YA UTILIZADO" = API activa, ya tiene ticket
      if (msg.includes("YA UTILIZADO")) {
        console.log(`[WARMUP] API activa — cuenta sonda ya tiene ticket. Lanzando ataque.`);
        return { open: true, probeSuccess: true, dni: probeAccount.dni, cookies: extractedCookies };
      }

      // Error FATAL de datos (DNI inválido, etc.) — no tiene sentido seguir sondeando con esta cuenta
      if (isFatalError(msg)) {
        console.log(`[WARMUP] Error fatal de datos: "${json.message}". Considerando API abierta pero sonda falló.`);
        return { open: true, probeSuccess: false, dni: probeAccount.dni, reason: json.message, cookies: extractedCookies };
      }

      // ═══ CUALQUIER OTRA RESPUESTA → REINTENTAR ═══
      await sleep(probeIntervalMs);

    } catch (e) {
      if (attempt <= 3 || attempt % 10 === 0) {
        console.log(`[WARMUP] Intento ${attempt}: Timeout/Error de red (${e.message}), reintentando...`);
      }
      await sleep(probeIntervalMs);
    }
  }

  console.log(`[WARMUP] Tiempo máximo de espera agotado (${Math.round(maxWait / 1000)}s). Último msg: "${lastMsg}". Lanzando ataque de todas formas.`);
  return { open: false, probeSuccess: false, cookies: extractedCookies };
}

// Flag global: si cualquier cuenta detecta CUPOS AGOTADOS, todas se detienen
let globalCuposAgotados = false;

// ═══════════════════════════════════════════════════════════════
// ATAQUE RAW: procesar UNA cuenta con reintentos inteligentes
// 
// ESTRATEGIA:
//   - 404/300 (API flaky)        → retry rápido cada 250ms (atrapa apertura)
//   - 500 (MySQL deadlock)       → retry cada 2s, máx 3 veces (deadlock cleara en 1-2s)
//   - 200/201 (éxito)            → return inmediato
//   - YA UTILIZADO               → return inmediato (éxito)
//   - FATAL (DNI inválido, etc.) → return inmediato (no reintentar)
//   - CUPOS AGOTADOS             → flag global, detener TODO
//   - Timeout global: 15s        → parar sin importar el intento
// ═══════════════════════════════════════════════════════════════
async function processAccountRawPost(account, config = {}) {
  const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] [RAW]`;
  const maxPostAttempts = config.maxPostAttempts || 60;
  const retryDelayPostMs = config.retryDelayMs || 250;
  const max500Retries = config.max500Retries || 3;
  const delay500Ms = config.delay500Ms || 2000;
  const globalTimeoutMs = config.globalTimeoutMs || 15000;

  const fetchHeaders = buildFetchHeaders(config);
  const startTime = Date.now();
  let count500 = 0;

  for (let attempt = 1; attempt <= maxPostAttempts; attempt += 1) {
    if (globalCuposAgotados) {
      return { success: false, dni: account.dni, nombre: account.nombre, reason: "Cupos agotados (global)" };
    }

    if (Date.now() - startTime > globalTimeoutMs) {
      console.log(`[RAW_FAIL] DNI: ${account.dni} | Timeout global (${globalTimeoutMs / 1000}s)`);
      return { success: false, dni: account.dni, nombre: account.nombre, reason: `Timeout global (${globalTimeoutMs / 1000}s)` };
    }

    try {
      const body = `data=${encodeURIComponent(JSON.stringify({ t1_dni: account.dni, t1_codigo: account.codigo }))}`;

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { ...fetchHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        agent: KEEP_ALIVE_AGENT,
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

      // ═══ CUPOS AGOTADOS → flag global, detener TODO ═══
      if (msg.includes("CUPOS AGOTADOS") || msg.includes("AGOTADO")) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | CUPOS AGOTADOS — deteniendo todas las cuentas`);
        globalCuposAgotados = true;
        return { success: false, dni: account.dni, nombre: account.nombre, reason: "Cupos agotados" };
      }

      // ═══ ERROR FATAL DE DATOS → no reintentar ═══
      if (isFatalError(msg)) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR FATAL: ${json.message} (code=${json.code})`);
        return { success: false, dni: account.dni, nombre: account.nombre, reason: json.message };
      }

      // ═══ ERROR 500 = MySQL DEADLOCK → retry con espera de 2s ═══
      if (json.code === 500) {
        count500++;
        if (count500 > max500Retries) {
          console.log(`[RAW_FAIL] DNI: ${account.dni} | HTTP 500 persistente (${count500 - 1} retries)`);
          return { success: false, dni: account.dni, nombre: account.nombre, reason: `HTTP 500 persistente (${count500 - 1} retries)` };
        }
        if (attempt <= 5 || count500 <= 3) {
          console.log(`${prefix} HTTP 500 (deadlock) intento ${count500}/${max500Retries} — esperando ${delay500Ms}ms...`);
        }
        await sleep(delay500Ms);
        continue;
      }

      // ═══ 404/300/OTRO = API flaky → retry rápido cada 250ms ═══
      if (attempt % 20 === 0) {
        console.log(`${prefix} Intento ${attempt}/${maxPostAttempts}: code=${json.code} msg="${json.message || 'sin mensaje'}", reintentando...`);
      }
      await sleep(retryDelayPostMs);

    } catch (e) {
      if (attempt % 20 === 0) console.log(`${prefix} Intento ${attempt}: Timeout/Error red (${e.message}), reintentando...`);
      await sleep(retryDelayPostMs);
    }
  }
  console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR: Max intentos agotado (${maxPostAttempts})`);
  return { success: false, dni: account.dni, nombre: account.nombre, reason: `Max intentos agotado (${maxPostAttempts})` };
}



// ═══════════════════════════════════════════════════════════════
// EJECUTAR BATCH COMPLETO: warmup → oleadas → rescate
// ═══════════════════════════════════════════════════════════════
async function executeRawBatch(accounts, config = {}) {
  const maxWarmupMs = config.maxWarmupMs || 10 * 60 * 1000;
  const startTime = Date.now();

  console.log(`[ENGINE] Iniciando ejecución RAW para ${accounts.length} cuenta(s).`);
  console.log(`[ENGINE] Modo: tren de aterrizaje (15ms stagger) + url-encoded + retries inteligentes (500→2s, 404→250ms, timeout=15s)`);

  // ── FASE A: Warm-up ──
  let pendingAccounts;
  const results = [];

  if (config.skipWarmup) {
    console.log(`[ENGINE] ⚡ Saltando WARMUP por orden del Coordinador. Lanzando cuentas...`);
    pendingAccounts = [...accounts];
  } else {
    const probeAccount = accounts[0];
    const warmup = await warmUpWaitForApiOpen(probeAccount, maxWarmupMs);

    if (warmup.probeSuccess) {
      pendingAccounts = accounts.filter(a => a.dni !== probeAccount.dni);
      results.push({ success: true, dni: probeAccount.dni, nombre: probeAccount.nombre, method: "warmup" });
      console.log(`[ENGINE] Cuenta sonda (${probeAccount.dni}) asegurada. Atacando ${pendingAccounts.length} restantes...`);
    } else {
      pendingAccounts = [...accounts];
      console.log(`[ENGINE] API ${warmup.open ? 'abierta' : 'estado desconocido'}. Atacando TODAS las ${pendingAccounts.length} cuentas...`);
    }
  }

  // ── FASE B: "Tren de Aterrizaje" — stagger individual anti-deadlock ──
  // Cada cuenta se dispara con STAGGER_MS de diferencia.
  // MySQL procesa 1 transacción a la vez → cero Lock Upgrade Deadlocks.
  // El coordinator envía staggerOffset para que workers no se pisen entre sí.
  if (pendingAccounts.length > 0) {
    try {
      const apiHost = new URL(API_URL).hostname;
      const ips = await dns.promises.resolve4(apiHost);
      console.log(`[ENGINE] 🌐 DNS pre-resuelto: ${apiHost} → ${ips[0]}`);
    } catch (e) {}

    globalCuposAgotados = false;

    const STAGGER_MS = config.staggerMs || 15;
    const staggerOffset = config.staggerOffset || 0;

    console.log(`[ENGINE] 🚀 Tren de aterrizaje: ${pendingAccounts.length} cuentas, ${STAGGER_MS}ms entre cada una (offset ${staggerOffset}ms)`);

    const allPromises = pendingAccounts.map((acc, i) => {
      const fireAt = staggerOffset + (i * STAGGER_MS);
      return (async () => {
        await sleep(fireAt);

        if (globalCuposAgotados) {
          return { success: false, dni: acc.dni, nombre: acc.nombre, reason: "Cupos agotados (global)" };
        }

        const isVip = acc.nombre && acc.nombre.toLowerCase().includes('vip');
        if (isVip) {
          return Promise.all([
            processAccountRawPost(acc, config),
            processAccountRawPost(acc, config),
            processAccountRawPost(acc, config)
          ]).then(shots => shots.find(r => r.success) || shots[0]);
        }
        return processAccountRawPost(acc, config);
      })();
    });

    const allResults = await Promise.all(allPromises);
    results.push(...allResults);
    globalCuposAgotados = false;
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
  executeRawBatch,
  sleep
};
