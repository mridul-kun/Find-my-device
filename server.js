/**
 * Find My Device — server (v2)
 * - Pairs two devices with a 6-digit code and remembers the pairing on disk
 * - Stores each device's last known location (GPS if shared, otherwise IP-based)
 * - Ring / SOS: delivered live over WebSocket, as a push notification when the
 *   app is closed, and kept as a pending alert if the other device is offline
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// Put DATA_DIR on a persistent disk when you host this online, or pairings reset on redeploy.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const CODE_TTL_MS = 5 * 60 * 1000;
const RING_COOLDOWN_MS = 2000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;     // an SOS waits up to 24 h for the other device
const RING_PENDING_TTL_MS = 30 * 60 * 1000;     // a normal ring waits up to 30 min

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const app = express();
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Web Push keys ---------- */
let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); }
  catch {
    vapid = webpush.generateVAPIDKeys();
    try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2)); } catch {}
  }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
app.get('/api/vapid', (req, res) => res.json({ key: vapid.publicKey }));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ---------- persistence ---------- */
// db[deviceId] = { name, partnerId, ip, lastSeen, last:{loc,at}, push, pending }
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = {}; }
// Saves are serialized and atomic (write a temp file, then rename), so overlapping
// updates can never leave a half-written data.json and lose the pairing.
let saving = false, dirty = false;
function save() {
  dirty = true;
  if (!saving) flush();
}
function flush() {
  saving = true;
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
    if (err) { saving = false; return; }
    fs.rename(tmp, DB_FILE, () => {
      saving = false;
      if (dirty) flush();
    });
  });
}

const online = new Map();   // deviceId -> ws
const codes = new Map();    // code -> { id, exp }
const lastRing = new Map(); // deviceId -> timestamp
const lastLoc = new Map();  // deviceId -> timestamp

/* ---------- IP helpers ---------- */
function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}
function isPrivateIp(ip) {
  return (
    !ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') ||
    ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.toLowerCase().startsWith('fe80') || /^f[cd]/i.test(ip)
  );
}

/* ---------- IP -> approximate location (ip-api.com, no key) ---------- */
const geoCache = new Map();
async function lookupLocation(ip) {
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  // Private/LAN IPs can't be geolocated; asking with no IP makes ip-api use this server's public IP.
  const target = isPrivateIp(ip) ? '' : encodeURIComponent(ip);
  const url = `http://ip-api.com/json/${target}?fields=status,message,country,regionName,city,lat,lon,isp,query`;
  let data = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    if (j.status === 'success') {
      data = { ip: j.query, city: j.city || '', region: j.regionName || '', country: j.country || '', lat: j.lat, lon: j.lon, isp: j.isp || '' };
    }
  } catch (e) { console.warn('IP lookup failed:', e.message); }
  if (data) geoCache.set(ip, { at: Date.now(), data });
  return data;
}

