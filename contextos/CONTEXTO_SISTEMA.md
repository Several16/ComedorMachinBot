# Contexto General del Sistema: ComedorMachinBot

## 1. Propósito del Proyecto
**ComedorMachinBot** es un sistema distribuido diseñado para automatizar la obtención de tickets/cupos para el comedor de la Universidad Nacional del Centro del Perú (UNCP). El sistema interactúa directamente con la API pública de la universidad (`comedor.uncp.edu.pe`) para asegurar cupos en cuestión de segundos en cuanto se habilita el horario de inscripción (usualmente a las 6:55 AM).

---

## 2. Arquitectura de Infraestructura
El sistema está diseñado en una arquitectura **Maestro-Esclavo (Distributed Workers)** para evitar bloqueos por IP y maximizar la velocidad.

*   **1 Servidor Coordinador (Maestro):**
    *   **Ubicación:** VPS Central (IP: 107.170.39.76).
    *   **Funciones:** Aloja el bot de Telegram (`telegram-bot.js`), maneja la base de datos de usuarios (`licenses.json`), programa el reloj (Cron Jobs), y orquesta la distribución del ataque.
*   **9 Servidores Workers (Esclavos):**
    *   **Ubicación:** Droplets de DigitalOcean.
    *   **Funciones:** Reciben las órdenes del Coordinador y ejecutan el ataque HTTP puro (`charola-engine.js`). Al tener 9 IPs distintas, se mitigan los bloqueos del Firewall (WAF) de la UNCP.

**Gestión de Procesos:** Todos los servidores (Maestro y Workers) mantienen los procesos vivos utilizando **PM2**.

---

## 3. Flujo de Ejecución (Paso a Paso)

1.  **Gatillo (Trigger):** A las 6:55 AM (Hora de Lima), el `telegram-bot.js` dispara la ejecución (Job `GLOBAL`). También se puede disparar manualmente usando el comando `/forzar` en Telegram.
2.  **Filtrado:** El Coordinador lee `licenses.json` y selecciona solo las cuentas activas que tienen marcado el día actual (ej. 'lun'). Las cuentas VIP son puestas al inicio de la fila.
3.  **Distribución (Carga Ligera):** El Coordinador reparte equitativamente las cuentas entre los 9 workers. *Nota: La redundancia (enviar una cuenta a 2 workers a la vez) está APAGADA para evitar asfixiar al servidor de la UNCP con tráfico duplicado.*
4.  **Warm-Up (Calentamiento):** El Coordinador lanza una "Cuenta Sonda" (generalmente el primer VIP) y bombardea la universidad cada 1-2 segundos. Apenas la universidad responde `200 OK`, el Coordinador grita "¡API ABIERTA!".
5.  **Ataque Sincronizado:** Todos los workers reciben la orden simultáneamente y disparan las peticiones `POST` a la UNCP usando `fetch` nativo de Node.js, camuflando los headers para simular ser Google Chrome en Windows.
6.  **Filtro de Errores Fatales:** Si la universidad responde con `"CUPOS AGOTADOS"`, `"DNI NO VALIDO"`, `"INHABILITADO"`, etc., el worker aborta inmediatamente esa cuenta para no perder tiempo. Todo lo demás (Errores 500, Timeouts) se reintenta varias veces.
7.  **Rescate Cruzado:** Si un worker falla definitivamente con una cuenta, el Coordinador toma esa cuenta fallida y la manda al "Mejor Worker" (el que tuvo más éxitos y fue más rápido) para un último intento de rescate.
8.  **Reporte:** Se envía el resumen de Éxitos y Fallos a Telegram. Tiempo total de ejecución actual: ~3 segundos (si la API responde bien).

---

## 4. Historial de Cambios y Decisiones Críticas

A lo largo del proyecto, se tomaron decisiones arquitectónicas clave para llegar al estado actual:

*   **Migración de Visual a RAW:** Inicialmente el bot usaba *Playwright* (Visual Mode) para abrir navegadores reales y tomar capturas. Esto tomaba 15 minutos para 20 cuentas. Se migró a **RAW Mode** (Peticiones HTTP puras a la ruta de la API) reduciendo el tiempo a 3 segundos para 100 cuentas.
*   **Prioridad VIP:** Se agregó lógica para que las cuentas que contengan la palabra `vip` (sin importar mayúsculas) sean procesadas primero y usadas como "Sonda", garantizando su cupo.
*   **Desactivación del Ataque DDoS propio (Redundancia):** En cierto punto, se intentó mandar cada DNI a dos workers a la vez (Redundancia Primaria y Secundaria). Esto causó que 9 workers enviaran 200 peticiones en el mismo milisegundo, lo que saturaba el servidor Apache de la UNCP (provocando Timeouts masivos). Se desactivó la redundancia para mantener el tráfico ligero y evitar que la UNCP se caiga.
*   **Eficiencia en Fallos (Cupos Agotados):** Se incorporó la lectura invisible del JSON de la UNCP. Cuando los cupos de una facultad se acaban, la UNCP responde internamente `"CUPOS AGOTADOS"`. El bot ahora reconoce esto como un Error Fatal y se rinde al instante, en lugar de quedarse reintentando durante 18 minutos.

---
