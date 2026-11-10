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
let control = { mist: 0, kipas: 0 };

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    history = saved.history || [];
    if (history.length) latest = history[history.length - 1];
  } catch (e) {
    console.error('Gagal baca data.json lama:', e.message);
  }
}

function saveToFile() {
  fs.writeFile(DATA_FILE, JSON.stringify({ history }, null, 2), (err) => {
    if (err) console.error('Gagal simpan data.json:', err.message);
  });
}

// NodeMCU kirim data sensor ke sini tiap beberapa detik
app.post('/api/data', (req, res) => {
  const { suhu, kelembapan, levelAir } = req.body;
  latest = { suhu, kelembapan, levelAir, timestamp: new Date().toISOString() };
  history.push(latest);
  if (history.length > 200) history.shift();
  saveToFile();
  io.emit('sensorUpdate', latest);
  res.json({ ok: true });
});

// NodeMCU polling ke sini buat tau mist/kipas harus nyala atau tidak
app.get('/api/control', (req, res) => {
  res.json(control);
});

// Dashboard kirim perintah ON/OFF lewat sini
app.post('/api/control', (req, res) => {
  const { mist, kipas } = req.body;
  if (mist !== undefined) control.mist = mist ? 1 : 0;
  if (kipas !== undefined) control.kipas = kipas ? 1 : 0;
  io.emit('controlUpdate', control);
  res.json({ ok: true, control });
});

// Dashboard ambil data terakhir pas pertama kali dibuka
app.get('/api/latest', (req, res) => {
  res.json({ latest, control, history: history.slice(-50) });
});

io.on('connection', (socket) => {
  socket.emit('sensorUpdate', latest);
  socket.emit('controlUpdate', control);
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