/* ---------- GPS -> street address (OpenStreetMap Nominatim) ---------- */
const revCache = new Map();
async function reverseGeocode(lat, lon) {
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  if (revCache.has(key)) return revCache.get(key);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lon}`,
      { headers: { 'User-Agent': 'FindMyDevice/2.0 (personal project)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(4000) }
    );
    const j = await res.json();
    const address = j.display_name || '';
    if (address) revCache.set(key, address);
    return address;
  } catch { return ''; }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

function cleanGps(g) {
  if (!g) return null;
  const lat = Number(g.lat), lon = Number(g.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, accuracy: Math.max(0, Math.round(Number(g.accuracy) || 0)) };
}

// Best available location: GPS (precise) if the device shared it, otherwise IP (city level).
async function resolveLocation(ip, gps) {
  const ipLoc = await lookupLocation(ip);
  if (gps) {
    const address = await reverseGeocode(gps.lat, gps.lon);
    return {
      source: 'gps', lat: gps.lat, lon: gps.lon, accuracy: gps.accuracy, address,
      city: ipLoc ? ipLoc.city : '', region: ipLoc ? ipLoc.region : '', country: ipLoc ? ipLoc.country : '',
      ip: ipLoc ? ipLoc.ip : ip, isp: ipLoc ? ipLoc.isp : ''
    };
  }
  return ipLoc ? { source: 'ip', ...ipLoc } : null;
}

function placeText(loc) {
  if (!loc) return 'an unknown location';
  return loc.address || [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || 'an unknown location';
}

/* ---------- helpers ---------- */
const clean = (s, max = 40) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function buildState(id) {
  const me = db[id];
  const pid = me && me.partnerId;
  const p = pid ? db[pid] : null;
  return {
    type: 'state',
    me: { id, name: me.name, ip: me.ip },
    partner: p
      ? { id: pid, name: p.name, ip: p.ip, online: online.has(pid), lastSeen: p.lastSeen || null, last: p.last || null }
      : null
  };
}
function pushState(id) {
  if (id && online.has(id) && db[id]) send(online.get(id), buildState(id));
}
function unbind(id) {
  const me = db[id];
  if (!me || !me.partnerId) return null;
  const pid = me.partnerId;
  if (db[pid]) db[pid].partnerId = null;
  me.partnerId = null;
  return pid;
}
function setLast(id, loc) {
  if (!db[id] || !loc) return;
  db[id].last = { loc, at: Date.now() };
  save();
  pushState(db[id].partnerId);
}

/* ---------- push notifications (work when the app is closed) ---------- */
async function pushTo(id, payload, ttl = 3600) {
  const sub = db[id] && db[id].push;
  if (!sub) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: ttl, urgency: 'high' });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { delete db[id].push; save(); }
    else console.warn('Push failed:', e.statusCode || e.message);
    return false;
  }
}

/* ---------- ring / SOS ---------- */
async function raise(ws, id, kind, gps, queuedAt) {
  const me = db[id];
  const pid = me.partnerId;
  if (!pid) return send(ws, { type: 'ring-result', ok: false, reason: 'not-paired' });

  const now = Date.now();
  const at = Number.isFinite(queuedAt) && queuedAt <= now && queuedAt > now - PENDING_TTL_MS ? queuedAt : now;

  // A slow or failed location lookup must never delay or block the ring. Wait a short
  // time, then fall back to the raw GPS fix, then to the last known location.
  let loc = await withTimeout(resolveLocation(ws.ip, gps), 2500);
  let locationAt = now;
  if (loc) setLast(id, loc);
  else if (gps) loc = { source: 'gps', lat: gps.lat, lon: gps.lon, accuracy: gps.accuracy, address: '', city: '', region: '', country: '', ip: ws.ip, isp: '' };
  else if (me.last) { loc = me.last.loc; locationAt = me.last.at; }

  const payload = { type: 'ring', kind, at, from: { name: me.name, ip: ws.ip, location: loc, locationAt } };
  const partnerWs = online.get(pid);
  const live = !!partnerWs;
  if (live) send(partnerWs, payload);

  const pushed = await pushTo(pid, {
    title: kind === 'sos' ? `SOS from ${me.name}` : `${me.name} is calling`,
    body: loc ? `Near ${placeText(loc)}` : 'Location unavailable',
    sos: kind === 'sos',
    lat: loc ? loc.lat : null,
    lon: loc ? loc.lon : null,
    at
  }, kind === 'sos' ? 86400 : 900);

  // If the other device is closed or offline, keep the alert and show it when the app opens.
  let pending = false;
  if (!live) {
    db[pid].pending = payload;
    save();
    pending = true;
  }
  send(ws, { type: 'ring-result', ok: live || pushed || pending, kind, live, pushed, pending, location: loc });
}

/* ---------- WebSocket ---------- */
wss.on('connection', (ws, req) => {
  ws.ip = getIp(req);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      const id = String(msg.id || '');
      if (id.length < 8 || id.length > 80) return;
      const old = online.get(id);
      if (old && old !== ws) old.close();

      const rec = (db[id] = db[id] || { name: '', partnerId: null, ip: '' });
      rec.name = clean(msg.name) || rec.name || 'Device ' + id.slice(0, 4);
      rec.ip = ws.ip;
      rec.lastSeen = Date.now();
      save();

      ws.deviceId = id;
      online.set(id, ws);
      pushState(id);
      pushState(rec.partnerId);

      // Alert that arrived while this device was closed
      if (rec.pending) {
        const ttl = rec.pending.kind === 'sos' ? PENDING_TTL_MS : RING_PENDING_TTL_MS;
        if (Date.now() - rec.pending.at < ttl) send(ws, { ...rec.pending, delayed: true });
        delete rec.pending;
        save();
      }
      // First location for this device (IP based) unless a fresh GPS fix is already stored
      resolveLocation(ws.ip, null).then((loc) => {
        const l = rec.last;
        if (loc && (!l || l.loc.source !== 'gps' || Date.now() - l.at > 10 * 60 * 1000)) setLast(id, loc);
      });
      return;
    }

    const id = ws.deviceId;
    if (!id || !db[id]) return;
    const me = db[id];

    switch (msg.type) {
      case 'rename':
        me.name = clean(msg.name) || me.name;
        save();
        pushState(id);
        pushState(me.partnerId);
        break;

      case 'create-code': {
        for (const [c, v] of codes) if (v.id === id) codes.delete(c);
        let code;
        do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (codes.has(code));
        codes.set(code, { id, exp: Date.now() + CODE_TTL_MS });
        send(ws, { type: 'code', code, expiresIn: CODE_TTL_MS / 1000 });
        break;
      }

      case 'join': {
        const code = String(msg.code || '').trim();
        const entry = codes.get(code);
        if (!entry || entry.exp < Date.now()) {
          send(ws, { type: 'error', message: 'That code is wrong or has expired. Ask the other device for a new one.' });
          break;
        }
        if (entry.id === id) {
          send(ws, { type: 'error', message: 'That code belongs to this device. Enter it on the other device.' });
          break;
        }
        const other = entry.id;
        const freed = [unbind(id), unbind(other)];
        db[id].partnerId = other;
        db[other].partnerId = id;
        codes.delete(code);
        save();
        [id, other, ...freed].forEach(pushState);
        break;
      }

      case 'unpair': {
        const pid = unbind(id);
        save();
        pushState(id);
        pushState(pid);
        break;
      }

      case 'ring':
      case 'sos': {
        const now = Date.now();
        const gap = msg.type === 'sos' ? 1000 : RING_COOLDOWN_MS;
        if (now - (lastRing.get(id) || 0) < gap) break;
        lastRing.set(id, now);
        await raise(ws, id, msg.type, cleanGps(msg.gps), Number(msg.queuedAt));
        break;
      }

      case 'location': {
        const gps = cleanGps(msg.gps);
        if (!gps) break;
        const now = Date.now();
        if (now - (lastLoc.get(id) || 0) < 15000) break;
        lastLoc.set(id, now);
        const loc = await resolveLocation(ws.ip, gps);
        if (loc) setLast(id, loc);
        break;
      }

      case 'push-sub': {
        const s = msg.sub;
        if (s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.keys) {
          me.push = { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh || ''), auth: String(s.keys.auth || '') } };
          save();
        }
        break;
      }

      case 'stop': {
        const pid = me.partnerId;
        if (pid && online.has(pid)) send(online.get(pid), { type: 'ring-stopped', by: me.name });
        break;
      }
    }
  });

  ws.on('close', () => {
    const id = ws.deviceId;
    if (id && online.get(id) === ws) {
      online.delete(id);
      if (db[id]) { db[id].lastSeen = Date.now(); save(); }
      pushState(db[id] && db[id].partnerId);
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [c, v] of codes) if (v.exp < now) codes.delete(c);
}, 60000);

server.listen(PORT, () => console.log(`Find My Device running on http://localhost:${PORT}`));