const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const TURBO_DEFAULT = process.env.CHAROLA_TURBO_MODE !== "false";

const CONFIG = {
  url: "https://comedor.uncp.edu.pe/charola",
  dni: process.env.CHAROLA_DNI || "73968815",
  codigo: process.env.CHAROLA_CODIGO || "2023200615D",
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
};

const RETRY_MESSAGES = [
  "SIN CUPOS DISPONIBLES",
  "NO HAY TICKETS DISPONIBLES",
  "FUERA DE HORARIO",
  "INTENTE MANANA",
  "CUPOS AGOTADOS",
];

const FATAL_MESSAGES = [
  "USUARIO NO ENCONTRADO",
  "NO MATRICULADO",
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

async function runAttempt(page, attempt) {
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
    const artifacts = await saveRetryArtifacts(page, `precheck-attempt-${attempt}`, attempt);
    if (containsAny(bodyPrecheck, PRECHECK_MESSAGES) || containsAny(bodyPrecheck, RETRY_MESSAGES)) {
      return { status: "retry", reason: "Formulario aun no habilitado", artifacts };
    }
    return { status: "retry", reason: "No se encontro formulario DNI/Codigo", artifacts };
  }

  try {
    await dniInput.fill(CONFIG.dni, { timeout: 15000 });
    await codigoInput.fill(CONFIG.codigo, { timeout: 15000 });
    const submit = page.locator("button:has-text('GENERAR TICKET')").first();
    await submit.click({ timeout: CONFIG.formWaitMs });
    await page.waitForTimeout(CONFIG.afterSubmitWaitMs);
  } catch (error) {
    const bodyError = normalizeText(await page.locator("body").textContent());
    const artifacts = await saveRetryArtifacts(page, `interaction-attempt-${attempt}`, attempt);
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
    const artifacts = await saveArtifacts(page, `success-attempt-${attempt}`);
    return { status: "success", reason: "Ticket generado con QR", artifacts };
  }

  if (containsAny(body, FATAL_MESSAGES)) {
    const artifacts = await saveArtifacts(page, `fatal-attempt-${attempt}`);
    return { status: "fatal", reason: "Dato invalido o ticket no permitido", artifacts };
  }

  if (containsAny(body, RETRY_MESSAGES)) {
    const artifacts = await saveRetryArtifacts(page, `retry-attempt-${attempt}`, attempt);
    return { status: "retry", reason: "Servicio aun no disponible o sin cupos", artifacts };
  }

  const artifacts = await saveRetryArtifacts(page, `unknown-attempt-${attempt}`, attempt);
  return { status: "retry", reason: "Respuesta no reconocida, se reintenta", artifacts };
}

async function main() {
  ensureDir(CONFIG.outputDir);
  const browser = await chromium.launch({ headless: CONFIG.headless });
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
    console.log(
      `[${new Date().toLocaleString()}] Modo ${CONFIG.turboMode ? "TURBO" : "NORMAL"} | reintento ${CONFIG.retryDelayMs}ms | intentos max ${CONFIG.maxAttempts}`
    );
    for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt += 1) {
      const result = await runAttempt(page, attempt);
      const prefix = `[${new Date().toLocaleString()}] intento ${attempt}/${CONFIG.maxAttempts}`;
      console.log(`${prefix}: ${result.status.toUpperCase()} - ${result.reason}`);
      if (result.artifacts) {
        console.log(`  captura: ${result.artifacts.fullPath}`);
        if (result.artifacts.qrPath) {
          console.log(`  qr: ${result.artifacts.qrPath}`);
        }
      }

      if (result.status === "success") {
        await browser.close();
        process.exit(0);
      }

      if (result.status === "fatal") {
        await browser.close();
        process.exit(2);
      }

      if (attempt < CONFIG.maxAttempts) {
        const delay = Math.max(100, CONFIG.retryDelayMs);
        await sleep(delay);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.error("No se pudo generar ticket dentro del numero maximo de intentos.");
  process.exit(1);
}

main().catch((error) => {
  console.error("Error ejecutando automatizacion:", error);
  process.exit(1);
});
