#!/bin/bash
# setup-simulador.sh - Crea un entorno aislado para pruebas

echo "================================================="
echo "🎓 INICIANDO CONFIGURACIÓN DE ENTORNO SIMULADOR"
echo "================================================="

# 1. Copiar la carpeta original (sin tocar el bot real)
echo "[1/4] Creando carpeta paralela 'Comedor-Simulador'..."
cp -r /root/ComedorMachinBot /root/Comedor-Simulador
cd /root/Comedor-Simulador

# 2. Modificar las URLs en charola-engine.js SOLO EN ESTA COPIA
echo "[2/4] Apuntando esta copia a la Universidad Falsa..."
sed -i 's|"https://comensales.uncp.edu.pe/api/registros"|process.env.UNCP_API_URL || "https://comensales.uncp.edu.pe/api/registros"|g' charola-engine.js
sed -i 's|"https://comedor.uncp.edu.pe/charola"|process.env.UNCP_WEB_URL || "https://comedor.uncp.edu.pe/charola"|g' charola-engine.js

# 3. Crear un archivo .env especial para el simulador
echo "[3/4] Configurando variables de entorno de prueba..."
# Asumimos que la IP del simulador es la IP del Coordinador
IP_COORDINADOR=$(curl -s ifconfig.me)

cat > .env <<EOF
# Puerto diferente para no chocar con el worker real (que usa el 4000)
WORKER_PORT=4001
# Usamos el mismo API Key
WORKER_API_KEY=dev-key
# Apuntar las URLs a nuestro Simulador falso (Puerto 5000)
UNCP_API_URL="http://$IP_COORDINADOR:5000/api/registros"
UNCP_WEB_URL="http://$IP_COORDINADOR:5000/charola"
EOF

# Para que el script reconozca la API KEY actual si existe:
if [ -f /root/ComedorMachinBot/.env ]; then
  grep "WORKER_API_KEY" /root/ComedorMachinBot/.env >> .env
fi

# 4. Lanzar el worker falso
echo "[4/4] Encendiendo el Worker Falso en PM2..."
pm2 delete worker-simulador 2>/dev/null || true
pm2 start worker-server.js --name worker-simulador

echo "================================================="
echo "✅ ¡ENTORNO PARALELO DE PRUEBAS CREADO EXITOSAMENTE!"
echo "Tu bot original en /root/ComedorMachinBot sigue INTACTO."
echo "================================================="
pm2 status
