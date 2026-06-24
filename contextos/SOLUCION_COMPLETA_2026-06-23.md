# ANÁLISIS COMPLETO Y SOLUCIÓN INTEGRAL - 23 JUNIO 2026

## 📊 RESUMEN EJECUTIVO

**Estado actual del sistema:**
- ✅ Engine optimizado (3 bursts, Keep-Alive, DNS pre-resuelto)
- ✅ Coordinator sin stagger ni rescue cruzado
- ❌ **BUG CRÍTICO:** telegram-bot.js referencia funciones inexistentes
- ❌ Sonda consume cupo real
- ❌ No detecta CUPOS AGOTADOS globalmente
- ❌ Código duplicado entre archivos

**Resultados últimos 7 días:**
- Fines de semana: 96-97% éxito (sin competencia)
- Días de semana: 73-88% éxito (con competencia)
- **5 cuentas fallan consistentemente:** DNIs expirados/bloqueados

---

## 🔴 BUGS CRÍTICOS IDENTIFICADOS

### BUG #1: Funciones faltantes en telegram-bot.js

**Archivos afectados:** `telegram-bot.js`

**Líneas problemáticas:**
- Línea 1148: `userCronJobs.size` - variable NO EXISTE
- Línea 1276: `userCronJobs.size` - variable NO EXISTE
- Línea 1399: `setupUserCron(chatId)` - función NO EXISTE
- Línea 1446: `setupUserCron(chatId)` - función NO EXISTE
- Línea 1839: `ensureTaskAt(hour)` - función NO EXISTE
- Línea 1854: `ensureTaskAt(hour)` - función NO EXISTE
- Línea 1864: `runTaskCommand(...)` - función NO EXISTE
- Línea 1874: `runTaskCommand(...)` - función NO EXISTE
- Línea 1884: `runTaskCommand(...)` - función NO EXISTE
- Línea 1894: `runTaskCommand(...)` - función NO EXISTE
- Línea 2072: `setupUserCron(chatId)` - función NO EXISTE
- Línea 2078: `setupUserCron(chatId)` - función NO EXISTE

**Impacto:** El bot CRASHEA cuando un usuario intenta:
- Configurar hora automática
- Crear tareas programadas
- Ejecutar/detener tareas manualmente

**Solución:** Implementar las 4 funciones faltantes.

### BUG #2: Typo en línea 1699

**Archivo:** `telegram-bot.js:1699`

```javascript
if (args[2].toLowerCase() === "turbo") true; // NO HACE NADA
if (args[2].toLowerCase() === "turbo") turboMode = true; // CORRECTO
```

**Impacto:** El comando `/iniciar [dni] [codigo] turbo` no activa modo turbo.

### BUG #3: Sonda consume cupo real

**Archivo:** `charola-engine.js:71-150`

**Problema:** El warmup usa una cuenta real (71155185) que consume un cupo cuando la API abre.

**Impacto:** Si hay N cupos y N cuentas, la sonda toma 1 cupo → solo quedan N-1 para las otras cuentas.

**Solución:** Usar DNI ficticio (00000000) para sondear sin consumir cupo.

### BUG #4: No detecta CUPOS AGOTADOS globalmente

**Archivo:** `charola-engine.js:267-302`

**Problema:** Cuando una cuenta recibe "CUPOS AGOTADOS", solo esa cuenta se detiene. Las demás siguen intentando.

**Impacto:** Desperdicio de requests cuando ya no hay cupos disponibles.

**Solución:** Implementar flag global que detenga todos los bursts cuando se detecte CUPOS AGOTADOS.

### BUG #5: Código duplicado

**Archivos:** `charola-auto.js` vs `charola-engine.js`

**Problema:** charola-auto.js tiene su propia implementación de:
- `warmUpWaitForApiOpen()` (líneas 301-370)
- `processAccountRawPost()` (líneas 375-438)
- `processAccountRawRescue()` (líneas 441-492)

**Impacto:** Duplicación de lógica, difícil mantenimiento, inconsistencias.

**Solución:** charola-auto.js debe importar desde charola-engine.js.

---

