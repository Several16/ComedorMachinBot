const express = require('express');
const cors = require('cors');
const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let apiOpen = false;

// Ruta secreta para abrir la API (simulando las 07:00 AM)
app.get('/abrir', (req, res) => {
    apiOpen = true;
    res.send(`<h1>🔓 API del Comedor ABIERTA</h1><p>Los bots ya pueden asegurar cupos.</p>`);
    console.log("[SIMULADOR] 🔓 ¡API ABIERTA MANUALMENTE!");
});

// Ruta secreta para cerrar la API (simulando antes de las 07:00 AM)
app.get('/cerrar', (req, res) => {
    apiOpen = false;
    res.send(`<h1>🔒 API del Comedor CERRADA</h1><p>Los bots recibirán error 404.</p>`);
    console.log("[SIMULADOR] 🔒 ¡API CERRADA MANUALMENTE!");
});

// Mock de la API Cruda (Fase 1)
app.post('/api/registros', (req, res) => {
    if (!apiOpen) {
        // Simular que la puerta está cerrada (como a las 06:57)
        return res.status(404).json({
            status: false,
            message: "AÚN NO DISPONIBLE"
        });
    }

    // Si la puerta está abierta, dar el cupo
    return res.status(200).json({
        code: 200,
        status: true,
        message: "¡Cupo asegurado exitosamente en el Simulador!"
    });
});

// Mock de la página web (Fase 2 Visual)
app.get('/charola', (req, res) => {
    res.send(`
        <html>
        <head><title>Simulador Comedor UNCP</title></head>
        <body style="font-family: Arial; text-align: center; margin-top: 50px;">
            <div class="ticket-card" style="border: 2px solid green; padding: 20px; display: inline-block;">
                <h2 style="color: green;">TICKET VIRTUAL #SIMULADO</h2>
                <div class="qr-container" style="margin: 20px;">
                    <!-- QR Falso para que el bot le tome foto -->
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=SIMULACION-OK" alt="QR Falso">
                </div>
                <p>SIMULACIÓN EXITOSA</p>
            </div>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`======================================`);
    console.log(`🎓 SIMULADOR UNCP INICIADO EN PUERTO ${port}`);
    console.log(`======================================`);
    console.log(`ESTADO ACTUAL: 🔒 CERRADO (Los bots esperarán)`);
    console.log(`Para ABRIR la puerta: Visita http://TU_IP:5000/abrir`);
    console.log(`======================================`);
});
