const fs = require('fs');
const text = fs.readFileSync('main.js', 'utf8');
const urls = [...new Set(text.match(/https?:\/\/[^\s\"']+/g) || [])];
const apiEndpoints = [...new Set(text.match(/\/api\/[a-zA-Z0-9_\-\/]+/g) || [])];
console.log("URLs completas:\n", urls.join('\n'));
console.log("Endpoints relativos:\n", apiEndpoints.join('\n'));