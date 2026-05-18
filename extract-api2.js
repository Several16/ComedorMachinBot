const fs = require('fs');
const text = fs.readFileSync('main.js', 'utf8');
const strings = [...new Set(text.match(/(["'])(?:(?=(\\?))\2.)*?\1/g) || [])];
const endpoints = strings.filter(s => s.includes('registro') || s.includes('ticket') || s.includes('generar'));
console.log("Posibles endpoints:");
console.log(endpoints.join('\n'));