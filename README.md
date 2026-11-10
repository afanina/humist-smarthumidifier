# Cloud server sendiri — Smart Adaptive Humidifier

## Cara jalanin di laptop

1. Install Node.js dari https://nodejs.org (pilih versi LTS) kalau belum ada.
2. Buka terminal/CMD, masuk ke folder `humidifier-cloud`:
   ```
   cd humidifier-cloud
   npm install
   npm start
   ```
3. Terminal bakal nampilin sesuatu kayak:
   ```
   Dashboard (buka di browser)       : http://192.168.1.12:3000
   Dipakai di kode ESP8266 (serverIP): 192.168.1.12
   ```
   Catat IP itu — itu alamat "cloud" kamu di jaringan WiFi lokal.
4. Buka alamat tadi di browser laptop/HP (harus satu WiFi yang sama) buat liat dashboard.

## Cara setting NodeMCU

1. Buka `arduino/humidifier_cloud.ino` di Arduino IDE.
2. Install library yang dibutuhin lewat Library Manager: `ArduinoJson`, `DHT sensor library` (Adafruit).
3. Isi `ssid`, `password` sama WiFi yang sama kayak laptop kamu.
4. Isi `serverIP` sama IP yang dicetak di langkah 3 atas (kalau laptop restart/ganti jaringan, IP ini bisa berubah — cek lagi dari terminal).
5. Upload ke NodeMCU, buka Serial Monitor (115200 baud) buat liat statusnya.

## Catatan

- Laptop harus tetap nyala dan `npm start` tetap jalan selama demo, karena ini server lokal (bukan hosting beneran).
- Data tersimpan otomatis di `data.json` (dibuat otomatis di folder yang sama), jadi riwayat 200 pembacaan terakhir nggak hilang walau servernya di-restart.
- Kalau laptop kamu pakai firewall Windows dan NodeMCU nggak bisa connect, pastikan port 3000 diizinkan (Windows biasanya nanya izin otomatis pas pertama kali `npm start` dijalankan).
