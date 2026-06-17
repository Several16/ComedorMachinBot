const { exec } = require('child_process');
const { getWorkerUrls } = require('./coordinator');

const urls = getWorkerUrls();
const pass = 'AaronCam_16224';

console.log(`Iniciando actualización y reinicio para ${urls.length} workers...`);

const promises = urls.map(url => {
  return new Promise((resolve) => {
    const match = url.match(/http:\/\/([^:]+):/);
    if (!match) return resolve(`❌ ${url} - URL inválida`);
    const ip = match[1];
    
    const cmd = `sshpass -p '${pass}' ssh -o StrictHostKeyChecking=no root@${ip} "cd ~/ComedorMachinBot && git pull origin main && pm2 restart worker-api"`;
    console.log(`[${ip}] Enviando comando...`);
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        resolve(`❌ [${ip}] Error: ${error.message}`);
      } else {
        resolve(`✅ [${ip}] OK`);
      }
    });
  });
});

Promise.all(promises).then(results => {
  console.log("\n=== RESULTADOS DEL REINICIO MASIVO ===");
  results.forEach(r => console.log(r));
  console.log("======================================");
  process.exit(0);
});