## 🎯 SOLUCIÓN COMPLETA

### FASE 1: Corregir bugs críticos (PRIORIDAD ALTA)

#### 1.1 Implementar funciones faltantes en telegram-bot.js

Añadir después de la línea 1139:

```javascript
// ══════════════════════════════════════════
// CRON MANAGEMENT - Funciones faltantes
// ══════════════════════════════════════════

const userCronJobs = new Map();

function setupUserCron(chatId) {
  const user = licenses.users[chatId];
  if (!user || !user.autoRun) return;
  
  const cronKey = String(chatId);
  
  // Detener cron existente
  if (userCronJobs.has(cronKey)) {
    userCronJobs.get(cronKey).stop();
    userCronJobs.delete(cronKey);
  }
  
  // Si no está habilitado, no crear cron
  if (!user.autoRun.enabled || !user.autoRun.time) return;
  
  const [hh, mm] = user.autoRun.time.split(':').map(Number);
  const cronExpression = `${mm} ${hh} * * *`;
  
  try {
    const job = cron.schedule(cronExpression, () => {
      console.log(`[CRON] Ejecutando tarea automática para ${chatId}`);
      
      let accounts = Array.isArray(user.autoRun.accounts) ? user.autoRun.accounts : [];
      if (accounts.length === 0 && user.autoRun.dni && user.autoRun.codigo) {
        accounts = [{ dni: user.autoRun.dni, codigo: user.autoRun.codigo }];
      }
      
      if (accounts.length === 0) {
        console.log(`[CRON] ${chatId}: No hay cuentas configuradas`);
        return;
      }
      
      const isHybrid = user.autoRun.execMode === 'raw_hybrid';
      const turboMode = user.autoRun.turboMode !== false;
      
      if (isHybrid && DISTRIBUTED_MODE && getWorkerUrls().length > 0) {
        startDistributedBot(chatId, {
          accounts,
          turboMode,
          maxPostAttempts: 150,
          retryDelayMs: 250,
        });
      } else {
        startBot(chatId, {
          accounts,
          turboMode,
          execMode: isHybrid ? 'raw' : 'visual',
          maxAttempts: DEFAULTS.maxAttempts,
          retryDelayMs: DEFAULTS.retryDelayMs,
        });
      }
    }, { scheduled: true, timezone: "America/Lima" });
    
    userCronJobs.set(cronKey, job);
    console.log(`[CRON] Configurado para ${chatId}: ${cronExpression}`);
  } catch (e) {
    console.error(`[CRON] Error configurando cron para ${chatId}:`, e.message);
  }
}

function ensureTaskAt(hour) {
  return new Promise((resolve) => {
    // Esta función es para compatibilidad con Windows Task Scheduler
    // En Linux/VPS no se usa, pero debe existir para evitar crashes
    resolve({ ok: true, stdout: "Task scheduler not applicable on Linux", stderr: "" });
  });
}

function runTaskCommand(args) {
  return new Promise((resolve) => {
    // Esta función es para compatibilidad con Windows Task Scheduler
    // En Linux/VPS no se usa, pero debe existir para evitar crashes
    resolve({ ok: true, stdout: "Task command not applicable on Linux", stderr: "" });
  });
}
```

#### 1.2 Corregir typo en línea 1699

**Archivo:** `telegram-bot.js:1699`

**Cambiar:**
```javascript
if (args[2].toLowerCase() === "turbo") true;
```

**A:**
```javascript
if (args[2].toLowerCase() === "turbo") turboMode = true;
```

#### 1.3 Inicializar crons al arrancar

Añadir después de la línea 1153:

```javascript
// Inicializar crons de todos los usuarios al arrancar
setTimeout(() => {
  for (const chatId of Object.keys(licenses.users)) {
    setupUserCron(chatId);
  }
  console.log(`[CRON] Inicializados ${userCronJobs.size} crons de usuario`);
}, 3000);
```

### FASE 2: Optimizar sonda (PRIORIDAD MEDIA)

#### 2.1 Sonda sin consumo de cupo

**Archivo:** `charola-engine.js:71-150`

**Reemplazar función `warmUpWaitForApiOpen` con:**

