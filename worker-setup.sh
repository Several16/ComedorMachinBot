#!/bin/bash
# worker-setup.sh — Configurar un VPS worker para ComedorMachinBot
#
# Uso: bash worker-setup.sh <worker-id> <api-key> <principal-ip>
# Ejemplo: bash worker-setup.sh worker-1 mi-clave-secreta 143.198.123.45

set -e

WORKER_ID=${1:-"worker-1"}
API_KEY=${2:-"CHANGE_ME"}
PRINCIPAL_IP=${3:-"0.0.0.0"}

echo "═══════════════════════════════════════"
echo " Configurando Worker: $WORKER_ID"
echo " API Key: ${API_KEY:0:8}..."
echo " IP Principal: $PRINCIPAL_IP"
echo "═══════════════════════════════════════"

# 1. Actualizar sistema
echo "[1/7] Actualizando sistema..."
apt-get update -qq && apt-get upgrade -y -qq

# 2. Instalar Node.js 20
echo "[2/7] Instalando Node.js 20..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"

# 3. Instalar Git
echo "[3/7] Instalando Git..."
apt-get install -y git -qq

# 4. Clonar repositorio
echo "[4/7] Clonando repositorio..."
if [ -d "/root/ComedorMachinBot" ]; then
    echo "  Repo ya existe, actualizando..."
    cd /root/ComedorMachinBot
    git pull
else
    cd /root
    git clone https://github.com/Several16/ComedorMachinBot.git
    cd /root/ComedorMachinBot
fi

# 5. Instalar dependencias
echo "[5/7] Instalando dependencias..."
npm install --production
npm install express

# 6. Crear .env
echo "[6/7] Creando .env..."
cat > /root/ComedorMachinBot/.env << EOF
WORKER_PORT=4000
WORKER_API_KEY=$API_KEY
WORKER_ID=$WORKER_ID
EOF

# 7. Configurar PM2
echo "[7/7] Configurando PM2..."
npm install -g pm2

# Detener si ya existe
pm2 delete charola-worker 2>/dev/null || true

# Iniciar worker
pm2 start /root/ComedorMachinBot/worker-server.js --name charola-worker
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

# Configurar firewall
echo ""
echo "═══════════════════════════════════════"
echo " Configurando Firewall"
echo "═══════════════════════════════════════"
ufw allow 22/tcp
ufw allow from $PRINCIPAL_IP to any port 4000
echo "y" | ufw enable 2>/dev/null || true
ufw status

echo ""
echo "═══════════════════════════════════════"
echo " ✅ Worker $WORKER_ID configurado!"
echo "═══════════════════════════════════════"
echo ""
echo " Verificar: curl -H 'Authorization: Bearer $API_KEY' http://$(hostname -I | awk '{print $1}'):4000/health"
echo ""
echo " IP de este worker: $(hostname -I | awk '{print $1}')"
echo ""
pm2 status
