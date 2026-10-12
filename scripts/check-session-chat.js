const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const requiredServer = [
  'netshift_account_ownership',
  'netshift_login_handoffs',
  'app.post(\'/api/auth/heartbeat\'',
  'app.get(\'/api/auth/handoff/:id\'',
  'app.post(\'/api/auth/handoff/:id/complete\'',
  'app.post(\'/api/auth/handoff/:id/respond\'',
  "emitToSession(handoff.incumbent_session_id, 'auth:session-revoked'",
  "socket.on('world:chat-send'",
  'netshift_world_chat',
  "io.to(WORLD_ROOM).emit('world:chat-message'",
  'SESSION_LEASE_MS'
];
const requiredClient = [
  'sessionHandoffOverlay',
  'netshiftShowHandoffModal',
  'netshiftDecideHandoff',
  'netshiftBeginHandoffPoll',
  'netshiftForceSessionEnd',
  "socket.on(\"auth:handoff-request\"",
  'worldChatForm',
  'worldChatMessages',
  'netshiftWorldSendChat',
  'world:chat-message'
];
const missing = [
  ...requiredServer.filter(marker => !server.includes(marker)).map(marker => `server.js: ${marker}`),
  ...requiredClient.filter(marker => !html.includes(marker)).map(marker => `public/index.html: ${marker}`),
];
if (!packageJson.scripts?.check?.includes('check-session-chat.js')) {
  missing.push('package.json: check script must run scripts/check-session-chat.js');
}
if (missing.length) {
  console.error('Missing session/chat markers:\n- ' + missing.join('\n- '));
  process.exit(1);
}
console.log('Session ownership and persistent chat markers OK');
