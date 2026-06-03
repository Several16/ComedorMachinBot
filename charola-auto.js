const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const TURBO_DEFAULT = process.env.CHAROLA_TURBO_MODE !== "false";

const CONFIG = {
  url: "https://comedor.uncp.edu.pe/charola",
  dni: process.env.CHAROLA_DNI || "73968815",
  codigo: process.env.CHAROLA_CODIGO || "2023200615D",
  accountsJson: process.env.CHAROLA_ACCOUNTS || null,
  maxAttempts: Number(process.env.CHAROLA_MAX_ATTEMPTS || 1200),
  retryDelayMs: Number(process.env.CHAROLA_RETRY_DELAY_MS || 800),
  afterSubmitWaitMs: Number(process.env.CHAROLA_AFTER_SUBMIT_WAIT_MS || 1200),
  pageSettleMs: Number(process.env.CHAROLA_PAGE_SETTLE_MS || 250),
  formWaitMs: Number(process.env.CHAROLA_FORM_WAIT_MS || 1800),
  reloadEveryAttempts: Number(process.env.CHAROLA_RELOAD_EVERY_ATTEMPTS || 1),
  captureRetryEvery: Number(process.env.CHAROLA_CAPTURE_RETRY_EVERY || 40),
  turboMode: TURBO_DEFAULT,
  headless: process.env.CHAROLA_HEADLESS !== "false",
  outputDir: path.join(__dirname, "runs"),
  execMode: process.env.CHAROLA_EXECUTION_MODE || "visual",
  chunkSize: Number(process.env.CHAROLA_CHUNK_SIZE || 5)
};

const RETRY_MESSAGES = [
  "SIN CUPOS DISPONIBLES",
  "NO HAY TICKETS DISPONIBLES",
  "FUERA DE HORARIO",
  "INTENTE MANANA",
  "CUPOS AGOTADOS",
  "USUARIO NO ENCONTRADO",
  "NO MATRICULADO",
];

const FATAL_MESSAGES = [
  "CODIGO YA UTILIZADO",
  "TICKET YA UTILIZADO",
];

const SUCCESS_MESSAGES = [
  "IMPRIMIR TICKET",
  "PRESENTA ESTE CODIGO",
  "CODIGO DE TICKET",
  "EL TICKET ES VALIDO",
  "CODIGO QR",
  "QR",
];

const PRECHECK_MESSAGES = [
  "INFORMACION IMPORTANTE",
  "HORARIO DE REGISTRO",
  "PLATAFORMA SE HABILITARA",
  "ACCESO RESTRINGIDO",
  "REGISTRO DE TICKET VIRTUAL",
];

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function containsAny(text, list) {
  return list.some((item) => text.includes(item));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldCaptureRetry(attempt) {
  if (CONFIG.captureRetryEvery <= 0) return false;
  return attempt === 1 || attempt % CONFIG.captureRetryEvery === 0;
}

async function saveArtifacts(page, prefix) {
  ensureDir(CONFIG.outputDir);
  const time = timestamp();
  const fullPath = path.join(CONFIG.outputDir, `${prefix}-${time}-full.png`);
  await page.screenshot({ path: fullPath, fullPage: true });

  const qrCandidates = [
    ".ticket-card",
    ".qr-container",
    ".ticket-qr",
    "canvas",
    "img",
  ];
  for (const selector of qrCandidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        const qrPath = path.join(CONFIG.outputDir, `${prefix}-${time}-qr.png`);
        await locator.screenshot({ path: qrPath });
        return { fullPath, qrPath };
      } catch {
        return { fullPath };
      }
    }
  }

  return { fullPath };
}

async function saveRetryArtifacts(page, prefix, attempt) {
  if (!shouldCaptureRetry(attempt)) return null;
  return saveArtifacts(page, prefix);
}

