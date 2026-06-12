# ComedorMachinBot — Contexto Completo

## 🎯 Qué es
Bot de Telegram que automatiza la reserva de cupos de comedor en la Universidad Nacional del Centro del Perú (UNCP). Funciona en un VPS de DigitalOcean ($12/mes, ubuntu-s-1vcpu-2gb-nyc2).

## 🏗️ Arquitectura

### Archivos principales
- **`telegram-bot.js`** — Controlador principal del bot de Telegram. Maneja comandos, menús, registro de cuentas, cron automático y reportes.
- **`charola-auto.js`** — Motor de ejecución. Se lanza como proceso hijo. Tiene dos modos: RAW (API directa) y VISUAL (Playwright/browser).
- **`settings.json`** — Estado persistente (cuentas, configuración, horarios).

### Flujo de ejecución (Modo Híbrido — el único activo)
### Arquitectura Distribuida (Nueva)
- **1 Servidor Principal (Coordinador)**: Ejecuta `telegram-bot.js`, hostea el Dashboard Web, el Cron Job a las 06:57 y distribuye la carga.
- **4 Workers**: Instancias VPS que ejecutan `worker-server.js` (Puerto 4000) y reciben peticiones del coordinador para ejecutar `charola-engine.js` (Fase 1).
- **Fase 1 (RAW Distribuida)**: El coordinador envía N/4 cuentas a cada worker en paralelo. Los workers ejecutan el Warm-up, esperan a que la API abra, atacan y reportan el resultado.
- **Fase 2 (Visual Local)**: Se ejecuta 20 minutos después en el servidor principal usando Playwright para capturar los tickets.

### Dashboard Web (Gestión)
- Se accede a través de la web con una `PANEL_KEY` estática.
- Permite ver el estado de los workers, estadísticas en tiempo real y el historial.
- Permite **agregar cuentas** con selección del usuario (Admin 1 o Admin 2).
- Permite **reordenar cuentas (Drag & Drop)**. El orden visual determina qué cuenta será la "Cuenta Sonda" (las primeras 4 cuentas de la lista actúan como sondas para detectar la apertura de la API).

## 🐛 Problemas resueltos (Junio 2026)

### 1. Fallo de autenticación en Workers (2026-06-11)
- **Bug**: Los workers devolvían siempre HTTP 401 Unauthorized a pesar de tener el `.env`.
- **Razón**: `worker-server.js` no estaba requiriendo `dotenv/config`, por lo que `process.env.WORKER_API_KEY` era `undefined`.
- **Fix**: Se agregó `require("dotenv").config()` al inicio de `worker-server.js`.

### 2. Dashboard mostraba Workers como Offline (2026-06-11)
- **Bug**: El dashboard web mostraba los workers en rojo "Offline" pero con el Uptime correcto.
- **Razón**: El endpoint `/health` de los workers respondía con `status: "ok"`, pero el frontend esperaba estrictamente `status: "online"`.
- **Fix**: Se actualizó `panel/app.js` para aceptar `"ok"` como válido.

### 3. Falta de control sobre el orden y asignación de cuentas
- **Bug**: Al agregar cuentas desde el panel, todas iban al Admin principal y el orden era de inserción.
- **Fix**: Se agregó un selector de usuario y la funcionalidad Drag & Drop en el panel web para reordenar cuentas y decidir las "sondas".

## ⚙️ Parámetros actuales

### Coordinador
- **Workers**: 4 (`134.209.34.113`, `157.230.189.111`, `165.232.59.167`, `143.198.111.123`)
- **Timeout y AbortSignal**: Manejado correctamente si un worker se cae, con fallback de ejecución local.

## 📋 Plan de escalado
1. ✅ Arquitectura distribuida configurada (1 Coordinador + 4 Workers).
2. ✅ Manejo de 21 cuentas exitoso.
3. ⬜ Próximo objetivo de usuario: Escalar a **60 cuentas** para atrapar los 300 cupos en los 5 segundos de ventana. Con 4 workers, equivale a 15 cuentas por worker (una sonda + 3.5 oleadas de ataque). Debería completarse en ~2 segundos.

## 💡 Ideas pendientes (no implementadas)
- Dashboard responsivo para móviles (actualmente mejor en escritorio).
- Filtros avanzados y paginación en el lado del servidor para las cuentas si pasan de 100.
