const fetch = require('node-fetch');

// Extraer las IPs de los workers (leyendo .env o configuraciones si existieran, o usando local si es prueba)
const workerUrls = [
    "http://127.0.0.1:4001", // Aquí se deberían poner las IPs de los 4 workers. Por ahora probamos local.
];

const mockAccounts = [
    { dni: "73968815", codigo: "2023200615D", nombre: "Prueba 1" },
    { dni: "62615541", codigo: "2023200615D", nombre: "Prueba 2" },
    { dni: "74526655", codigo: "2023200615D", nombre: "Prueba 3" },
    { dni: "72478134", codigo: "2023200615D", nombre: "Prueba 4" }
];

async function lanzarSimulacion() {
    console.log("=================================================");
    console.log("🚀 LANZANDO ATAQUE AL UNIVERSO PARALELO (SIMULADOR)");
    console.log("=================================================");
    
    for (const workerUrl of workerUrls) {
        console.log(`Enviando orden de ataque al worker: ${workerUrl}`);
        try {
            const res = await fetch(`${workerUrl}/execute`, {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "Authorization": "Bearer dev-key" // Asumimos dev-key para la simulación
                },
                body: JSON.stringify({
                    jobId: "SIMULACION-" + Date.now(),
                    accounts: mockAccounts,
                    config: {
                        waveSize: 4,
                        waveDelayMs: 500,
                        maxPostAttempts: 150,
                        retryDelayMs: 250,
                        maxRescueAttempts: 80,
                        rescueDelayMs: 1000
                    }
                })
            });
            const data = await res.json();
            console.log(`Respuesta del worker ${workerUrl}:`, data);
        } catch (e) {
            console.error(`❌ Error contactando al worker ${workerUrl}:`, e.message);
        }
    }
    
    console.log("=================================================");
    console.log("Mira los logs del simulador para ver cómo llegan los ataques:");
    console.log("pm2 logs simulador");
    console.log("Recuerda abrir la puerta visitando: http://TU_IP:5000/abrir");
}

lanzarSimulacion();
