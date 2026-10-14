const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const mirrorDeclarations = [
  'let NETSHIFT_CORE_FILES = [];',
  'let NETSHIFT_CORE_SOFTWARE = [];',
  'let NETSHIFT_CORE_FOLDERS = [];',
  'let NETSHIFT_CORE_RECYCLE_FILES = [];'
];
const bootMarker = 'if(!activeBrowserSurfaceV16) initBrowserTabsV16();';
const boot = html.indexOf(bootMarker);
if (boot < 0) throw new Error('Could not locate client startup marker.');
const firstBootRender = html.indexOf('refreshDesktopIcons();', boot);
if (firstBootRender < 0) throw new Error('Could not locate first boot-time desktop render.');
for (const declaration of mirrorDeclarations) {
  const first = html.indexOf(declaration);
  if (first < 0) throw new Error(`Missing canonical mirror declaration: ${declaration}`);
  if (first > firstBootRender) throw new Error(`Canonical mirror is declared after the first desktop render: ${declaration}`);
  if (html.indexOf(declaration, first + declaration.length) >= 0) throw new Error(`Duplicate canonical mirror declaration: ${declaration}`);
}
for (const id of ['loginForm', 'registerForm']) {
  const form = html.match(new RegExp(`<form\\b[^>]*id=["']${id}["'][^>]*>`));
  if (!form) throw new Error(`Missing ${id}.`);
  if (!/method=["']post["']/i.test(form[0]) || !/action=["']\/["']/i.test(form[0]) || !/onsubmit=["']return false["']/i.test(form[0])) {
    throw new Error(`${id} must fail closed without JavaScript and must not submit credentials in a GET URL.`);
  }
}
const loginBinding = html.indexOf('$("loginForm").addEventListener("submit"');
const registerBinding = html.indexOf('$("registerForm").addEventListener("submit"');
if (loginBinding < 0 || registerBinding < 0) throw new Error('Login/register submit handlers are not bound in the client source.');
console.log('Auth startup ordering and no-GET form safeguards OK');