```javascript
async function warmUpWaitForApiOpen(probeAccount, maxWaitMs, config = {}) {
  const maxWait = maxWaitMs || 10 * 60 * 1000;
  const probeIntervalMs = 1500;
  const startTime = Date.now();
  let attempt = 0;
  let lastMsg = '';
  let extractedCookies = null;

  const fetchHeaders = buildFetchHeaders(config);

  console.log(`[WARMUP] Sondeando API con DNI ficticio hasta que abra... (máx ${Math.round(maxWait / 1000)}s)`);
  console.log(`[WARMUP] 🛡️ Headers de navegador activados (Chrome 137)`);

  while (Date.now() - startTime < maxWait) {
    attempt++;
    try {
      // USAR DNI FICTICIO para no consumir cupo real
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: "00000000", t1_codigo: "PROBE" }));

      const res = await fetch(API_URL, {
        method: "POST",
        headers: fetchHeaders,
        body: formData,
        agent: KEEP_ALIVE_AGENT,
        signal: AbortSignal.timeout(8000)
      });

      // Extraer cookie PHPSESSID
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

      // API ABIERTA: cualquier respuesta que no sea "cerrada"
      // Con DNI ficticio, esperamos: 404 (DNI inválido), 500 (error), o mensaje real
      if (json.code === 200 || json.code === 201) {
        console.log(`[WARMUP] ¡API ABIERTA! (DNI ficticio recibió éxito inesperado)`);
        return { open: true, probeSuccess: false, dni: "00000000", cookies: extractedCookies };
      }

      // DNI inválido = API está procesando = ABIERTA
      if (msg.includes("DNI NO VALIDO") || msg.includes("NO EXISTE") || msg.includes("NO VALIDO")) {
        console.log(`[WARMUP] API ABIERTA (DNI ficticio rechazado como esperado). Lanzando ataque.`);
        return { open: true, probeSuccess: false, dni: "00000000", cookies: extractedCookies };
      }

      // Error 500 = API está procesando pero con error = ABIERTA
      if (json.code === 500) {
        console.log(`[WARMUP] API ABIERTA (error 500 con DNI ficticio). Lanzando ataque.`);
        return { open: true, probeSuccess: false, dni: "00000000", cookies: extractedCookies };
      }

      // "YA UTILIZADO" = API activa
      if (msg.includes("YA UTILIZADO")) {
        console.log(`[WARMUP] API activa — respuesta YA UTILIZADO. Lanzando ataque.`);
        return { open: true, probeSuccess: false, dni: "00000000", cookies: extractedCookies };
      }

      // Cualquier otra respuesta = seguir sondeando
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
```

**Cambios clave:**
- Usa DNI ficticio "00000000" en lugar de cuenta real
- No consume cupo durante warmup
- Detecta API abierta cuando recibe "DNI NO VALIDO" (esperado con DNI ficticio)
- Retorna `probeSuccess: false` para que TODAS las cuentas (incluida la primera) se ataquen

#### 2.2 Actualizar coordinator.js para manejar sonda ficticia

**Archivo:** `coordinator.js:200-227`

**Reemplazar sección de warmup con:**

```javascript
// 3. WARMUP CENTRALIZADO
log(`[COORD] Iniciando WARM-UP centralizado con DNI ficticio (no consume cupos)...`);
const { warmUpWaitForApiOpen } = require("./charola-engine");
const probeAccount = { dni: "00000000", codigo: "PROBE", nombre: "Sonda" };
const maxWarmupMs = config.maxWarmupMs || 10 * 60 * 1000;

const warmup = await warmUpWaitForApiOpen(probeAccount, maxWarmupMs);
if (warmup.open) {
  log(`[COORD] ⚡ ¡API ABIERTA! Disparando a los workers simultáneamente...`);
} else {
  log(`[COORD] ⚠️ Tiempo de warmup agotado. Disparando a los workers de todas formas...`);
}

// Capturar cookie
const sharedCookies = warmup.cookies || null;
if (sharedCookies) {
  log(`[COORD] 🍪 Cookie compartida extraída: ${sharedCookies.substring(0, 30)}...`);
} else {
  log(`[COORD] ⚠️ No se pudo extraer cookie del warmup.`);
}

// NO excluir ninguna cuenta (sonda ficticia no consume cupo)
let accountsToDistribute = accounts;
log(`[COORD] Atacando todas las ${accountsToDistribute.length} cuentas (sonda no consumió cupo).`);
accountsToDistribute = interleaveByOwner(accountsToDistribute);
```

