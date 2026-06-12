/**
 * test-api-probe.js — Prueba de respuesta de API cerrada
 * 
 * Envía exactamente la misma petición que charola-engine.js
 * y muestra TODOS los detalles de la respuesta.
 */

const API_URL = "https://comensales.uncp.edu.pe/api/registros";

// Cuenta de prueba (DNI real del .env.example)
const TEST_DNI = "73968815";
const TEST_CODIGO = "2023200615D";

async function probeApi() {
  console.log("═══════════════════════════════════════════");
  console.log("  PRUEBA DE API — COMEDOR UNCP");
  console.log(`  Hora: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}`);
  console.log(`  URL: ${API_URL}`);
  console.log(`  DNI: ${TEST_DNI} | Código: ${TEST_CODIGO}`);
  console.log("═══════════════════════════════════════════\n");

  try {
    const formData = new FormData();
    formData.append("data", JSON.stringify({ t1_dni: TEST_DNI, t1_codigo: TEST_CODIGO }));

    console.log("[1] Enviando POST con FormData...\n");

    const startMs = Date.now();
    const res = await fetch(API_URL, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(15000)
    });
    const elapsed = Date.now() - startMs;

    console.log("── HTTP Response ──");
    console.log(`  HTTP Status: ${res.status} ${res.statusText}`);
    console.log(`  Tiempo: ${elapsed}ms`);
    console.log(`  Content-Type: ${res.headers.get('content-type')}`);
    
    console.log("\n── Headers ──");
    for (const [key, value] of res.headers.entries()) {
      if (['content-type', 'server', 'x-powered-by', 'access-control-allow-origin', 'cache-control', 'date'].includes(key.toLowerCase())) {
        console.log(`  ${key}: ${value}`);
      }
    }

    const rawBody = await res.text();
    console.log("\n── Body RAW ──");
    console.log(`  "${rawBody}"`);
    console.log(`  Largo: ${rawBody.length} chars`);

    console.log("\n── Body JSON ──");
    try {
      const json = JSON.parse(rawBody);
      console.log(`  json.code    = ${JSON.stringify(json.code)} (tipo: ${typeof json.code})`);
      console.log(`  json.message = ${JSON.stringify(json.message)} (tipo: ${typeof json.message})`);
      console.log(`  json.data    = ${JSON.stringify(json.data)}`);
      
      console.log("\n  Campos completos:");
      for (const [key, value] of Object.entries(json)) {
        console.log(`    ${key}: ${JSON.stringify(value)} (${typeof value})`);
      }

      const msg = String(json.message || "").toUpperCase().trim();
      const RAW_RETRY_KEYWORDS_OLD = ["CUPOS", "HORARIO", "FUERA", "DISPONIBLE", "AGOTADOS", "INTENTE", "MANANA", "NO ENCONTRADO", "NO MATRICULADO"];
      const matchedOldKeyword = RAW_RETRY_KEYWORDS_OLD.find(kw => msg.includes(kw));

      console.log("\n── Análisis del Engine ──");
      console.log(`  msg.toUpperCase() = "${msg}"`);
      console.log(`  json.code === 200? ${json.code === 200}`);
      console.log(`  json.code === 201? ${json.code === 201}`);
      console.log(`  json.code === 404? ${json.code === 404}`);
      console.log(`  json.code === 500? ${json.code === 500}`);
      console.log(`  msg vacío?         ${!msg || msg === "UNDEFINED" || msg === "NULL"}`);
      console.log(`  Old keyword match? ${matchedOldKeyword ? `SÍ: "${matchedOldKeyword}"` : "NO — NINGUNA KEYWORD COINCIDE"}`);

      console.log("\n══════════════════════════════════════");
      if (json.code === 200 || json.code === 201) {
        console.log("  VEREDICTO: API ABIERTA");
      } else if (json.code === 404 || !msg || msg === "UNDEFINED" || msg === "NULL") {
        console.log("  ENGINE VIEJO: Reintentaría (code 404/msg vacío)");
        console.log("  ENGINE NUEVO: Reintentaría");
      } else if (matchedOldKeyword) {
        console.log(`  ENGINE VIEJO: Reintentaría (keyword "${matchedOldKeyword}")`);
        console.log("  ENGINE NUEVO: Reintentaría");
      } else {
        console.log("  ENGINE VIEJO: SALDRIA DEL SONDEO — Asumiría API abierta!!!");
        console.log("  ENGINE NUEVO: Reintentaría (fix aplicado)");
      }
      console.log("══════════════════════════════════════\n");

    } catch (parseErr) {
      console.log(`  No es JSON: ${parseErr.message}`);
      console.log("\n  ENGINE VIEJO: Crash/error no manejado");
      console.log("  ENGINE NUEVO: Catch → reintentaría\n");
    }

  } catch (e) {
    console.log(`\nError de conexión: ${e.message} (${e.constructor.name})`);
    console.log("  Ambos engines reintentarían (catch de red)\n");
  }
}

async function main() {
  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- SONDEO #${i}/3 ---\n`);
    await probeApi();
    if (i < 3) {
      console.log("Esperando 2 segundos...\n");
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log("Prueba completada.");
}

main();
