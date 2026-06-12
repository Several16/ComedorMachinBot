# ComedorMachinBot — Contexto Completo

## 🎯 Qué es
Bot de Telegram que automatiza la reserva de cupos de comedor en la Universidad Nacional del Centro del Perú (UNCP). Funciona en un VPS de DigitalOcean ($12/mes, ubuntu-s-1vcpu-2gb-nyc2).

## 🏗️ Arquitectura

### Archivos principales
- **`telegram-bot.js`** — Controlador principal del bot de Telegram. Maneja comandos, menús, registro de cuentas, cron automático y reportes.
- **`charola-auto.js`** — Motor de ejecución. Se lanza como proceso hijo. Tiene dos modos: RAW (API directa) y VISUAL (Playwright/browser).
- **`settings.json`** — Estado persistente (cuentas, configuración, horarios).

### Flujo de ejecución (Modo Híbrido — el único activo)
1. **Fase 1 - RAW** (6:57 AM Lima): Ataque directo a la API `https://comensales.uncp.edu.pe/api/registros`
   - Warm-up: sondea con 1 cuenta hasta que la API responda (7:00 AM)
   - Ataque: lanza TODAS las cuentas con 30ms de desfase entre cada una
   - Reintentos: 50 intentos × 100ms = 5 segundos (toda la ventana de cupos)
   - Rescate: si alguna falla, pausa 3s + 15 intentos × 500ms
2. **Fase 2 - VISUAL** (20 min después): Abre Playwright para capturar QR/screenshots de los tickets obtenidos

### API de la universidad
- **Endpoint**: `POST https://comensales.uncp.edu.pe/api/registros`
- **Body**: FormData con `dni` y `codigo`
- **Respuestas**:
  - `code: 200/201` → Éxito, cupo asegurado
  - `code: 300` → API cerrada (aún no son las 7 AM)
  - `code: 404` → No encontrado / servicio cerrado
  - `code: 500` → Error interno del servidor (deadlock de BD)
  - `message: "YA UTILIZADO"` → Ya tiene ticket (se cuenta como éxito)
  - `message` con "AGOTADOS" o "SIN CUPOS" → Cupos terminados

### Ventana de cupos
- **Los cupos duran 4-5 segundos** después de las 7:00 AM Lima
- Todo reintento después de ese periodo es inútil
- Por eso los parámetros están optimizados para concentrar intentos en esos 5 segundos

## 👤 Usuario
- Maneja actualmente **12 cuentas**, planea escalar a **40 cuentas**
- Chat IDs en el bot: `1318767547` y `7586581687`
- Las cuentas tienen: DNI, Código, y Nombre (etiqueta)

## 🐛 Problemas resueltos

### 1. Cuenta con typo (2026-05-31)
- DNI `74526655` tenía código mal digitado → siempre fallaba
- Se corrigió el código y empezó a funcionar

### 2. Mode Playwright accidental (2026-06-03)
- El bot corrió en modo VISUAL puro en vez de Híbrido
- Procesaba cuentas de 5 en 5 con Playwright → muy lento
- Una cuenta quedó 3+ horas en loop reintentando "sin cupos"
- **Fix**: Eliminar opción de modo Playwright, forzar siempre Híbrido

### 3. Límite inteligente en Fase Visual (2026-06-03)
- Si recibe "sin cupos" 30 veces consecutivas → para automáticamente
- Evita loops de 3 horas cuando los cupos ya se agotaron

### 4. Deadlock de BD — code 500 (2026-06-03)
- Al enviar 12 cuentas simultáneas, una al azar recibía `code: 500` sin mensaje
- El servidor creaba un deadlock que persistía por minutos
- La cuenta fallida reintentaba 230 veces (150 + 80 rescate) sin éxito
- **Fix aplicado**:
  - `code: 500` explícitamente retryable (además del check `!msg`)
  - Stagger reducido a 30ms (40 cuentas en 1.2s, cabe en ventana de 5s)
  - Reintentos: 50 × 100ms = 5s (concentrados en la ventana)
  - Rescate: 3s pausa + 15 × 500ms (rápido)
- **Estado**: PENDIENTE DE PRUEBA (primera prueba: 2026-06-04)

## ⚙️ Parámetros actuales (charola-auto.js)

### Fase 1 — RAW
| Parámetro | Valor | Razón |
|-----------|-------|-------|
| `STAGGER_DELAY_MS` | 30ms | 40 cuentas en 1.2s, dentro de ventana 5s |
| `maxPostAttempts` | 50 | 50 × 100ms = 5s de reintentos |
| `retryDelayPostMs` | 100ms | Máxima velocidad en la ventana |

### Rescate
| Parámetro | Valor | Razón |
|-----------|-------|-------|
| Pausa pre-rescate | 3000ms | Dar tiempo mínimo a la BD |
| `maxRescueAttempts` | 15 | 15 × 500ms = 7.5s |
| `rescueDelayMs` | 500ms | Rápido, cupos aún podrían existir |

### Fase 2 — Visual
| Parámetro | Valor | Razón |
|-----------|-------|-------|
| `MAX_CONSECUTIVE_NO_CUPOS` | 30 | Límite inteligente: 30 "sin cupos" seguidos = parar |
| `maxAttempts` | 1200 | (pero parado por límite inteligente si aplica) |
| Batch size | 5 | Cuentas procesadas en paralelo por lote |

## 🔧 VPS — Comandos útiles

### Desplegar cambios
```bash
cd /root/ComedorMachinBot && git pull && pm2 restart charola-tg
```

### Ver estado
```bash
pm2 status
pm2 logs charola-tg --lines 30
```

### Ver log de Fase 1 (RAW) del día
```bash
cat /root/ComedorMachinBot/logs/$(ls -t /root/ComedorMachinBot/logs/ | grep T11-57 | head -1)
```

### Ver log de Fase 2 (Visual) del día
```bash
cat /root/ComedorMachinBot/logs/$(ls -t /root/ComedorMachinBot/logs/ | grep T12-17 | head -1)
```

### Ver logs más recientes
```bash
ls -lt /root/ComedorMachinBot/logs/ | head -10
```

## 📋 Plan de escalado
1. ✅ Probar con 12 cuentas (2026-06-04)
2. ⬜ Si 12/12 funciona → subir a 20
3. ⬜ Si 20/20 funciona → subir a 30-40
4. ⬜ Si con 40 falla → implementar "dos oleadas" (mitad y mitad separadas por 2s)
5. ⬜ Si aún falla → considerar múltiples VPS con diferentes IPs

## 📊 Logs — Qué buscar
- `[RAW_SUCCESS]` → Cuenta aseguró cupo en Fase 1
- `[RAW_FAIL]` → Cuenta falló (ver razón: code=500, rescate agotado, etc.)
- `[RAW_RESUMEN]` → Resumen final con ✅ y ❌
- `[BATCH_SUCCESS]` → Cuenta capturó QR en Fase 2
- `[BATCH_SMART_STOP]` → Fase 2 paró por límite inteligente (sin cupos)
- `[WARMUP]` → Sondeo pre-apertura

## 🚫 Cosas eliminadas
- **Modo Playwright puro**: Ya no se puede seleccionar. Siempre es Híbrido.
- **Botón de estrategia**: Removido del menú de Telegram.

## 💡 Ideas pendientes (no implementadas)
- **App web/dashboard** para gestionar cuentas (el usuario lo mencionó como idea)
- **Múltiples VPS** con diferentes IPs ($6/mes cada uno, 1GB RAM suficiente para RAW)
- **Proxies rotativos** para simular diferentes IPs desde un solo VPS
