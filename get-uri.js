const fs = require('fs');
const text = fs.readFileSync('main.js', 'utf8');
const classMatch = text.match(/class[^{]+{[^{]*?URI=["']([^"']+)["']/);
console.log(classMatch ? classMatch[1] : 'No found class URI');
const apiMatch = text.match(/this\.URI=["']([^"']+)["']/);
console.log(apiMatch ? apiMatch[1] : 'No found this.URI');
const allUris = text.match(/URI\s*=\s*["']([^"']+)["']/g);
console.log("All URIs:", allUris);