async function safeNavigate(page, attempt) {
  const shouldReload = attempt > 1 && (attempt % Math.max(1, CONFIG.reloadEveryAttempts) === 0);

  try {
    if (attempt === 1) {
      await page.goto(CONFIG.url, { waitUntil: "domcontentloaded", timeout: 120000 });
    } else if (shouldReload) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    }
  } catch {
    await page.goto(CONFIG.url, { waitUntil: "domcontentloaded", timeout: 120000 });
  }

  if (CONFIG.pageSettleMs > 0) {
    await page.waitForTimeout(CONFIG.pageSettleMs);
  }
}

async function openAccessIfPresent(page) {
  const openButton = page
    .locator("button:has-text('ACCEDER AL SERVICIO'), a:has-text('ACCEDER AL SERVICIO')")
    .first();

  if (!(await openButton.count())) return;
  try {
    await openButton.click({ force: true, timeout: 900 });
    await page.waitForTimeout(150);
  } catch {
    // Si falla el click, se reintenta en la siguiente vuelta.
  }
}

async function runAttempt(page, attempt, account) {
  await safeNavigate(page, attempt);
  await openAccessIfPresent(page);

  const dniInput = page.locator("#dni, input[name='t1_dni']").first();
  const codigoInput = page.locator("#codigo, input[name='t1_codigo']").first();

  let hasForm = false;
  try {
    await Promise.all([
      dniInput.waitFor({ state: "visible", timeout: CONFIG.formWaitMs }),
      codigoInput.waitFor({ state: "visible", timeout: CONFIG.formWaitMs }),
    ]);
    hasForm = true;
  } catch {
    hasForm = false;
  }

  if (!hasForm) {
    const bodyPrecheck = normalizeText(await page.locator("body").textContent());
    const artifacts = await saveRetryArtifacts(page, `precheck-attempt-${attempt}-${account.dni}`, attempt);
    if (containsAny(bodyPrecheck, PRECHECK_MESSAGES) || containsAny(bodyPrecheck, RETRY_MESSAGES)) {
      return { status: "retry", reason: "Formulario aun no habilitado", artifacts };
    }
    return { status: "retry", reason: "No se encontro formulario DNI/Codigo", artifacts };
  }

  try {
    await dniInput.fill(account.dni, { timeout: 15000 });
    await codigoInput.fill(account.codigo, { timeout: 15000 });
    const submit = page.locator("button:has-text('GENERAR TICKET')").first();
    await submit.click({ timeout: CONFIG.formWaitMs });
    await page.waitForTimeout(CONFIG.afterSubmitWaitMs);
  } catch (error) {
    const bodyError = normalizeText(await page.locator("body").textContent());
    const artifacts = await saveRetryArtifacts(page, `interaction-attempt-${attempt}-${account.dni}`, attempt);
    if (
      String((error && error.name) || "").includes("Timeout") ||
      containsAny(bodyError, PRECHECK_MESSAGES) ||
      containsAny(bodyError, RETRY_MESSAGES)
    ) {
      return { status: "retry", reason: "Pantalla no lista para registrar aun", artifacts };
    }
    throw error;
  }

  const body = normalizeText(await page.locator("body").textContent());
  const hasSuccessButton = (await page.locator("button:has-text('Imprimir Ticket')").count()) > 0;
  const hasSuccessMessage = containsAny(body, SUCCESS_MESSAGES);

  if (hasSuccessButton || hasSuccessMessage) {
    const artifacts = await saveArtifacts(page, `success-attempt-${attempt}-${account.dni}`);
    return { status: "success", reason: "Ticket generado con QR", artifacts };
  }

  if (containsAny(body, FATAL_MESSAGES)) {
    const artifacts = await saveArtifacts(page, `fatal-attempt-${attempt}-${account.dni}`);
    return { status: "fatal", reason: "Dato invalido o ticket no permitido", artifacts };
  }

  if (containsAny(body, RETRY_MESSAGES)) {
    const artifacts = await saveRetryArtifacts(page, `retry-attempt-${attempt}-${account.dni}`, attempt);
    return { status: "retry", reason: "Servicio aun no disponible o sin cupos", artifacts };
  }

  const artifacts = await saveRetryArtifacts(page, `unknown-attempt-${attempt}-${account.dni}`, attempt);
  return { status: "retry", reason: "Respuesta no reconocida, se reintenta", artifacts };
}

