const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

let bot = null; // diisi nanti kalau TELEGRAM_BOT_TOKEN aktif
const NOTIFY_CHAT_ID = '6014840328';

function kirimPeringatanAirHabis(deviceId) {
  if (!bot || !NOTIFY_CHAT_ID || NOTIFY_CHAT_ID === 'ISI_CHAT_ID_TELEGRAM_KAMU') return;
  bot.sendMessage(
    NOTIFY_CHAT_ID,
    `⚠️ *${deviceId}*: air sudah habis! Mist maker & kipas dimatikan otomatis.`,
    { parse_mode: 'Markdown' }
  ).catch((e) => console.error('[Telegram] Gagal kirim notif:', e.message));
}

function kirimNotifikasiAirTerisi(deviceId) {
  if (!bot || !NOTIFY_CHAT_ID || NOTIFY_CHAT_ID === 'ISI_CHAT_ID_TELEGRAM_KAMU') return;
  bot.sendMessage(
    NOTIFY_CHAT_ID,
    `💧 *${deviceId}*: air sudah terisi lagi. Mist maker & kipas bisa jalan normal.`,
    { parse_mode: 'Markdown' }
  ).catch((e) => console.error('[Telegram] Gagal kirim notif:', e.message));
}

// Tiap node/NodeMCU punya entri sendiri di sini, key-nya = deviceId
// devices = {
//   "<deviceId>": { latest, history, control, stats, actuatorState, prevLevelAir, firstSeen }
// }
let devices = {};

function buatDeviceBaru() {
  return {
    latest: { suhu: null, kelembapan: null, levelAir: null, mist: 0, kipas: 0, latencyMs: null, timestamp: null },
    history: [],
    control: { mode: 'auto', mist: 0, kipas: 0 },
    stats: {
      count: 0,
      sumSuhu: 0, minSuhu: null, maxSuhu: null,
      sumKelembapan: 0, minKelembapan: null, maxKelembapan: null,
      mistActiveMs: 0, kipasActiveMs: 0,
    },
    actuatorState: { prevMist: 0, prevKipas: 0, prevTimeMs: null },
    prevLevelAir: 0,
    firstSeen: new Date().toISOString(),
  };
}

// Ambil device yang udah ada, atau daftarin otomatis kalau deviceId-nya baru
function getOrCreateDevice(deviceId) {
  if (!devices[deviceId]) {
    devices[deviceId] = buatDeviceBaru();
    console.log(`[Node baru] Device "${deviceId}" baru pertama kali connect, otomatis terdaftar.`);
  }
  return devices[deviceId];
}

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (saved.devices) devices = saved.devices;
  } catch (e) {
    console.error('Gagal baca data.json lama:', e.message);
  }
}

function saveToFile() {
  fs.writeFile(DATA_FILE, JSON.stringify({ devices }, null, 2), (err) => {
    if (err) console.error('Gagal simpan data.json:', err.message);
  });
}

function updateStats(stats, suhu, kelembapan) {
  if (typeof suhu === 'number' && !Number.isNaN(suhu)) {
    stats.sumSuhu += suhu;
    stats.minSuhu = stats.minSuhu === null ? suhu : Math.min(stats.minSuhu, suhu);
    stats.maxSuhu = stats.maxSuhu === null ? suhu : Math.max(stats.maxSuhu, suhu);
  }
  if (typeof kelembapan === 'number' && !Number.isNaN(kelembapan)) {
    stats.sumKelembapan += kelembapan;
    stats.minKelembapan = stats.minKelembapan === null ? kelembapan : Math.min(stats.minKelembapan, kelembapan);
    stats.maxKelembapan = stats.maxKelembapan === null ? kelembapan : Math.max(stats.maxKelembapan, kelembapan);
  }
  stats.count += 1;
}

function updateActuatorActiveTime(actuatorState, stats, mist, kipas, nowMs) {
  if (actuatorState.prevTimeMs !== null) {
    const elapsed = nowMs - actuatorState.prevTimeMs;
    if (actuatorState.prevMist) stats.mistActiveMs += elapsed;
    if (actuatorState.prevKipas > 0) stats.kipasActiveMs += elapsed;
  }
  actuatorState.prevMist = mist ? 1 : 0;
  actuatorState.prevKipas = Number(kipas) || 0;
  actuatorState.prevTimeMs = nowMs;
}

function ringkasanStats(stats) {
  const avgSuhu = stats.count ? +(stats.sumSuhu / stats.count).toFixed(1) : null;
  const avgKelembapan = stats.count ? +(stats.sumKelembapan / stats.count).toFixed(1) : null;
  return {
    minSuhu: stats.minSuhu, maxSuhu: stats.maxSuhu, avgSuhu,
    minKelembapan: stats.minKelembapan, maxKelembapan: stats.maxKelembapan, avgKelembapan,
    mistActiveMs: stats.mistActiveMs, kipasActiveMs: stats.kipasActiveMs,
  };
}

