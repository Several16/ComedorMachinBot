/**
 * charola-engine.js — Motor de ejecución RAW para el comedor UNCP
 * 
 * Módulo exportable usado por:
 *   - worker-server.js (en cada VPS worker)
 *   - charola-auto.js (ejecución local / fallback)
 * 
 * Exporta: warmUpWaitForApiOpen, processAccountRawPost, executeRawBatch, getCsrfToken, checkApiOpenViaContador
 */

const https = require("https");
const dns = require("dns");
const crypto = require("crypto");

const KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  keepAliveMsecs: 30000,
  timeout: 60000,
  scheduling: "lifo"
});

const API_URL = process.env.UNCP_API_URL || "https://comensales.uncp.edu.pe/api/registros";
const WEB_URL = process.env.UNCP_WEB_URL || "https://comedor.uncp.edu.pe/charola";
const API_BASE = API_URL.replace(/\/registros$/, "");

// ── Helpers ──
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateFingerprint() {
  return crypto.randomBytes(16).toString("hex");
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

function buildFetchHeaders(config = {}) {
  const headers = { ...BROWSER_HEADERS };
  if (config.headers) Object.assign(headers, config.headers);
  if (config.cookies) headers["Cookie"] = config.cookies;
  return headers;
}

// ═══════════════════════════════════════════════════════════════
// CSRF TOKEN: GET /api/registros/token → { token: "eyJ..." }
// Válido por 5 minutos (300s). Reusable para múltiples POSTs.
// ═══════════════════════════════════════════════════════════════
async function getCsrfToken() {
  try {
    const res = await fetch(`${API_BASE}/registros/token`, {
      headers: BROWSER_HEADERS,
      agent: KEEP_ALIVE_AGENT,
      signal: AbortSignal.timeout(15000)
    });
    const json = await res.json();
    return json.token || null;
  } catch (e) {
    console.log(`[CSRF] Error obteniendo token: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTADOR: GET /api/registros/contador → { t3_estado: 0|1, ... }
// GRATIS — no requiere CSRF ni Turnstile. t3_estado=1 → API abierta.
// ═══════════════════════════════════════════════════════════════
async function checkApiOpenViaContador() {
  try {
    const res = await fetch(`${API_BASE}/registros/contador`, {
      headers: BROWSER_HEADERS,
      agent: KEEP_ALIVE_AGENT,
      signal: AbortSignal.timeout(8000)
    });
    const json = await res.json();
    return json.t3_estado === 1;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// POOL DE TURNSTILE TOKENS — consume 1 token por POST
// ═══════════════════════════════════════════════════════════════
function createTurnstilePool(tokens) {
  const pool = Array.isArray(tokens) ? [...tokens] : [];
  let index = 0;
  return {
    take: () => (index < pool.length ? pool[index++] : null),
    remaining: () => pool.length - index,
    size: () => pool.length
  };
}

// ═══════════════════════════════════════════════════════════════
// WARM-UP: sondear la API hasta que abra
// Sondeo dual: GET /contador (gratis) como principal, POST como fallback
// ═══════════════════════════════════════════════════════════════
async function warmUpWaitForApiOpen(probeAccount, maxWaitMs, config = {}) {
  const maxWait = maxWaitMs || 10 * 60 * 1000;
  const startTime = Date.now();
  let attempt = 0;
  let lastMsg = '';
  let extractedCookies = null;
  let contadorFailCount = 0;

  const fetchHeaders = buildFetchHeaders(config);
  const hasTurnstile = Array.isArray(config.turnstilePool) && config.turnstilePool.length > 0;
  const turnstilePool = hasTurnstile ? createTurnstilePool(config.turnstilePool) : null;
  let csrfToken = config.csrfToken || null;
  const fingerprint = config.fingerprint || generateFingerprint();

  console.log(`[WARMUP] Sondeando API hasta que abra... (máx ${Math.round(maxWait / 1000)}s)`);
  console.log(`[WARMUP] 📈 Sondeo dinámico: 1500ms → 800ms → 400ms | Dual: contador(gratis) + POST fallback`);
  if (hasTurnstile) {
    console.log(`[WARMUP] 🛡️ Turnstile pool: ${turnstilePool.size()} tokens disponibles`);
  }

  while (Date.now() - startTime < maxWait) {
    attempt++;
    const elapsed = Date.now() - startTime;
    const elapsedSec = elapsed / 1000;
    let probeIntervalMs;
    if (elapsedSec < 120) {
      probeIntervalMs = 1500;
    } else if (elapsedSec < 165) {
      probeIntervalMs = 800;
    } else {
      probeIntervalMs = 400;
    }

    // ── SONDEO PRINCIPAL: GET /contador (gratis, sin tokens) ──
    if (hasTurnstile) {
      const isOpen = await checkApiOpenViaContador();
      if (isOpen === true) {
        console.log(`[WARMUP] 🟢 Contador dice API abierta (t3_estado=1) en intento ${attempt}`);
        // Confirmar con POST real (consume 1 CSRF + 1 turnstile)
        if (!csrfToken) csrfToken = await getCsrfToken();
        const turnstileToken = turnstilePool.take();
        if (csrfToken && turnstileToken) {
          const body = `data=${encodeURIComponent(JSON.stringify({ t1_dni: probeAccount.dni, t1_codigo: probeAccount.codigo }))}&csrf_token=${encodeURIComponent(csrfToken)}&turnstile_token=${encodeURIComponent(turnstileToken)}&fingerprint=${fingerprint}&website=`;
          try {
            const res = await fetch(API_URL, {
              method: "POST",
              headers: { ...fetchHeaders, "Content-Type": "application/x-www-form-urlencoded" },
              body,
              agent: KEEP_ALIVE_AGENT,
              signal: AbortSignal.timeout(8000)
            });
            const json = await res.json();
            const msg = String(json.message || json.msg || "").toUpperCase().trim();
            if (json.code === 200 || json.code === 201) {
              console.log(`[WARMUP] ¡API ABIERTA! Cupo asegurado para DNI ${probeAccount.dni}`);
              console.log(`[RAW_SUCCESS] DNI: ${probeAccount.dni}`);
              return { open: true, probeSuccess: true, dni: probeAccount.dni, cookies: extractedCookies, csrfToken, fingerprint };
            }
            if (msg.includes("YA UTILIZADO")) {
              console.log(`[WARMUP] API abierta — sonda ya tiene ticket`);
              return { open: true, probeSuccess: true, dni: probeAccount.dni, cookies: extractedCookies, csrfToken, fingerprint };
            }
            console.log(`[WARMUP] Contador abierto pero POST dio: code=${json.code} msg="${json.message||json.msg}". API puede estar en transición.`);
            return { open: true, probeSuccess: false, dni: probeAccount.dni, cookies: extractedCookies, csrfToken, fingerprint };
          } catch (e) {
            console.log(`[WARMUP] Contador abierto pero POST falló: ${e.message}. Lanzando ataque.`);
            return { open: true, probeSuccess: false, cookies: extractedCookies, csrfToken, fingerprint };
          }
        }
        console.log(`[WARMUP] Contador abierto pero sin tokens (CSRF/turnstile). Lanzando ataque.`);
        return { open: true, probeSuccess: false, cookies: extractedCookies, csrfToken, fingerprint };
      }
      if (isOpen === null) {
        contadorFailCount++;
        if (contadorFailCount >= 3) {
          console.log(`[WARMUP] ⚠️ Contador falló ${contadorFailCount} veces. Cambiando a POST fallback...`);
        }
      }
    }

    // ── SONDEO FALLBACK: POST directo (gasta turnstile si disponible) ──
    const usePostFallback = !hasTurnstile || contadorFailCount >= 3;
    if (usePostFallback) {
      try {
        let body = `data=${encodeURIComponent(JSON.stringify({ t1_dni: probeAccount.dni, t1_codigo: probeAccount.codigo }))}`;
        if (hasTurnstile) {
          if (!csrfToken) csrfToken = await getCsrfToken();
          const tt = turnstilePool.take();
          if (csrfToken && tt) {
            body += `&csrf_token=${encodeURIComponent(csrfToken)}&turnstile_token=${encodeURIComponent(tt)}&fingerprint=${fingerprint}&website=`;
          }
        }

        const res = await fetch(API_URL, {
          method: "POST",
          headers: { ...fetchHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body,
          agent: KEEP_ALIVE_AGENT,
          signal: AbortSignal.timeout(8000)
        });

        const setCookieHeader = res.headers.get("set-cookie");
        if (setCookieHeader) {
          const phpMatch = setCookieHeader.match(/PHPSESSID=([^;]+)/);
          if (phpMatch) extractedCookies = `PHPSESSID=${phpMatch[1]}`;
        }

        const json = await res.json();
        const msg = String(json.message || json.msg || "").toUpperCase().trim();
        lastMsg = json.message || json.msg || '';

        if (attempt <= 3 || attempt % 10 === 0) {
          console.log(`[WARMUP] Intento ${attempt} (${Math.round(elapsedSec)}s): code=${json.code} msg="${json.message||json.msg}"`);
        }

        if (json.code === 200 || json.code === 201) {
          console.log(`[WARMUP] ¡API ABIERTA! Cupo asegurado para DNI ${probeAccount.dni} (intento ${attempt})`);
          console.log(`[RAW_SUCCESS] DNI: ${probeAccount.dni}`);
          return { open: true, probeSuccess: true, dni: probeAccount.dni, cookies: extractedCookies, csrfToken, fingerprint };
        }
        if (msg.includes("YA UTILIZADO")) {
          console.log(`[WARMUP] API activa — sonda ya tiene ticket`);
          return { open: true, probeSuccess: true, dni: probeAccount.dni, cookies: extractedCookies, csrfToken, fingerprint };
        }
        if (isFatalError(msg)) {
          console.log(`[WARMUP] Error fatal: "${json.message||json.msg}". API abierta pero sonda falló.`);
          return { open: true, probeSuccess: false, dni: probeAccount.dni, reason: json.message||json.msg, cookies: extractedCookies, csrfToken, fingerprint };
        }
        await sleep(probeIntervalMs);
      } catch (e) {
        if (attempt <= 3 || attempt % 10 === 0) {
          console.log(`[WARMUP] Intento ${attempt}: Error red (${e.message})`);
        }
        await sleep(probeIntervalMs);
      }
    } else {
      if (attempt <= 3 || attempt % 20 === 0) {
        console.log(`[WARMUP] Intento ${attempt} (${Math.round(elapsedSec)}s): contador t3_estado=0 (API cerrada)`);
      }
      await sleep(probeIntervalMs);
    }
  }

  console.log(`[WARMUP] Tiempo agotado (${Math.round(maxWait / 1000)}s). Último: "${lastMsg}". Lanzando ataque.`);
  return { open: false, probeSuccess: false, cookies: extractedCookies, csrfToken, fingerprint };
}

// Flag global: si cualquier cuenta detecta CUPOS AGOTADOS, todas se detienen
let globalCuposAgotados = false;

// ═══════════════════════════════════════════════════════════════
// ATAQUE RAW: procesar UNA cuenta con reintentos inteligentes
// Incluye CSRF + Turnstile si config.turnstilePool está disponible
// ═══════════════════════════════════════════════════════════════
async function processAccountRawPost(account, config = {}) {
  const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] [RAW]`;
  const maxPostAttempts = config.maxPostAttempts || 60;
  const retryDelayPostMs = config.retryDelayMs || 250;
  const max500Retries = config.max500Retries || 3;
  const delay500Ms = config.delay500Ms || 2000;
  const globalTimeoutMs = config.globalTimeoutMs || 25000;

  const fetchHeaders = buildFetchHeaders(config);
  const startTime = Date.now();
  let count500 = 0;

  const hasTurnstile = !!config._turnstilePool;
  const turnstilePool = config._turnstilePool;
  let csrfToken = config._csrfToken || null;
  const fingerprint = config._fingerprint || generateFingerprint();

  for (let attempt = 1; attempt <= maxPostAttempts; attempt += 1) {
    if (globalCuposAgotados) {
      return { success: false, dni: account.dni, nombre: account.nombre, reason: "Cupos agotados (global)" };
    }
    if (Date.now() - startTime > globalTimeoutMs) {
      console.log(`[RAW_FAIL] DNI: ${account.dni} | Timeout global (${globalTimeoutMs / 1000}s)`);
      return { success: false, dni: account.dni, nombre: account.nombre, reason: `Timeout global (${globalTimeoutMs / 1000}s)` };
    }

    try {
      let body = `data=${encodeURIComponent(JSON.stringify({ t1_dni: account.dni, t1_codigo: account.codigo }))}`;

      if (hasTurnstile) {
        if (!csrfToken) {
          csrfToken = await getCsrfToken();
          if (!csrfToken) {
            console.log(`${prefix} Sin CSRF token disponible, esperando...`);
            await sleep(retryDelayPostMs);
            continue;
          }
        }
        const tt = turnstilePool.take();
        if (!tt) {
          console.log(`${prefix} Pool de turnstile vacío, no se puede continuar`);
          return { success: false, dni: account.dni, nombre: account.nombre, reason: "Pool turnstile agotado" };
        }
        body += `&csrf_token=${encodeURIComponent(csrfToken)}&turnstile_token=${encodeURIComponent(tt)}&fingerprint=${fingerprint}&website=`;
      }

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { ...fetchHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        agent: KEEP_ALIVE_AGENT,
        signal: AbortSignal.timeout(8000)
      });

      const json = await res.json();
      const msg = String(json.message || json.msg || "").toUpperCase().trim();

      if (json.code === 200 || json.code === 201) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni}`);
        return { success: true, dni: account.dni, nombre: account.nombre };
      }
      if (msg.includes("YA UTILIZADO")) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni} (ticket ya existía)`);
        return { success: true, dni: account.dni, nombre: account.nombre, note: "Ya tenía ticket" };
      }
      if (msg.includes("CUPOS AGOTADOS") || msg.includes("AGOTADO")) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | CUPOS AGOTADOS — deteniendo todo`);
        globalCuposAgotados = true;
        return { success: false, dni: account.dni, nombre: account.nombre, reason: "Cupos agotados" };
      }

      // ── CSRF expirado → refrescar y reintentar ──
      if (msg.includes("CSRF_EXPIRED") || msg.includes("CSRF_INVALID") || msg.includes("CSRF_MISSING")) {
        console.log(`${prefix} CSRF expirado, refrescando...`);
        csrfToken = await getCsrfToken();
        await sleep(retryDelayPostMs);
        continue;
      }

      // ── Turnstile inválido → tomar otro token y reintentar ──
      if (msg.includes("TURNSTILE_MISSING") || msg.includes("TURNSTILE_INVALID")) {
        console.log(`${prefix} Turnstile inválido, tomando otro token...`);
        await sleep(retryDelayPostMs);
        continue;
      }

      if (isFatalError(msg)) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR FATAL: ${json.message||json.msg} (code=${json.code})`);
        return { success: false, dni: account.dni, nombre: account.nombre, reason: json.message||json.msg };
      }

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

      if (attempt % 20 === 0) {
        console.log(`${prefix} Intento ${attempt}/${maxPostAttempts}: code=${json.code} msg="${json.message||json.msg||'sin mensaje'}"`);
      }
      await sleep(retryDelayPostMs);

    } catch (e) {
      if (attempt % 20 === 0) console.log(`${prefix} Intento ${attempt}: Error red (${e.message})`);
      await sleep(retryDelayPostMs);
    }
  }
  console.log(`[RAW_FAIL] DNI: ${account.dni} | Max intentos agotado (${maxPostAttempts})`);
  return { success: false, dni: account.dni, nombre: account.nombre, reason: `Max intentos agotado (${maxPostAttempts})` };
}

