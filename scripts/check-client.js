const fs = require('node:fs');
const path = require('node:path');
const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/i);
if (!match) throw new Error('No inline game script found in public/index.html');
// Compile only; this validates syntax without executing browser-dependent code.
new Function(match[1]);
console.log('Client JavaScript syntax OK');