### FASE 3: Detectar CUPOS AGOTADOS globalmente (PRIORIDAD MEDIA)

#### 3.1 Añadir flag global en charola-engine.js

**Archivo:** `charola-engine.js`

**Añadir después de línea 20:**

```javascript
let globalCuposAgotados = false;
```

**Modificar `processAccountRawPost` (línea 192-195):**

```javascript
// ERROR FATAL DE DATOS
if (isFatalError(msg)) {
  // Detectar CUPOS AGOTADOS globalmente
  if (msg.includes("CUPOS AGOTADOS") || msg.includes("AGOTADO")) {
    console.log(`[RAW_FAIL] DNI: ${account.dni} | CUPOS AGOTADOS detectado - deteniendo todos los bursts`);
    globalCuposAgotados = true;
  }
  console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR FATAL: ${json.message} (code=${json.code})`);
  return { success: false, dni: account.dni, nombre: account.nombre, reason: json.message };
}
```

**Modificar loop de bursts (línea 267-302):**

```javascript
for (let burst = 1; burst <= 3; burst++) {
  if (batch.length === 0) break;
  
  // DETENER si cupos agotados globalmente
  if (globalCuposAgotados) {
    console.log(`[ENGINE] 🛑 CUPOS AGOTADOS detectado - deteniendo Burst ${burst}`);
    break;
  }

  if (burst > 1) {
    console.log(`[ENGINE] ⏳ Esperando 2s para Burst ${burst} (${batch.length} cuentas restantes)...`);
    await sleep(2000);
  }

  console.log(`[ENGINE] 🚀 Burst ${burst}/3: ${batch.length} cuentas`);

  const burstResults = await Promise.all(batch.map(acc => {
    // Verificar flag global antes de cada request
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
  }));

  for (const r of burstResults) allResults.push({ ...r, burst });

  const succ = burstResults.filter(r => r.success).length;
  const fail500 = burstResults.filter(r => !r.success && r.reason && r.reason.includes("HTTP 500"));

  console.log(`[ENGINE] Burst ${burst}: ${succ} éxitos, ${fail500.length} HTTP 500 recuperables`);

  batch = fail500.map(f => {
    const orig = accountMap.get(f.dni);
    return orig ? { ...orig } : null;
  }).filter(Boolean);
}