function daftarDevice() {
  const ONLINE_THRESHOLD_MS = 10000; // dianggap offline kalau nggak ada data > 10 detik
  const now = Date.now();
  return Object.keys(devices).map((id) => {
    const dev = devices[id];
    const lastSeen = dev.latest.timestamp;
    const online = lastSeen ? (now - new Date(lastSeen).getTime()) < ONLINE_THRESHOLD_MS : false;
    return { id, firstSeen: dev.firstSeen, lastSeen, online };
  });
}

// NodeMCU kirim data sensor ke sini tiap beberapa detik.
// Body wajib sertakan "deviceId" (nama unik tiap alat, misal "humidifier-kamar1").
app.post('/api/data', (req, res) => {
    const { deviceId, suhu, kelembapan, levelAir, mist, kipas, latencyMs } = req.body;
  const id = deviceId || 'default';
  const dev = getOrCreateDevice(id);

  dev.latest = { suhu, kelembapan, levelAir, mist, kipas, latencyMs: latencyMs ?? null, timestamp: new Date().toISOString() };
  dev.history.push(dev.latest);
  if (dev.history.length > 200) dev.history.shift();

  // Kirim peringatan Telegram HANYA pas air baru aja jadi habis
  // (transisi tersedia -> habis), bukan berulang tiap 2 detik selama masih habis.
 if (levelAir && !dev.prevLevelAir) {
    kirimPeringatanAirHabis(id);        // tersedia -> habis
  } else if (!levelAir && dev.prevLevelAir) {
    kirimNotifikasiAirTerisi(id);       // habis -> tersedia lagi
  }
  dev.prevLevelAir = levelAir ? 1 : 0;

  updateStats(dev.stats, suhu, kelembapan);
  updateActuatorActiveTime(dev.actuatorState, dev.stats, mist, kipas, Date.now());
  saveToFile();

  io.emit('sensorUpdate', { deviceId: id, ...dev.latest });
  io.emit('statsUpdate', { deviceId: id, stats: ringkasanStats(dev.stats) });
  io.emit('deviceListUpdate', daftarDevice());

  res.json({ ok: true, deviceId: id });
});

// NodeMCU polling ke sini (kirim ?deviceId=xxx) buat tau mist/kipas harus nyala atau tidak
app.get('/api/control', (req, res) => {
  const id = req.query.deviceId || 'default';
  const dev = getOrCreateDevice(id);
  res.json(dev.control);
});

// Dashboard kirim perintah mode/mist/kecepatan kipas buat satu device tertentu
app.post('/api/control', (req, res) => {
  const { deviceId, mode, mist, kipas } = req.body;
  const id = deviceId || 'default';
  const dev = getOrCreateDevice(id);

  if (mode === 'auto' || mode === 'manual') dev.control.mode = mode;
  if (mist !== undefined) dev.control.mist = mist ? 1 : 0;
  if (kipas !== undefined) dev.control.kipas = Math.max(0, Math.min(100, Number(kipas)));
  saveToFile();

  io.emit('controlUpdate', { deviceId: id, control: dev.control });
  res.json({ ok: true, control: dev.control });
});

// Daftar semua node yang pernah/sedang connect
app.get('/api/devices', (req, res) => {
  res.json(daftarDevice());
});

// Tambah node baru secara manual lewat dashboard (sebelum device-nya fisik connect pun bisa)
app.post('/api/devices', (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    return res.status(400).json({ ok: false, error: 'deviceId wajib diisi' });
  }
  const id = deviceId.trim();
  if (devices[id]) {
    return res.status(409).json({ ok: false, error: 'Device dengan ID itu sudah ada' });
  }
  devices[id] = buatDeviceBaru();
  saveToFile();
  io.emit('deviceListUpdate', daftarDevice());
  res.json({ ok: true, deviceId: id });
});

// Dashboard ambil data satu device tertentu (?deviceId=xxx), default ke device pertama yang ada
app.get('/api/latest', (req, res) => {
  const daftar = daftarDevice();
  const id = req.query.deviceId || (daftar[0] && daftar[0].id) || 'default';
  const dev = getOrCreateDevice(id);
  res.json({
    deviceId: id,
    latest: dev.latest,
    control: dev.control,
    stats: ringkasanStats(dev.stats),
    history: dev.history.slice(-50),
    devices: daftar,
  });
});