// ═══════════════════════════════════════════════════════════════
// EJECUTAR BATCH COMPLETO: warmup → tren de aterrizaje
// ═══════════════════════════════════════════════════════════════
async function executeRawBatch(accounts, config = {}) {
  const maxWarmupMs = config.maxWarmupMs || 10 * 60 * 1000;
  const startTime = Date.now();

  const hasTurnstile = Array.isArray(config.turnstilePool) && config.turnstilePool.length > 0;

  console.log(`[ENGINE] Iniciando ejecución RAW para ${accounts.length} cuenta(s).`);
  if (hasTurnstile) {
    console.log(`[ENGINE] Modo: tren de aterrizaje + url-encoded + CSRF/Turnstile (${config.turnstilePool.length} tokens) + timeout=25s`);
  } else {
    console.log(`[ENGINE] Modo: tren de aterrizaje + url-encoded + retries inteligentes (500→2s, 404→250ms, timeout=25s)`);
  }

  let pendingAccounts;
  const results = [];

  if (config.skipWarmup) {
    console.log(`[ENGINE] ⚡ Saltando WARMUP. Lanzando cuentas...`);
    pendingAccounts = [...accounts];
  } else {
    const probeAccount = accounts[0];
    const warmup = await warmUpWaitForApiOpen(probeAccount, maxWarmupMs, config);

    if (warmup.probeSuccess) {
      pendingAccounts = accounts.filter(a => a.dni !== probeAccount.dni);
      results.push({ success: true, dni: probeAccount.dni, nombre: probeAccount.nombre, method: "warmup" });
      console.log(`[ENGINE] Sonda (${probeAccount.dni}) asegurada. Atacando ${pendingAccounts.length} restantes...`);
    } else {
      pendingAccounts = [...accounts];
      console.log(`[ENGINE] API ${warmup.open ? 'abierta' : 'estado desconocido'}. Atacando TODAS las ${pendingAccounts.length} cuentas...`);
    }
    if (warmup.csrfToken) config._csrfToken = warmup.csrfToken;
    if (warmup.fingerprint) config._fingerprint = warmup.fingerprint;
  }

  // ── FASE B: "Tren de Aterrizaje" ──
  if (pendingAccounts.length > 0) {
    try {
      const apiHost = new URL(API_URL).hostname;
      const ips = await dns.promises.resolve4(apiHost);
      console.log(`[ENGINE] 🌐 DNS pre-resuelto: ${apiHost} → ${ips[0]}`);
    } catch (e) {}

    globalCuposAgotados = false;

    const STAGGER_MS = config.staggerMs || 15;
    const staggerOffset = config.staggerOffset || 0;
    const turnstilePool = hasTurnstile ? createTurnstilePool(config.turnstilePool) : null;
    const fingerprint = config._fingerprint || generateFingerprint();

    if (!config._csrfToken && hasTurnstile) {
      config._csrfToken = await getCsrfToken();
    }

    const sharedConfig = {
      ...config,
      _turnstilePool: turnstilePool,
      _csrfToken: config._csrfToken,
      _fingerprint: fingerprint
    };

    if (turnstilePool) {
      console.log(`[ENGINE] 🚀 Tren de aterrizaje: ${pendingAccounts.length} cuentas, ${STAGGER_MS}ms stagger (offset ${staggerOffset}ms) | Turnstile: ${turnstilePool.remaining()}/${turnstilePool.size()} tokens`);
    } else {
      console.log(`[ENGINE] 🚀 Tren de aterrizaje: ${pendingAccounts.length} cuentas, ${STAGGER_MS}ms stagger (offset ${staggerOffset}ms)`);
    }

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
            processAccountRawPost(acc, sharedConfig),
            processAccountRawPost(acc, sharedConfig),
            processAccountRawPost(acc, sharedConfig)
          ]).then(shots => shots.find(r => r.success) || shots[0]);
        }
        return processAccountRawPost(acc, sharedConfig);
      })();
    });

    const allResults = await Promise.all(allPromises);
    results.push(...allResults);
    if (turnstilePool) {
      console.log(`[ENGINE] Turnstile restantes: ${turnstilePool.remaining()}/${turnstilePool.size()}`);
    }
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
  getCsrfToken,
  checkApiOpenViaContador,
  generateFingerprint,
  sleep
};
