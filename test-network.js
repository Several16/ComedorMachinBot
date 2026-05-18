const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('request', req => {
    if (req.url().includes('api') || req.method() === 'POST') {
      console.log(`REQ: ${req.method()} ${req.url()}`);
    }
  });

  console.log("Navegando a charola...");
  await page.goto('https://comedor.uncp.edu.pe/charola');
  
  try {
    await page.click('button:has-text("ACCEDER AL SERVICIO")', { timeout: 3000 });
    console.log("Boton ACCEDER clicado");
  } catch (e) {
    console.log("No se pudo clicar ACCEDER (quizas no esta presente).");
  }
  
  try {
    await page.fill('input[name="t1_dni"]', '73968815', { timeout: 2000 });
    await page.fill('input[name="t1_codigo"]', '2023200615D', { timeout: 2000 });
    await page.click('button:has-text("GENERAR TICKET")', { timeout: 2000 });
    console.log("Formulario enviado");
  } catch (e) {
    console.log("Formulario no disponible:", e.message);
  }

  await page.waitForTimeout(2000);
  await browser.close();
})();