async function processAccount(browser, account) {
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "font" || type === "media" || type === "stylesheet") {
      route.abort().catch(() => {});
      return;
    }
    route.continue().catch(() => {});
  });
  const page = await context.newPage();

  try {
    for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt += 1) {
      const result = await runAttempt(page, attempt, account);
      const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] intento ${attempt}/${CONFIG.maxAttempts}`;
      console.log(`${prefix}: ${result.status.toUpperCase()} - ${result.reason}`);

      if (result.artifacts) {
        console.log(`  captura: ${result.artifacts.fullPath}`);
        if (result.artifacts.qrPath) {
          console.log(`  qr: ${result.artifacts.qrPath}`);
        }
      }

      if (result.status === "success") {
        console.log(`[BATCH_SUCCESS] DNI: ${account.dni} | CAPTURA: ${result.artifacts.fullPath} | QR: ${result.artifacts.qrPath || 'null'}`);
        return { success: true, dni: account.dni };
      }

      if (result.status === "fatal") {
        console.log(`[BATCH_FATAL] DNI: ${account.dni} | ERROR: ${result.reason}`);
        return { success: false, dni: account.dni, reason: result.reason };
      }

      if (attempt < CONFIG.maxAttempts) {
        const delay = Math.max(100, CONFIG.retryDelayMs);
        await sleep(delay);
      }
    }
    return { success: false, dni: account.dni, reason: "Max intentos alcanzado" };
  } catch (error) {
    console.error(`[DNI: ${account.dni}] Error crítico: ${error.message}`);
    return { success: false, dni: account.dni, reason: error.message };
  } finally {
    await context.close();
  }
}

// ── RAW MODE: Mensajes retryables de la API ──
const RAW_RETRY_KEYWORDS = [
  "CUPOS", "HORARIO", "FUERA", "DISPONIBLE", "AGOTADOS",
  "INTENTE", "MANANA", "NO ENCONTRADO", "NO MATRICULADO"
];

function isRawRetryable(msg) {
  const upper = String(msg || "").toUpperCase();
  return RAW_RETRY_KEYWORDS.some(kw => upper.includes(kw));
}

// Warm-up: sondear la API hasta que responda con ÉXITO (200/201)
// LÓGICA CONSERVADORA: solo considerar "API abierta" con éxito real.
// Respuestas 404, sin message, o ambiguas = API cerrada, seguir sondeando.
async function warmUpWaitForApiOpen(probeAccount, maxWaitMs) {
  const maxWait = maxWaitMs || 10 * 60 * 1000; // 10 min máximo de espera
  const probeIntervalMs = 1500; // sondear cada 1.5 segundos
  const startTime = Date.now();
  let attempt = 0;

  console.log(`[WARMUP] Sondeando API con DNI ${probeAccount.dni} hasta que abra... (máx ${Math.round(maxWait / 1000)}s)`);

  while (Date.now() - startTime < maxWait) {
    attempt++;
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: probeAccount.dni, t1_codigo: probeAccount.codigo }));

      const res = await fetch("https://comensales.uncp.edu.pe/api/registros", {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(8000)
      });

      const json = await res.json();
      const msg = String(json.message || "").toUpperCase().trim();

      // Log detallado en los primeros 3 intentos y luego cada 10
      if (attempt <= 3 || attempt % 10 === 0) {
        console.log(`[WARMUP] Intento ${attempt} (${Math.round((Date.now() - startTime) / 1000)}s): code=${json.code} message="${json.message}"`);
      }

      // ── ÉXITO: La API abrió y aseguró cupo para la cuenta sonda ──
      if (json.code === 200 || json.code === 201) {
        console.log(`[WARMUP] ¡API ABIERTA! Cupo asegurado en sondeo para DNI ${probeAccount.dni} (intento ${attempt}, ${Math.round((Date.now() - startTime) / 1000)}s)`);
        console.log(`[RAW_SUCCESS] DNI: ${probeAccount.dni}`);
        return { open: true, probeSuccess: true, dni: probeAccount.dni };
      }

      // ── API CERRADA: code 404 sin message = formulario no habilitado ──
      if (json.code === 404 || !msg || msg === "UNDEFINED" || msg === "NULL") {
        await sleep(probeIntervalMs);
        continue;
      }

      // ── RETRY KEYWORDS: mensajes conocidos de "aún no disponible" ──
      if (isRawRetryable(msg)) {
        await sleep(probeIntervalMs);
        continue;
      }

      // ── "YA UTILIZADO" = la API está activa, ya tiene ticket previo ──
      if (msg.includes("YA UTILIZADO")) {
        console.log(`[WARMUP] API activa — cuenta sonda ya tiene ticket. Lanzando ataque.`);
        return { open: true, probeSuccess: true, dni: probeAccount.dni };
      }

      // ── Respuesta con mensaje real no reconocido = API posiblemente activa ──
      // Solo si el message tiene contenido real (no vacío/undefined)
      console.log(`[WARMUP] API respondió con mensaje no reconocido: code=${json.code} msg="${json.message}". Considerando API abierta.`);
      return { open: true, probeSuccess: false, dni: probeAccount.dni, reason: json.message };

    } catch (e) {
      // Timeout o error de red — API caída o saturadísima, seguir intentando
      if (attempt <= 3 || attempt % 10 === 0) {
        console.log(`[WARMUP] Intento ${attempt}: Timeout/Error de red (${e.message}), reintentando...`);
      }
      await sleep(probeIntervalMs);
    }
  }

  console.log(`[WARMUP] Tiempo máximo de espera agotado (${Math.round(maxWait / 1000)}s). Lanzando ataque de todas formas.`);
  return { open: false, probeSuccess: false };
}

// Ataque RAW agresivo para UNA cuenta (post-apertura)
// LÓGICA CONSERVADORA: solo detenerse en éxito real o error fatal con mensaje concreto.
// Respuestas 404, sin message, o ambiguas = seguir reintentando.
async function processAccountRawPost(account) {
  const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] [RAW]`;
  const maxPostAttempts = 150; // reintentos agresivos post-apertura (aumentado)
  const retryDelayPostMs = 250; // delay mínimo entre reintentos (250ms, más rápido)

  for (let attempt = 1; attempt <= maxPostAttempts; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: account.dni, t1_codigo: account.codigo }));

      const res = await fetch("https://comensales.uncp.edu.pe/api/registros", {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(8000)
      });

      const json = await res.json();
      const msg = String(json.message || "").toUpperCase().trim();

      // ── ÉXITO: cupo asegurado ──
      if (json.code === 200 || json.code === 201) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni}`);
        return { success: true, dni: account.dni, nombre: account.nombre };
      }

      // ── "YA UTILIZADO" = ya tiene cupo, es éxito ──
      if (msg.includes("YA UTILIZADO")) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni} (ticket ya existía en BD)`);
        return { success: true, dni: account.dni, nombre: account.nombre, note: "Ya tenía ticket" };
      }

      // ── 404 o sin message = API cerrada/no lista, REINTENTAR ──
      if (json.code === 404 || !msg || msg === "UNDEFINED" || msg === "NULL") {
        if (attempt % 20 === 0) console.log(`${prefix} Intento ${attempt}: API respondió code=${json.code} sin mensaje, reintentando...`);
        await sleep(retryDelayPostMs);
        continue;
      }

      // ── Keywords retryables conocidos ──
      if (isRawRetryable(msg)) {
        if (attempt % 15 === 0) console.log(`${prefix} Intento ${attempt}: ${json.message}`);
        await sleep(retryDelayPostMs);
        continue;
      }

      // ── HTTP 500 = error interno del servidor (lock de BD, saturación) → REINTENTAR ──
      if (json.code === 500) {
        if (attempt % 10 === 0) console.log(`${prefix} Intento ${attempt}: code=500 msg="${json.message || 'sin mensaje'}", reintentando...`);
        await sleep(retryDelayPostMs);
        continue;
      }

      // ── Error fatal REAL con mensaje concreto (no vacío, no 404, no 500) ──
      console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR: ${json.message} (code=${json.code})`);
      return { success: false, dni: account.dni, nombre: account.nombre, reason: json.message };

    } catch (e) {
      if (attempt % 15 === 0) console.log(`${prefix} Intento ${attempt}: Timeout/Error red (${e.message}), reintentando...`);
      await sleep(retryDelayPostMs);
    }
  }
  console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR: Max intentos post-apertura agotado (${maxPostAttempts})`);
  return { success: false, dni: account.dni, nombre: account.nombre, reason: "Max intentos post-apertura agotado" };
}

