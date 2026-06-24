# 📘 Manual de Usuario: Bot Charola UNCP

Bienvenido a **ComedorMachinBot**. Aquí está el flujo real para usarlo sin complicarte.

---

## 1. Inicio rápido

1. En Telegram envía `/start`.
2. Si no tienes licencia, activa con `/activar CODIGO`.
3. Usa `🚀 Iniciar` para ejecutar al instante o `⚙️ Configurar` para hacerlo guiado (DNI -> código -> modo).

---

## 2. Botones principales

- **🚀 Iniciar:** Ejecuta una búsqueda inmediata.
- **⚙️ Configurar:** Flujo guiado para DNI/código/modo.
- **📊 Estado:** Muestra procesos, último resultado, estado automático y licencia.
- **🧵 Procesos:** Lista tus procesos activos.
- **🛑 Detener:** Detiene tus procesos en ejecución.
- **🖼️ Foto:** Envía la última captura.
- **🔐 Licencia:** Muestra vigencia de licencia.
- **⏰ Auto:** Configura tarea automática diaria.
- **❓ Ayuda:** Lista de comandos.
- **🆔 Mi ID:** Muestra tu `chat_id`.
- **/diagnostico:** Estado técnico resumido para soporte.

---

## 3. ⏰ Modo automático (diario)

En **⏰ Auto** puedes:

- **Habilitar/Deshabilitar** el automático.
- **🕒 Cambiar Hora** objetivo (ejemplo `07:00`).
- **🔑 Credenciales** (DNI y código personales).
- **⚡ Modo** TURBO/NORMAL.
- **▶️ Probar ahora** para validar configuración sin esperar la hora programada.

### Pre-arranque inteligente

Si configuras `07:00`, el bot inicia antes (por defecto 3 minutos) para llegar preparado a la hora objetivo.

> Importante: si faltan credenciales, el automático no se ejecuta y te avisa.

---

## 4. Licencias y recordatorios

- El bot envía recordatorios cuando la licencia está por vencer.
- Si vence la licencia, debes renovarla con `/activar CODIGO`.

---

## 5. Funciones de administrador

Comandos clave:

- `/crear_licencia <dias> [cantidad]`
- `/dar_licencia <chat_id> <dias>`
- `/quitar_licencia <chat_id>`
- `/licencias`
- `/limpiar_capturas`
- `/set_admin <chat_id>`

Panel web admin:

- Botón `🛠️ Admin` muestra URL y clave (`ADMIN_PANEL_KEY`).

---

## 6. Preguntas frecuentes

**¿Qué significa límite de procesos?**  
Se alcanzó tu límite concurrente. Usa `🛑 Detener` y vuelve a iniciar.

**¿Qué significa “sin ticket” al finalizar?**  
No se consiguió ticket dentro del número de intentos configurado.

**¿Si cierro Telegram se detiene?**  
No. El bot sigue corriendo en el VPS (DigitalOcean) y te enviará el resultado cuando termine.
