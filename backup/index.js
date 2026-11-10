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

let latest = { suhu: null, kelembapan: null, levelAir: null, timestamp: null };
let history = [];
let control = { mode: 'auto', mist: 0, kipas: 0 };

// Statistik akumulatif dari SEMUA data yang pernah masuk (nggak kebatas history 200 terakhir)
let stats = {
  count: 0,
  sumSuhu: 0, minSuhu: null, maxSuhu: null,
  sumKelembapan: 0, minKelembapan: null, maxKelembapan: null,
  mistActiveMs: 0, kipasActiveMs: 0,
};

// Pelacak buat ngitung durasi aktif mist & kipas antar data masuk
let actuatorState = { prevMist: 0, prevKipas: 0, prevTimeMs: null };

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    history = saved.history || [];
    if (saved.stats) stats = saved.stats;
    if (saved.actuatorState) actuatorState = saved.actuatorState;
    if (history.length) latest = history[history.length - 1];
  } catch (e) {
    console.error('Gagal baca data.json lama:', e.message);
  }
}

/*function saveToFile() {
  fs.writeFile(DATA_FILE, JSON.stringify({ history }, null, 2), (err) => {
    if (err) console.error('Gagal simpan data.json:', err.message);
  });
}*/
function saveToFile() {
  fs.writeFile(DATA_FILE, JSON.stringify({ history, stats, actuatorState }, null, 2), (err) => {
    if (err) console.error('Gagal simpan data.json:', err.message);
  });
}

function updateStats(suhu, kelembapan) {
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

function updateActuatorActiveTime(mist, kipas, nowMs) {
  if (actuatorState.prevTimeMs !== null) {
    const elapsed = nowMs - actuatorState.prevTimeMs;
    if (actuatorState.prevMist) stats.mistActiveMs += elapsed;
    if (actuatorState.prevKipas > 0) stats.kipasActiveMs += elapsed;
  }
  actuatorState.prevMist = mist ? 1 : 0;
  actuatorState.prevKipas = Number(kipas) || 0;
  actuatorState.prevTimeMs = nowMs;
}

function ringkasanStats() {
  const avgSuhu = stats.count ? +(stats.sumSuhu / stats.count).toFixed(1) : null;
  const avgKelembapan = stats.count ? +(stats.sumKelembapan / stats.count).toFixed(1) : null;
  return {
    minSuhu: stats.minSuhu, maxSuhu: stats.maxSuhu, avgSuhu,
    minKelembapan: stats.minKelembapan, maxKelembapan: stats.maxKelembapan, avgKelembapan,
    mistActiveMs: stats.mistActiveMs, kipasActiveMs: stats.kipasActiveMs,
  };
}

// NodeMCU kirim data sensor ke sini tiap beberapa detik
app.post('/api/data', (req, res) => {
  const { suhu, kelembapan, levelAir, mist, kipas} = req.body;
  latest = { suhu, kelembapan, levelAir, mist, kipas, timestamp: new Date().toISOString() };
  history.push(latest);
  if (history.length > 200) history.shift();
  updateStats(suhu, kelembapan);
  updateActuatorActiveTime(mist, kipas, Date.now());
  saveToFile();
  io.emit('sensorUpdate', latest);
  io.emit('statsUpdate', ringkasanStats());
  res.json({ ok: true });
});

// NodeMCU polling ke sini buat tau mist/kipas harus nyala atau tidak
app.get('/api/control', (req, res) => {
  res.json(control);
});

// Reset statistik dari awal (berguna sebelum mulai sesi demo baru)
app.post('/api/stats/reset', (req, res) => {
  stats = {
    count: 0, sumSuhu: 0, minSuhu: null, maxSuhu: null,
    sumKelembapan: 0, minKelembapan: null, maxKelembapan: null,
    mistActiveMs: 0, kipasActiveMs: 0,
  };
  actuatorState = { prevMist: 0, prevKipas: 0, prevTimeMs: null };
  saveToFile();
  io.emit('statsUpdate', ringkasanStats());
  res.json({ ok: true });
});

// Dashboard kirim perintah mode/ON/OFF lewat sini
app.post('/api/control', (req, res) => {
  const { mode, mist, kipas } = req.body;
  if (mode === 'auto' || mode === 'manual') control.mode = mode;
  if (mist !== undefined) control.mist = mist ? 1 : 0;
  // if (kipas !== undefined) control.kipas = kipas ? 1 : 0;
  if (kipas !== undefined) control.kipas = Math.max(0, Math.min(100, Number(kipas)));
  io.emit('controlUpdate', control);
  res.json({ ok: true, control });
});

// Dashboard ambil data terakhir pas pertama kali dibuka
app.get('/api/latest', (req, res) => {
  res.json({ latest, control, stats: ringkasanStats(), history: history.slice(-50) });
});

io.on('connection', (socket) => {
  socket.emit('sensorUpdate', latest);
  socket.emit('controlUpdate', control);
  socket.emit('statsUpdate', ringkasanStats());
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

  // Prioritaskan adapter yang namanya jelas-jelas Wi-Fi
  const wifi = candidates.find((c) => wifiNamePattern.test(c.name));
  if (wifi) return wifi.address;

  // Kalau tidak ketemu, pakai kandidat pertama yang bukan adapter virtual
  if (candidates.length) return candidates[0].address;

  return 'localhost';
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('Server cloud lokal jalan!');
  console.log(`Dashboard (buka di browser)  : http://${ip}:${PORT}`);
  console.log(`Dipakai di kode ESP8266 (serverIP) : ${ip}`);
  console.log('Pastikan laptop & NodeMCU nyambung ke WiFi yang SAMA.');
});