// Rescate: reintentos individuales con más paciencia para cuentas que fallaron en Fase 1
async function processAccountRawRescue(account) {
  const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] [RESCATE]`;
  const maxRescueAttempts = 80;
  const rescueDelayMs = 1000; // 1 segundo entre intentos (más calma)
  const rescueTimeoutMs = 15000; // timeout HTTP de 15s (más paciencia)

  console.log(`${prefix} Iniciando rescate (${maxRescueAttempts} intentos, ${rescueDelayMs}ms delay)...`);

  for (let attempt = 1; attempt <= maxRescueAttempts; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: account.dni, t1_codigo: account.codigo }));

      const res = await fetch("https://comensales.uncp.edu.pe/api/registros", {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(rescueTimeoutMs)
      });

      const json = await res.json();
      const msg = String(json.message || "").toUpperCase().trim();

      if (json.code === 200 || json.code === 201) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni} (rescatado en intento ${attempt})`);
        return { success: true, dni: account.dni, nombre: account.nombre, note: "Rescatado en Fase 2" };
      }

      if (msg.includes("YA UTILIZADO")) {
        console.log(`[RAW_SUCCESS] DNI: ${account.dni} (rescate: ticket ya existía)`);
        return { success: true, dni: account.dni, nombre: account.nombre, note: "Ya tenía ticket" };
      }

      // Si la API devuelve un mensaje de cupos agotados, no tiene sentido seguir
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
  return { success: false, dni: account.dni, nombre: account.nombre, reason: "Rescate agotado" };
}