// Reset statistik satu device tertentu
app.post('/api/stats/reset', (req, res) => {
  const { deviceId } = req.body;
  const id = deviceId || 'default';
  const dev = getOrCreateDevice(id);
  dev.stats = {
    count: 0, sumSuhu: 0, minSuhu: null, maxSuhu: null,
    sumKelembapan: 0, minKelembapan: null, maxKelembapan: null,
    mistActiveMs: 0, kipasActiveMs: 0,
  };
  dev.actuatorState = { prevMist: 0, prevKipas: 0, prevTimeMs: null };
  saveToFile();
  io.emit('statsUpdate', { deviceId: id, stats: ringkasanStats(dev.stats) });
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('deviceListUpdate', daftarDevice());
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  const virtualNamePattern = /virtualbox|vmware|hyper-v|loopback|vethernet/i;
  const wifiNamePattern = /wi-?fi|wireless/i;

  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !virtualNamePattern.test(name)) {
        candidates.push({ name, address: net.address });
      }
    }
  }

  const wifi = candidates.find((c) => wifiNamePattern.test(c.name));
  if (wifi) return wifi.address;
  if (candidates.length) return candidates[0].address;
  return 'localhost';
}

// ================= BOT TELEGRAM =================
const TelegramBot = require('node-telegram-bot-api');
const TELEGRAM_BOT_TOKEN = '9054221132:AAEna3_WP9O2Aeg11HO7FfIhgpiP1z9y_dk';

if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'ISI_TOKEN_DARI_BOTFATHER_DI_SINI') {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  bot.on('polling_error', () => {}); // redam noise ECONNRESET di log, nggak pengaruh ke fungsi bot

  function formatStatusDevice(id, dev) {
    const l = dev.latest;
    return `📟 *${id}*\n` +
      `Suhu: ${l.suhu ?? '--'} °C\n` +
      `Kelembapan: ${l.kelembapan ?? '--'} %\n` +
      `Mist maker: ${l.mist ? 'ON' : 'OFF'}\n` +
      `Kipas: ${l.kipas ?? 0}%`;
  }

  function formatStatistikDevice(id, dev) {
    const s = ringkasanStats(dev.stats);
    return `📊 *${id}*\n` +
      `Suhu rata-rata: ${s.avgSuhu ?? '--'} °C\n` +
      `Kelembapan rata-rata: ${s.avgKelembapan ?? '--'} %`;
  }

  bot.onText(/\/status(?:\s+(\S+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const targetId = match[1];
    const ids = targetId ? [targetId] : Object.keys(devices);

    if (ids.length === 0) {
      bot.sendMessage(chatId, 'Belum ada node yang terdaftar.');
      return;
    }

    const pesan = ids
      .filter((id) => devices[id])
      .map((id) => formatStatusDevice(id, devices[id]))
      .join('\n\n');

    bot.sendMessage(chatId, pesan || `Device "${targetId}" tidak ditemukan.`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/statistik(?:\s+(\S+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const targetId = match[1];
    const ids = targetId ? [targetId] : Object.keys(devices);

    if (ids.length === 0) {
      bot.sendMessage(chatId, 'Belum ada node yang terdaftar.');
      return;
    }

    const pesan = ids
      .filter((id) => devices[id])
      .map((id) => formatStatistikDevice(id, devices[id]))
      .join('\n\n');

    bot.sendMessage(chatId, pesan || `Device "${targetId}" tidak ditemukan.`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/device/, (msg) => {
    const chatId = msg.chat.id;
    const daftar = daftarDevice();
    if (daftar.length === 0) {
      bot.sendMessage(chatId, 'Belum ada node yang terdaftar.');
      return;
    }
    const pesan = daftar.map((d) => `${d.online ? '🟢' : '⚪'} ${d.id}`).join('\n');
    bot.sendMessage(chatId, `*Daftar node:*\n${pesan}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      'Halo! Bot Humist.\n\n' +
      'Perintah yang tersedia:\n' +
      '/status [deviceId] - suhu, kelembapan, status mist & kipas\n' +
      '/statistik [deviceId] - suhu & kelembapan rata-rata\n' +
      '/device - daftar semua node\n\n' +
      'Kamu juga otomatis dapat peringatan kalau air di salah satu node habis.'
    );
  });

  console.log('[Telegram] Bot aktif.');
} else {
  console.log('[Telegram] TELEGRAM_BOT_TOKEN belum diisi, bot Telegram tidak aktif.');
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('Humist server jalan! (mode multi-device)');
  console.log(`Dashboard (buka di browser)  : http://${ip}:${PORT}`);
  console.log(`Dipakai di kode ESP8266 (serverIP) : ${ip}`);
  console.log('Pastikan laptop & NodeMCU nyambung ke WiFi yang SAMA.');
});
