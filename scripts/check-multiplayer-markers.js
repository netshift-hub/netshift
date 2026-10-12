const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const requiredServer = [
  "new SocketIOServer(httpServer",
  "io.engine.use(netshiftSessionMiddleware)",
  "app.get('/api/world/summary'",
  "app.post('/api/world/targets/:slug/probe'",
  'netshift_world_targets',
  'netshift_world_events',
  'currentRevision',
];
const requiredClient = [
  '/socket.io/socket.io.js',
  'netshiftWorldConnect()',
  'netshiftWorldProbe()',
  'cloudSaveReloadButton',
  'baseRevision',
];
const missing = [
  ...requiredServer.filter(marker => !server.includes(marker)).map(marker => `server.js: ${marker}`),
  ...requiredClient.filter(marker => !html.includes(marker)).map(marker => `public/index.html: ${marker}`),
];
if (missing.length) {
  console.error('Missing multiplayer foundation markers:\n- ' + missing.join('\n- '));
  process.exit(1);
}
console.log('Multiplayer foundation markers OK');
