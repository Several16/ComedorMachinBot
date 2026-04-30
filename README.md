# comedor-bot-telegram

Bot de Telegram para generar ticket de charola y administrar licencias por usuario.

## Requisitos

- Node.js 18+ (recomendado LTS)
- npm
- Token de bot de Telegram
- DNS/internet estable en el servidor

## Variables de entorno

Mínimas:

- `TELEGRAM_BOT_TOKEN`
- `ADMIN_PANEL_KEY` (recomendado)

Opcionales importantes:

- `TELEGRAM_ALLOWED_CHAT_ID`
- `TELEGRAM_ADMIN_CHAT_ID`
- `ADMIN_PANEL_PORT` (default `4020`)
- `ADMIN_PANEL_PUBLIC_URL` (ejemplo `http://IP_VPS:4020`)
- `CHAROLA_DNI`, `CHAROLA_CODIGO`
- `CHAROLA_MAX_PARALLEL_JOBS` (default `20`)
- `CHAROLA_MAX_PARALLEL_JOBS_PER_CHAT` (default `15`)
- `CHAROLA_LOADING_ACTION_INTERVAL_MS` (default `4000`)
- `CHAROLA_NOTIFY_ON_FINISH` (default `true`)
- `CHAROLA_AUTO_PRESTART_MINUTES` (default `3`)
- `CHAROLA_AUTO_JITTER_MAX_MS` (default `15000`)
- `LICENSE_EXPIRY_REMINDER_DAYS` (default `3`)
- `LICENSE_REMINDER_CHECK_MINUTES` (default `60`)
- `TELEGRAM_POLLING_INTERVAL_MS`, `TELEGRAM_POLLING_TIMEOUT_S`, `TELEGRAM_POLLING_RETRY_MS`, `TELEGRAM_POLLING_RETRY_MAX_MS`

## Inicio local (Windows)

1. `cd C:\Users\USUARIO\comedor-bot-telegram`
2. `npm install`
3. `npm run install:browsers`
4. Configura variables de entorno
5. `.\iniciar-telegram.bat` o `npm start`

> Importante: debe existir una sola instancia por token. Si hay otra activa, Telegram responde `409 Conflict`.

## Despliegue en VPS Linux (DigitalOcean + PM2)

1. Instala Node.js y npm en el droplet.
2. En la carpeta del proyecto:
   - `npm install`
   - `npm run install:browsers:linux`
3. Configura variables en el sistema o en ecosistema PM2.
4. Inicia:
   - `npm i -g pm2`
   - `pm2 start telegram-bot.js --name charola-tg`
   - `pm2 save`
   - `pm2 startup`

## Actualizar el droplet después de push a GitHub

1. `cd /ruta/comedor-bot-telegram`
2. `git pull origin main`
3. `npm install`
4. `npm run install:browsers:linux` (si cambió Playwright)
5. `pm2 restart charola-tg`
6. `pm2 logs charola-tg --lines 80`

## Flujo de uso en Telegram

- `/start` o `/menu` abre el teclado.
- Botones base: `🚀 Iniciar`, `⚙️ Configurar`, `📊 Estado`, `🧵 Procesos`, `🛑 Detener`, `🖼️ Foto`, `🔐 Licencia`, `⏰ Auto`, `❓ Ayuda`, `🆔 Mi ID`.
- `⏰ Auto` permite:
  - habilitar/deshabilitar automático,
  - configurar hora objetivo,
  - guardar DNI/código por usuario,
  - alternar TURBO/NORMAL,
  - ejecutar prueba inmediata (`▶️ Probar ahora`).
- `/diagnostico` entrega estado técnico resumido para soporte.
- Hay recordatorios automáticos cuando una licencia está por vencer.

## Nota de scheduler

- `/crear_tarea`, `/hora`, `/ejecutar`, `/parar_tarea`, `/habilitar`, `/deshabilitar` son solo Windows.
- En Linux, usa PM2/node-cron (integrado en este bot).
