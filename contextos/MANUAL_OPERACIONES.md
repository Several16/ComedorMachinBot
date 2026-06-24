# Manual de Operaciones y Control de Servidores

Este documento explica cómo administrar técnicamente la red de servidores del bot, cómo reiniciarlos, cómo enviar actualizaciones de código y cómo revisar sus logs para detectar problemas.

## 1. Conexión a los Servidores vía SSH
Para conectarte directamente a la consola de cualquier servidor (Maestro o Workers) desde tu computadora, abres la terminal (PowerShell o CMD) y usas el comando SSH:

*   **Para entrar al Coordinador (Maestro):**
    `ssh root@107.170.39.76`
*   **Para entrar a un Worker (ej. 134.209.34.113):**
    `sshpass -p 'AaronCam_16224' ssh root@134.209.34.113`
    *(Nota: Reemplaza la IP por la del worker al que desees entrar)*

## 2. Gestión de Procesos con PM2
`PM2` es el motor que mantiene vivo el bot incluso si cierras la consola. Una vez dentro de un servidor por SSH, puedes usar estos comandos críticos:

*   **Ver el estado del bot:**
    `pm2 status`
    *(Te muestra si el bot está en estado "online", "errored" o "stopped", y cuánta RAM consume)*
*   **Reiniciar el bot:**
    `pm2 restart all`  (Reinicia todos los procesos en esa máquina)
    `pm2 restart charola-tg` (Comando específico en el Maestro)
    `pm2 restart worker-api` (Comando específico en los Workers)
*   **Apagar el bot (detenerlo):**
    `pm2 stop all`
*   **Ver los Logs en tiempo real:**
    `pm2 logs`
    *(Este comando es tu mejor amigo. Te muestra una pantalla en vivo de lo que está imprimiendo el bot en ese exacto segundo. Para salir de esa pantalla, presiona `Ctrl+C`).*

## 3. Actualización de Código en los Workers
Dado que tienes 9 Workers, actualizar el código en cada uno a mano sería imposible. Por eso existe el script **`restart-workers.js`** en el servidor Maestro.

### ¿Cómo actualizar una regla del motor de ataque (`charola-engine.js`)?
Si editas el archivo `charola-engine.js` en tu laptop o en el servidor Maestro y quieres que los 9 Workers tengan la nueva versión, debes ejecutar el script de reinicio desde el Maestro.

**Comando (ejecutar dentro del Maestro por SSH):**
`node /root/ComedorMachinBot/restart-workers.js`

**¿Qué hace este script internamente?**
1. Se conecta por SSH a cada una de las 9 IPs de DigitalOcean usando la contraseña `AaronCam_16224`.
2. Ejecuta el comando `scp` para copiar la nueva versión de `charola-engine.js` desde el Maestro hacia el Worker.
3. Ejecuta `pm2 restart worker-api` en el Worker para que cargue el código nuevo y limpie su memoria caché.

## 4. Directorio de Logs Históricos
Si el bot falla durante la mañana y quieres saber qué pasó, los logs completos y detallados se guardan en archivos de texto, no solo en PM2.

*   **Ubicación en el Maestro:**
    Los archivos de reporte del coordinador están en:
    `/root/ComedorMachinBot/logs/`
*   **Leer un log de fecha específica:**
    Para ver los logs, puedes listarlos con `ls -la /root/ComedorMachinBot/logs/` y luego leer el que te interese usando `cat` (ej. `cat tg-GLOBAL-2026-06-22...log`).

## 5. Resumen del Flujo de Administración
1. Escribes código nuevo localmente o modificas reglas de ataque.
2. Usas `scp` para subir los archivos desde tu computadora al servidor Maestro (`107.170.39.76`).
3. Te conectas por `ssh` al Maestro.
4. Si tocaste código del coordinador (ej. `coordinator.js`), ejecutas `pm2 restart charola-tg`.
5. Si tocaste código del motor (`charola-engine.js`), ejecutas `node restart-workers.js` para propagar la actualización a todos los clones.

