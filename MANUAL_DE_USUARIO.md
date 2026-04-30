# 📘 Manual de Usuario: Bot Charola UNCP

Bienvenido al manual oficial de **ComedorMachinBot**. Este documento explica todas las funciones, desde cómo iniciar sesión por primera vez hasta cómo configurar tareas automáticas y administrar licencias.

---

## 1. Menú Principal (Botones Base)
Cuando envías `/start` o `/menu`, verás un teclado en la parte inferior de tu pantalla.

*   **🚀 Iniciar:** Inicia una búsqueda de ticket inmediatamente usando tu DNI y Código configurados por defecto (o los últimos que usaste).
*   **⚙️ Configurar:** Te guía paso a paso. Te pedirá enviar tu DNI, tu Código de alumno y elegir si quieres Modo Normal o Turbo antes de empezar a buscar el ticket.
*   **📊 Estado:** Te muestra un reporte del servidor: Cuántos procesos tuyos y globales están activos, el resultado de tu último intento y el estado de tu licencia.
*   **🧵 Procesos:** Muestra una lista de las búsquedas que tienes activas en ese momento.
*   **🛑 Detener:** Fuerza al bot a dejar de buscar tickets inmediatamente y apaga tus procesos activos.
*   **🖼️ Foto:** Te envía la última captura de pantalla que tomó el navegador (para que veas si la página de la universidad se cayó o si ya abrió).
*   **🔐 Licencia:** Muestra cuántos días le quedan a tu licencia.
*   **🆔 Mi ID:** Te dice tu número único de usuario en Telegram (`chat_id`), necesario para que el administrador te dé acceso manualmente.
*   **❓ Ayuda:** Muestra la lista de comandos rápidos.

---

## 2. ⏰ Tarea Automática (Sistema Pre-Emptive)
Si tienes licencia, verás el botón **⏰ Auto** en tu teclado. Esto te permite programar al bot para que busque tu ticket **todos los días** sin que tú tengas que tocar el celular.

Al tocar el botón, aparecerá una tarjeta con los siguientes controles:

*   **✅ Encender Automático / ❌ Apagar Automático:** Activa o desactiva la alarma diaria.
*   **🕒 Cambiar Hora:** Te pide escribir la hora a la que quieres tu ticket (ej. `07:00`). 
    > **⚠️ IMPORTANTE:** El sistema es inteligente. Si configuras a las `07:00`, **el bot arrancará por sí solo a las `06:57`** (3 minutos antes) para ya estar dentro de la página haciendo fila cuando den las 7:00 en punto.
*   **🆔 Configurar DNI/Código:** Te permite guardar los datos exactos que usará la tarea automática. Estos datos son independientes y no afectan a otros usuarios.
*   **⚡ Cambiar Modo:** Alterna entre el Modo Turbo (bloquea imágenes/CSS para ir a máxima velocidad) y el Normal.
*   **▶️ Ejecutar Ahora:** Este botón sirve para **forzar a la alarma a dispararse en ese mismo instante**, sin importar qué hora sea. 
    > *Ejemplo:* Configuraste tu DNI y tu Código automático para mañana, pero quieres probar si funcionan. Presionas `▶️ Ejecutar Ahora` y el bot empezará a buscar un ticket usando esos datos guardados como si la alarma hubiera sonado.

---

## 3. 👑 Funciones de Administrador (Panel de Control)
Si tienes la corona de Admin, verás una fila extra de botones en tu teclado (`🛠️ Admin`, `📋 Licencias`, `🧹 Limpiar`).

### 🎫 Gestión de Licencias (Manejo de Usuarios)
Tú decides quién puede usar tu servidor para sacar tickets.
*   `/crear_licencia <dias> <cantidad>`: Crea códigos de regalo. Ejemplo: `/crear_licencia 30 5` creará 5 códigos válidos por un mes. Se los pasas a tus amigos y ellos escriben `/activar CODIGO_AQUI`.
*   `/dar_licencia <id_de_chat> <dias>`: Si tu amigo te pasó su ID usando el botón `Mi ID`, puedes darle acceso directo sin códigos. Ejemplo: `/dar_licencia 123456789 15`.
*   `/quitar_licencia <id_de_chat>`: Revoca el acceso a alguien inmediatamente.
*   **📋 Botón Licencias:** Muestra un ranking de las 20 personas que están usando el bot y cuándo caduca su tiempo.

### 💻 Mantenimiento del Servidor
*   **🧹 Botón Limpiar (`/limpiar_capturas`):** Con el tiempo, el bot guardará miles de capturas de pantalla. Toca este botón una vez a la semana para borrar las fotos antiguas y liberar espacio en el disco duro de tu VPS en DigitalOcean.
*   **🛠️ Botón Admin:** Te da el enlace y la contraseña (PANEL_KEY) para entrar a la página web gráfica de administración desde el navegador de tu computadora, si es que abriste el puerto 4020 en tu servidor.

---

## 4. Preguntas Frecuentes (FAQ)

**P: ¿Qué significa "Error: Ya tienes X procesos en ejecución"?**
**R:** El administrador puso un límite para evitar que colapses el servidor. Presiona el botón `🛑 Detener` para matar tus intentos viejos y vuelve a iniciar.

**P: ¿Por qué el bot manda "⚠️ Sin ticket en este intento"?**
**R:** El bot alcanzó el límite de intentos (ej. 1200 veces) y no logró entrar. Esto pasa si la página del comedor nunca se habilitó o si se cayó por mantenimiento. Puedes intentarlo de nuevo más tarde.

**P: Si apago mi celular o cierro Telegram, ¿el bot sigue buscando?**
**R:** **SÍ.** El bot vive en tu VPS de DigitalOcean (en New York). Puedes apagar tu celular o perder el internet; la tarea que dejaste en proceso terminará y, cuando te vuelvas a conectar a Telegram, verás la captura de pantalla con el resultado final.