async function main() {
  let accountsToRun = [];
  if (CONFIG.accountsJson) {
    try {
      accountsToRun = JSON.parse(CONFIG.accountsJson);
    } catch {
      console.error("Error parseando CHAROLA_ACCOUNTS");
    }
  }

  if (accountsToRun.length === 0) {
    accountsToRun.push({ dni: CONFIG.dni, codigo: CONFIG.codigo });
  }

  if (CONFIG.execMode === "raw") {
    console.log(`[${new Date().toLocaleString()}] Iniciando modo RAW para ${accountsToRun.length} cuenta(s).`);

    // ── FASE A: Warm-up — esperar a que la API abra ──
    const probeAccount = accountsToRun[0];
    const warmup = await warmUpWaitForApiOpen(probeAccount, 10 * 60 * 1000);

    // Determinar qué cuentas aún necesitan ataque
    let pendingAccounts;
    if (warmup.probeSuccess) {
      // La cuenta sonda ya consiguió cupo durante el warm-up
      pendingAccounts = accountsToRun.filter(a => a.dni !== probeAccount.dni);
      console.log(`[RAW] Cuenta sonda (${probeAccount.dni}) ya asegurada. Atacando ${pendingAccounts.length} restantes...`);
    } else {
      pendingAccounts = [...accountsToRun];
      console.log(`[RAW] API ${warmup.open ? 'abierta' : 'estado desconocido'}. Atacando TODAS las ${pendingAccounts.length} cuentas simultáneamente...`);
    }

    // ── FASE B: Ataque escalonado (50ms entre cada cuenta) ──
    const STAGGER_DELAY_MS = 50; // desfase entre cada cuenta para evitar lock de BD
    const results = [];
    if (warmup.probeSuccess) {
      results.push({ success: true, dni: probeAccount.dni, nombre: probeAccount.nombre });
    }

    if (pendingAccounts.length > 0) {
      // Lanzar cuentas con desfase de 50ms entre cada una
      console.log(`[RAW] Lanzando ${pendingAccounts.length} cuentas con desfase de ${STAGGER_DELAY_MS}ms (~${Math.round(pendingAccounts.length * STAGGER_DELAY_MS / 1000 * 10) / 10}s total)...`);
      const attackPromises = pendingAccounts.map((acc, index) => {
        return new Promise(resolve => {
          setTimeout(() => {
            processAccountRawPost(acc).then(resolve);
          }, index * STAGGER_DELAY_MS);
        });
      });
      const attackResults = await Promise.all(attackPromises);
      results.push(...attackResults);
    }

    // ── FASE C: Rescate — reintentar las que fallaron, una por una ──
    const phase1Failures = results.filter(r => !r.success);
    if (phase1Failures.length > 0) {
      console.log(`[RAW_RESCATE] ${phase1Failures.length} cuenta(s) fallaron en Fase 1. Reintentando individualmente...`);
      for (const fail of phase1Failures) {
        const account = pendingAccounts.find(a => a.dni === fail.dni);
        if (!account) continue;
        console.log(`[RAW_RESCATE] Reintentando DNI: ${account.dni} con delays más largos...`);
        const rescue = await processAccountRawRescue(account);
        // Reemplazar el resultado fallido con el de rescate
        const idx = results.findIndex(r => r.dni === fail.dni);
        if (idx !== -1) results[idx] = rescue;
      }
    }

    // ── Resumen final ──
    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success);
    
    // Imprimir resumen detallado
    console.log(`\n[RAW_RESUMEN] ═══════════════════════════════`);
    console.log(`[RAW_RESUMEN] Total: ${accountsToRun.length} | Éxitos: ${successes} | Fallos: ${failures.length}`);
    for (const r of results) {
      const label = r.nombre ? `${r.nombre} (${r.dni})` : `DNI: ${r.dni}`;
      if (r.success) {
        console.log(`[RAW_RESUMEN]   ✅ ${label}`);
      } else {
        console.log(`[RAW_RESUMEN]   ❌ ${label} → ${r.reason || 'desconocido'}`);
      }
    }
    console.log(`[RAW_RESUMEN] ═══════════════════════════════\n`);

    console.log(`[${new Date().toLocaleString()}] Ejecución RAW finalizada. Éxitos: ${successes}/${accountsToRun.length}`);
    
    // EXIT CODE HONESTO: 0 solo si al menos 1 cupo asegurado
    process.exit(successes > 0 ? 0 : 1);
  } else {
    ensureDir(CONFIG.outputDir);
    const browser = await chromium.launch({ headless: CONFIG.headless });
    console.log(`[${new Date().toLocaleString()}] Iniciando modo VISUAL para ${accountsToRun.length} cuenta(s) en lotes de ${CONFIG.chunkSize}.`);
    try {
      const results = [];
      for (let i = 0; i < accountsToRun.length; i += CONFIG.chunkSize) {
        const chunk = accountsToRun.slice(i, i + CONFIG.chunkSize);
        console.log(`[LOTE VISUAL] Procesando cuentas ${i + 1} a ${Math.min(i + CONFIG.chunkSize, accountsToRun.length)}...`);
        const chunkPromises = chunk.map(acc => processAccount(browser, acc));
        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);
        if (i + CONFIG.chunkSize < accountsToRun.length) await sleep(1500);
      }
      
      const successes = results.filter(r => r.success).length;
      console.log(`[${new Date().toLocaleString()}] Ejecución VISUAL finalizada. Éxitos: ${successes}/${accountsToRun.length}`);
      
      // EXIT CODE HONESTO: 0 solo si al menos 1 cupo asegurado
      process.exit(successes > 0 ? 0 : 1);
    } finally {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error("Error ejecutando automatizacion:", error);
  process.exit(1);
});