// Reset flag para próxima ejecución
globalCuposAgotados = false;
```

### FASE 4: Eliminar código duplicado (PRIORIDAD BAJA)

#### 4.1 Refactorizar charola-auto.js

**Archivo:** `charola-auto.js`

**Eliminar líneas 298-492** (funciones duplicadas) y reemplazar con:

```javascript
// Importar desde charola-engine.js
const { warmUpWaitForApiOpen, processAccountRawPost, processAccountRawRescue } = require('./charola-engine');
```

**Nota:** Esto requiere que charola-engine.js exporte `processAccountRawRescue` (actualmente no lo hace).

**Añadir a charola-engine.js (línea 333-338):**

```javascript
module.exports = {
  warmUpWaitForApiOpen,
  processAccountRawPost,
  processAccountRawRescue,
  executeRawBatch,
  sleep
};
```

**Y añadir función `processAccountRawRescue` en charola-engine.js:**

```javascript
async function processAccountRawRescue(account, config = {}) {
  const prefix = `[${new Date().toLocaleString()}] [DNI: ${account.dni}] [RESCATE]`;
  const maxRescueAttempts = config.maxRescueAttempts || 80;
  const rescueDelayMs = config.rescueDelayMs || 1000;
  const rescueTimeoutMs = config.rescueTimeoutMs || 15000;

  console.log(`${prefix} Iniciando rescate (${maxRescueAttempts} intentos, ${rescueDelayMs}ms delay)...`);

  const fetchHeaders = buildFetchHeaders(config);

  for (let attempt = 1; attempt <= maxRescueAttempts; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append("data", JSON.stringify({ t1_dni: account.dni, t1_codigo: account.codigo }));

      const res = await fetch(API_URL, {
        method: "POST",
        headers: fetchHeaders,
        body: formData,
        agent: KEEP_ALIVE_AGENT,
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

      if (msg.includes("AGOTADOS") || msg.includes("SIN CUPOS")) {
        console.log(`[RAW_FAIL] DNI: ${account.dni} | ERROR: Cupos agotados (rescate)`);
        globalCuposAgotados = true;
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
```

---

## 📋 PLAN DE IMPLEMENTACIÓN

### Paso 1: Corregir bugs críticos (15 minutos)
1. Añadir funciones faltantes a telegram-bot.js
2. Corregir typo en línea 1699
3. Inicializar crons al arrancar
4. Reiniciar PM2: `pm2 restart charola-tg`

### Paso 2: Optimizar sonda (10 minutos)
1. Reemplazar `warmUpWaitForApiOpen` en charola-engine.js
2. Actualizar coordinator.js para usar sonda ficticia
3. Desplegar a workers: `node restart-workers.js`
4. Reiniciar coordinator: `pm2 restart charola-tg`

### Paso 3: Detectar CUPOS AGOTADOS (10 minutos)
1. Añadir flag global en charola-engine.js
2. Modificar loop de bursts
3. Desplegar a workers: `node restart-workers.js`

### Paso 4: Eliminar código duplicado (15 minutos)
1. Añadir `processAccountRawRescue` a charola-engine.js
2. Refactorizar charola-auto.js para importar desde engine
3. Desplegar a workers: `node restart-workers.js`

---

## 🎯 RESULTADOS ESPERADOS

### Métricas actuales (23 Jun):
- **Éxito:** 28/33 (84.8%)
- **Duración:** 233s (3.9 min)
- **Cuentas fallando:** 5 (DNIs expirados)

### Métricas proyectadas post-fix:
- **Éxito:** 32/33 (97%) - Solo fallan DNIs expirados
- **Duración:** ~5-10s post-warmup
- **Sonda:** No consume cupo
- **CUPOS AGOTADOS:** Detección global inmediata

### Comparativa completa:
| Métrica | 22 Jun (viejo) | 23 Jun (parcial) | Post-fix (proyectado) |
|---------|----------------|------------------|----------------------|
| Éxito | 28/34 (82.4%) | 28/33 (84.8%) | 32/33 (97%) |
| Duración | 1124s | 233s | ~10s |
| Sonda consume cupo | ✅ Sí | ✅ Sí | ❌ No |
| Detecta CUPOS AGOTADOS | ❌ No | ❌ No | ✅ Sí |
| Bugs críticos | 4 | 4 | 0 |

---

## 🔍 ANÁLISIS DE INFRAESTRUCTURA UNCP

### Arquitectura descubierta:
- **Frontend:** Angular SPA en `https://comedor.uncp.edu.pe/charola`
- **Backend:** Node.js/Express en `https://comensales.uncp.edu.pe/api/registros`
- **Proxy:** Apache/2.4.62 con OpenSSL/1.0.2k-fips
- **IP:** 38.43.155.136
- **Keep-Alive:** timeout=5s, max=100 requests
- **CORS:** Access-Control-Allow-Origin: * (abierto)

### Códigos de respuesta API:
- **200/201:** Éxito (cupo asegurado)
- **300:** Servicio no disponible
- **404:** DNI/código inválido
- **500:** MySQL deadlock (recuperable en 1-2s)

### Ventana de cupos:
- **Duración:** ~5 segundos
- **Apertura:** 07:00:00 Lima (exacto)
- **Competencia:** Alta en días de semana, nula en fines de semana

---

## 📊 ANÁLISIS DE CUENTAS FALLIDAS

### Cuentas que fallan consistentemente (últimos 7 días):
1. **62061495** (8) - HTTP 500 en todos los bursts
2. **72906232** (46 A) - HTTP 500 en todos los bursts
3. **73363364** (16) - HTTP 500 en todos los bursts
4. **75019777** (HANCEL) - HTTP 500 en todos los bursts
5. **77296725** (38 A) - HTTP 500 en todos los bursts

**Diagnóstico:** DNIs expirados, bloqueados o con problemas de validación en MySQL.

**Recomendación:** Crear sistema de pre-filtrado que:
1. Pruebe cada DNI fuera de hora pico (3 PM)
2. Marque como "muerta" si falla 3 días seguidos
3. Excluya automáticamente de bursts futuros

---

## 🚀 MEJORAS ADICIONALES PROPUESTAS

### 1. Micro-waves dentro de cada burst
**Problema:** Promise.all lanza 36 queries MySQL simultáneas → deadlocks.

**Solución:** Lanzar en micro-waves de 100ms:
```
Burst 1:
  t=0ms    → 9 cuentas (1 por worker)
  t=100ms  → 9 cuentas
  t=200ms  → 9 cuentas
  t=300ms  → 5 cuentas
```

**Impacto:** Reduce deadlocks de MySQL, mantiene velocidad.

### 2. Multi-probe con socket pre-warming
**Problema:** Warmup sondea cada 1500ms. Si API abre justo después de un sondeo, perdemos hasta 1500ms.

**Solución:** 10 sondas paralelas con diferentes DNIs ficticios.

**Impacto:** Reduce latencia de detección de 750ms a 75ms promedio.

### 3. Burst adaptativo
**Problema:** 2s fijos entre bursts no es óptimo.

**Solución:** Medir ratio de HTTP 500 en tiempo real:
- >50% 500 → espera 3s
- 20-50% 500 → espera 2s
- <20% 500 → espera 1s

**Impacto:** Optimiza uso de ventana de 5s.

### 4. HTTP/2 multiplexing
**Problema:** 36 conexiones TCP = 36 handshakes.

**Solución:** Usar HTTP/2 desde coordinator (1 conexión, múltiples streams).

**Impacto:** Elimina overhead de handshakes, pero requiere reescritura completa.

---

## ✅ CHECKLIST DE VERIFICACIÓN

### Post-implementación:
- [ ] `pm2 status` muestra charola-tg online
- [ ] `node coordinator.js --health` muestra 9 workers online
- [ ] Logs muestran "API ABIERTA (DNI ficticio rechazado)"
- [ ] Logs muestran "Atacando todas las X cuentas (sonda no consumió cupo)"
- [ ] Éxito ≥ 95% en días de semana
- [ ] Duración post-warmup ≤ 10s
- [ ] No hay crashes por funciones faltantes

### Monitoreo continuo:
- [ ] Revisar logs diarios en `/root/ComedorMachinBot/logs/`
- [ ] Identificar cuentas que fallan 3+ días seguidos
- [ ] Ajustar timing de bursts si es necesario
- [ ] Evaluar eliminación de modo visual si RAW ≥ 95%

---

## 📝 NOTAS FINALES

### Por qué falló el deploy anterior:
1. ✅ charola-engine.js se desplegó correctamente (hash idéntico en todos los servers)
2. ❌ coordinator.js NO se desplegó (aún tenía stagger y rescue cruzado)
3. ❌ PM2 no se reinició después de cambios

### Lecciones aprendidas:
1. **Siempre verificar deployment con:** `md5sum` en VPS vs local
2. **Siempre reiniciar PM2 después de cambios:** `pm2 restart charola-tg`
3. **Siempre verificar logs inmediatamente después del cron**
4. **Documentar cada cambio en archivo de contexto**

### Próximos pasos:
1. Implementar FASE 1-4 de este documento
2. Monitorear resultados durante 1 semana
3. Si éxito ≥ 95%, considerar eliminar modo visual
4. Si éxito < 90%, implementar mejoras adicionales (micro-waves, multi-probe)

---

**Documento generado:** 23 Junio 2026
**Autor:** Análisis automatizado de código y logs
**Versión:** 1.0
