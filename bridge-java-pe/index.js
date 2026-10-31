'use strict';
// Java Edition 1.8.x  ->  Minecraft PE 0.15.10 / 0.14.3 translator proxy.
const fs = require('fs');
const path = require('path');
const mc = require('minecraft-protocol');
const { Session } = require('./src/session');
const { queryStatus } = require('./src/raknet');

const readline = require('readline');

// MCPE versions the proxy can log in as
const VERSIONS = [
  { name: '0.15.10', protocol: 84, note: 'PocketMine/Genisys API 2.0.0, Nukkit-Retro' },
  { name: '0.14.3', protocol: 70, note: 'PocketMine 0.14 builds, Nukkit-Retro' }
];

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cfgPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (process.env.PE_HOST) config.pe.host = process.env.PE_HOST;
if (process.env.PE_PORT) config.pe.port = +process.env.PE_PORT;
if (process.env.JAVA_PORT) config.java.port = +process.env.JAVA_PORT;
if (process.env.DEBUG) config.debug = true;
if (process.env.NAME_SELECT) config.java.nameSelect = process.env.NAME_SELECT;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function findVersion(v) {
  if (v == null) return null;
  v = String(v).trim();
  return VERSIONS.find((x) => x.name === v || String(x.protocol) === v) ||
    VERSIONS.find((x, i) => String(i + 1) === v) ||
    (v.startsWith('0.14') ? VERSIONS[1] : v.startsWith('0.15') ? VERSIONS[0] : null);
}

// Version: --pe-version / PE_VERSION / config "pe.version"; "ask" (the default) prompts on startup.
function chooseVersion() {
  const preset = flag('--pe-version') || process.env.PE_VERSION || config.pe.version || 'ask';
  if (String(preset).toLowerCase() !== 'ask') {
    const v = findVersion(preset);
    if (v) return Promise.resolve(v);
    log(`Unknown PE version "${preset}", asking instead`);
  }
  return new Promise((resolve) => {
    console.log('\nWhich MCPE version should the proxy connect as?');
    VERSIONS.forEach((v, i) => console.log(`  ${i + 1}) ${v.name.padEnd(8)} (protocol ${v.protocol}) - ${v.note}`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let done = false;
    const finish = (v, why) => {
      if (done) return; done = true; clearTimeout(timer); rl.close();
      if (why) log(why);
      resolve(v);
    };
    const timer = setTimeout(() => finish(VERSIONS[0], `No answer after 60s, using ${VERSIONS[0].name}`), 60000);
    const ask = () => rl.question(`Choose 1-${VERSIONS.length} or type a version [1]: `, (ans) => {
      if (!ans.trim()) return finish(VERSIONS[0]);
      const v = findVersion(ans);
      if (v) finish(v); else { console.log('  Not a supported version.'); ask(); }
    });
    rl.on('close', () => finish(VERSIONS[0], `No console input, using ${VERSIONS[0].name}`));
    ask();
  });
}

chooseVersion().then((v) => {
  config.pe.protocol = v.protocol;
  config.pe.versionName = v.name;
  log(`Connecting to the PE server as MCPE ${v.name} (protocol ${v.protocol})`);
  startServer();
});

function startServer() {
const server = mc.createServer({
  'online-mode': false,
  host: config.java.host,
  port: config.java.port,
  version: '1.8.8',
  motd: config.java.motd,
  maxPlayers: config.java.maxPlayers,
  keepAlive: true,
  hideErrors: !config.debug,
  // Mirror the PE server's player count / MOTD in the Java server list
  beforePing: (response, client, cb) => {
    const now = Date.now();
    const apply = (st) => {
      if (st) {
        response.players.online = st.online;
        response.players.max = st.max || response.players.max;
        if (config.java.useRemoteMotd !== false && st.motd) response.description = { text: st.motd + '\n§7MCPE ' + config.pe.versionName + ' via Java 1.8 translator' };
      } else {
        response.description = { text: (config.java.motd || '') + '\n§cPE server offline' };
      }
      cb(null, response);
    };
    if (statusCache && now - statusCache.t < 5000) return apply(statusCache.v);
    queryStatus(config.pe.host, config.pe.port).then((v) => { statusCache = { t: Date.now(), v }; apply(v); });
  }
});
let statusCache = null;

// A Java 1.8 client rejects a Login Success name longer than 16 characters; the full name is still used.
server.on('connection', (client) => {
  const write = client.write.bind(client);
  client.write = (name, data) => write(name, name === 'success' && data && String(data.username).length > 16 ? Object.assign({}, data, { username: String(data.username).slice(0, 16) }) : data);
});

const sessions = new Set();

server.on('login', (client) => {
  log(`Java player ${client.username} (${client.uuid}) connected from ${client.socket.remoteAddress}`);
  const s = new Session(client, config, log);
  sessions.add(s);
  client.on('end', () => { sessions.delete(s); log(`Java player ${client.username} left`); });
  s.start();
});

server.on('error', (e) => log('server error:', e.message));
server.on('listening', () => {
  log(`Listening for Java 1.8 clients on ${config.java.host}:${config.java.port}`);
  log(`Forwarding to MCPE ${config.pe.versionName} server at ${config.pe.host}:${config.pe.port} (protocol ${config.pe.protocol})`);
});

process.on('SIGINT', () => {
  log('Shutting down');
  for (const s of sessions) s.end('Proxy shutting down');
  setTimeout(() => process.exit(0), 300);
});
}
