# comedor-bot-telegram

Bot de Telegram para controlar la generación de ticket de charola y administrar licencias por usuario.

## Requisitos

- Node.js 18+ (recomendado LTS)
- npm
- Token de bot de Telegram
- Acceso a internet estable (DNS operativo)

## Variables de entorno

Mínimas:

- `TELEGRAM_BOT_TOKEN`
- `ADMIN_PANEL_KEY` (recomendado)

Opcionales:

- `TELEGRAM_ALLOWED_CHAT_ID`
- `TELEGRAM_ADMIN_CHAT_ID`
- `ADMIN_PANEL_PORT` (por defecto `4020`)
- `ADMIN_PANEL_PUBLIC_URL` (ej: `https://tu-dominio/panel` o `http://IP_VPS:4020`)
- `CHAROLA_TASK_NAME` (solo Windows)
- `CHAROLA_DNI`, `CHAROLA_CODIGO`
- `CHAROLA_MAX_PARALLEL_JOBS` (por defecto `20`)
- `CHAROLA_MAX_PARALLEL_JOBS_PER_CHAT` (por defecto `15`)
- `CHAROLA_LOADING_ACTION_INTERVAL_MS` (por defecto `4000`, indicador de "escribiendo...")
- `CHAROLA_NOTIFY_ON_FINISH` (por defecto `true`, avisa al chat al terminar cada job)
- `TELEGRAM_POLLING_INTERVAL_MS`, `TELEGRAM_POLLING_TIMEOUT_S`, `TELEGRAM_POLLING_RETRY_MS`, `TELEGRAM_POLLING_RETRY_MAX_MS`

## Inicio local (Windows)

1. `cd C:\Users\USUARIO\comedor-bot-telegram`
2. `npm install`
3. `npm run install:browsers`
4. Configurar variables de entorno
5. `.\iniciar-telegram.bat` o `npm start`

> Importante: solo debe haber **una instancia** del bot Telegram por token. Si hay otra encendida verás `409 Conflict` en polling.

## Despliegue en VPS Linux (PM2)

1. Instala Node.js y npm en tu VPS.
2. En la carpeta del proyecto:
   - `npm install`
   - `npm run install:browsers:linux` (si tienes permisos root)
   - Si no puedes usar `--with-deps`, instala dependencias de Chromium según Playwright y luego `npm run install:browsers`
3. Exporta variables:
   - `export TELEGRAM_BOT_TOKEN="..."`
   - `export ADMIN_PANEL_KEY="..."`
   - `export ADMIN_PANEL_PUBLIC_URL="http://IP_VPS:4020"`
4. Inicia con PM2:
   - `npm i -g pm2`
   - `pm2 start telegram-bot.js --name charola-tg`
   - `pm2 save`
   - `pm2 startup`

## Flujo de uso en Telegram

- `/start` o `/menu` para abrir teclado.
- Botones recomendados:
  - `🚀 Iniciar ahora` (inicio rápido con valores por defecto)
  - `⚙️ Configurar inicio` (flujo guiado: DNI -> código -> modo)
  - `🎟️ Activar licencia` (flujo guiado por código)
- `🧵 Mis procesos` muestra ejecuciones concurrentes de tu chat.
- `🛑 Detener mis procesos` detiene todas tus ejecuciones activas.
- `/cancel` cancela cualquier flujo guiado activo.
- Si eres admin, `/detener all` detiene todos los procesos activos globales.
- Si eres admin, `/limpiar_capturas` borra todas las imágenes de `runs` para liberar espacio.
- Mientras un proceso está corriendo, el bot aparece como **"escribiendo..."** para indicar carga.
- Al terminar cada proceso recibes un mensaje automático con estado (`éxito`, `fatal`, `sin ticket`) y captura si existe.

## Nota sobre scheduler

- Comandos `/crear_tarea`, `/hora`, `/ejecutar`, `/parar_tarea`, `/habilitar`, `/deshabilitar` son solo para Windows.
- En Linux usa PM2 o cron para programación y reinicio automático.
