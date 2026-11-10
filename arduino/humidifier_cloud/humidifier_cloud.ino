#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ================= KONFIGURASI WI-FI =================
const char* ssid     = "aliss";
const char* password = "alis1001";

// ================= KONFIGURASI SERVER DASHBOARD =================
const char* serverIP   = "172.20.10.3";   // ganti sesuai IP laptop yang dicetak npm start
const int   serverPort = 3000;
const char* DEVICE_ID = "humidifier-kamar1";   // nama unik buat node ini, ganti tiap NodeMCU beda

// ================= PEMETAAN PIN RANGKAIAN =================
#define PIN_DHT      D2   // GPIO4  - Data DHT22 (Pull-up 10k ke 3V3)
#define PIN_FLOAT    D5   // GPIO14 - Float Switch (INPUT_PULLUP ke GND)
#define PIN_MIST     D6   // GPIO12 - Gate MOSFET Q1 (Mist Maker 5V)
#define PIN_FAN      D7   // GPIO13 - Gate MOSFET Q2 (Kipas DC 5V)

#define DHTTYPE      DHT22
DHT dht(PIN_DHT, DHTTYPE);

// ================= PARAMETER KONTROL ADAPTIF =================
const float TARGET_HUMIDITY   = 60.0; // Target kelembapan ideal (%)
const float HYSTERESIS        = 3.0;  // Rentang toleransi (57% - 63%)
const unsigned long INTERVAL  = 2000; // Pembacaan sensor tiap 2 detik

// Konfigurasi logika float switch:
// Sesuaikan dengan orientasi pelampung (biasanya LOW saat air cukup/terangkat)
#define WATER_EMPTY_STATE HIGH 
//tambahan
// ================= PARAMETER KECEPATAN KIPAS (PWM) =================
const int FAN_MIN_SPEED   = 0;
const int FAN_MAX_SPEED   = 100;
const float MAX_DEFICIT   = 15.0;

unsigned long previousMillis = 0;
bool isWaterEmpty = false;
//tambahan
int currentMistState = 0;
int currentFanSpeedPercent = 0;

// Status mode dari dashboard: "auto" (default) atau "manual"
String modeSaatIni = "auto";
int manualMist = 0;
int manualKipas = 0;
unsigned long lastLatencyMs = 0;

//tambahan
int terapkanBatasMinimum(int persen) {
  if (persen <= 0) return 0;
  if (persen < FAN_MIN_SPEED) return FAN_MIN_SPEED;
  if (persen > FAN_MAX_SPEED) return FAN_MAX_SPEED;
  return persen;
}

// ================= FUNGSI KONEKSI WI-FI =================
void connectWiFi() {
  Serial.print("\nMenghubungkan ke Wi-Fi: ");
  Serial.println(ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  int timeout = 0;
  while (WiFi.status() != WL_CONNECTED && timeout < 30) {
    delay(500);
    Serial.print(".");
    timeout++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[Wi-Fi] Terhubung!");
    Serial.print("[Wi-Fi] IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[Wi-Fi] RSSI (Kekuatan Sinyal): ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\n[Wi-Fi] Gagal terhubung. Sistem tetap berjalan offline.");
  }
}

// ================= FUNGSI KIRIM DATA KE DASHBOARD =================
// Dipanggil tiap siklus baca sensor. Kalau server nggak kedetect
// (laptop mati/beda WiFi), fungsi ini cuma gagal diam-diam —
// logika kontrol mist/kipas di atas TETAP jalan normal.
void kirimDataKeServer(float suhu, float kelembapan, int levelAir, int mistStatus, int fanStatus) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/data";

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(2000); // jangan sampai nge-block lama kalau server nggak respon

  StaticJsonDocument<256> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["suhu"] = suhu;
  doc["kelembapan"] = kelembapan;
  doc["levelAir"] = levelAir;
  doc["mist"] = mistStatus;
  doc["kipas"] = fanStatus;
  doc["latencyMs"] = lastLatencyMs; // latency dari pengiriman SEBELUMNYA
  String body;
  serializeJson(doc, body);

  unsigned long t0 = millis();
  int code = http.POST(body);
  lastLatencyMs = millis() - t0;

  if (code != 200) {
    Serial.println("[Dashboard] Gagal kirim data, kode: " + String(code));
  }
  http.end();
}

// ================= FUNGSI AMBIL MODE & PERINTAH MANUAL =================
void ambilKontrolDariServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/control?deviceId=" + String(DEVICE_ID);
  http.begin(client, url);
  http.setTimeout(2000);

  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    StaticJsonDocument<150> doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err) {
      modeSaatIni = doc["mode"].as<String>();
      manualMist  = doc["mist"];
      manualKipas = doc["kipas"];
    }
  } else {
    Serial.println("[Dashboard] Gagal ambil kontrol, kode: " + String(code));
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  // Inisialisasi Pin Output & Pastikan Beban Awal Mati
  pinMode(PIN_MIST, OUTPUT);
  pinMode(PIN_FAN, OUTPUT);
  digitalWrite(PIN_MIST, LOW);
  digitalWrite(PIN_FAN, LOW);

  // Inisialisasi Float Switch dengan internal pull-up
  pinMode(PIN_FLOAT, INPUT_PULLUP);

  // Inisialisasi DHT22
  dht.begin();

  Serial.println("\n=== SMART ADAPTIVE HUMIDIFIER SYSTEM ===");
  connectWiFi();
}

void loop() {
  // Jaga koneksi Wi-Fi jika terputus di tengah jalan
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastWiFiCheck = 0;
    if (millis() - lastWiFiCheck > 15000) {
      lastWiFiCheck = millis();
      Serial.println("[Wi-Fi] Koneksi terputus. Mencoba rekoneksi...");
      WiFi.reconnect();
    }
  }

  // Rutinitas non-blocking pembacaan sensor dan aksi kendali
  unsigned long currentMillis = millis();
  if (currentMillis - previousMillis >= INTERVAL) {
    previousMillis = currentMillis;

    // 0. Ambil mode & perintah terbaru dari dashboard
    ambilKontrolDariServer();

    // 1. Cek Ketersediaan Air (Proteksi Utama, berlaku di mode apapun)
    int floatReading = digitalRead(PIN_FLOAT);
    isWaterEmpty = (floatReading == WATER_EMPTY_STATE);

    // 2. Baca Suhu & Kelembapan
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();

    // Validasi Sensor DHT22
    if (isnan(humidity) || isnan(temperature)) {
      Serial.println("[ERROR] Gagal membaca data dari DHT22! Mematikan aktuator demi keamanan.");
      digitalWrite(PIN_MIST, LOW);
      digitalWrite(PIN_FAN, LOW);
      return;
    }

    // Tampilkan Log Status
    Serial.println("--------------------------------------------------");
    Serial.printf("Mode: %s | Suhu: %.1f °C | Kelembapan: %.1f %% | Status Air: %s\n",
                  modeSaatIni.c_str(), temperature, humidity, (isWaterEmpty ? "HABIS (CUTOFF)" : "TERSEDIA"));

    /* if (isWaterEmpty) {
      // Proteksi pelat atomisasi: tangki kosong SELALU matiin alat,
      // baik di mode auto maupun manual.
      digitalWrite(PIN_MIST, LOW);
      digitalWrite(PIN_FAN, LOW);
      Serial.println("[STATUS] TANGKI KOSONG! Mist Maker & Kipas OFF otomatis.");
    }
    else if (modeSaatIni == "manual") {
      // Mode manual: nurut langsung ke perintah dari dashboard
      digitalWrite(PIN_MIST, manualMist ? HIGH : LOW);
      digitalWrite(PIN_FAN, manualKipas ? HIGH : LOW);
      Serial.printf("[MANUAL] Mist maker: %s | Kipas: %s\n",
                    manualMist ? "ON" : "OFF", manualKipas ? "ON" : "OFF");
    }
    else {
      // Mode auto: Algoritma Kendali Histeresis seperti biasa
      if (humidity < (TARGET_HUMIDITY - HYSTERESIS)) {
        digitalWrite(PIN_MIST, HIGH);
        digitalWrite(PIN_FAN, HIGH);
        Serial.println("[AKSI]   Kelembapan rendah -> Mist Maker ON, Kipas ON");
      }
      else if (humidity >= (TARGET_HUMIDITY + HYSTERESIS)) {
        digitalWrite(PIN_MIST, LOW);
        digitalWrite(PIN_FAN, LOW);
        Serial.println("[AKSI]   Kelembapan tercapai -> Mist Maker OFF, Kipas OFF");
      }
      else {
        Serial.println("[AKSI]   Kelembapan optimal (Zona Deadband)");
      }
    } */
    //tambahan
    if (isWaterEmpty) {
      currentMistState = 0;
      currentFanSpeedPercent = 0;
      Serial.println("[STATUS] TANGKI KOSONG! Mist Maker & Kipas OFF otomatis.");
    }
    else if (modeSaatIni == "manual") {
      currentMistState = manualMist ? 1 : 0;
      currentFanSpeedPercent = terapkanBatasMinimum(manualKipas);
      Serial.printf("[MANUAL] Mist maker: %s | Kipas: %d%%\n",
                    currentMistState ? "ON" : "OFF", currentFanSpeedPercent);
    }
    else {
      if (humidity < (TARGET_HUMIDITY - HYSTERESIS)) {
        currentMistState = 1;
        float deficit = (TARGET_HUMIDITY - HYSTERESIS) - humidity;
        deficit = constrain(deficit, 0.0, MAX_DEFICIT);
        int speed = FAN_MIN_SPEED + (int)((deficit / MAX_DEFICIT) * (FAN_MAX_SPEED - FAN_MIN_SPEED));
        currentFanSpeedPercent = terapkanBatasMinimum(speed);
        Serial.printf("[AKSI]   Kelembapan rendah -> Mist ON, Kipas %d%% (selisih %.1f%%)\n",
                      currentFanSpeedPercent, deficit);
      }
      else if (humidity >= (TARGET_HUMIDITY + HYSTERESIS)) {
        currentMistState = 0;
        currentFanSpeedPercent = 0;
        Serial.println("[AKSI]   Kelembapan tercapai -> Mist Maker OFF, Kipas OFF");
      }
      else {
        Serial.println("[AKSI]   Kelembapan optimal (Zona Deadband)");
      }
    }

    // 3. Kirim data terbaru ke dashboard
    /* kirimDataKeServer(
      temperature,
      humidity,
      isWaterEmpty ? 1 : 0,
      digitalRead(PIN_MIST),
      digitalRead(PIN_FAN)
    ); */
    digitalWrite(PIN_MIST, currentMistState ? HIGH : LOW);
    analogWrite(PIN_FAN, map(currentFanSpeedPercent, 0, 100, 0, 1023));

    kirimDataKeServer(
      temperature,
      humidity,
      isWaterEmpty ? 1 : 0,
      currentMistState,
      currentFanSpeedPercent
    );
  }
}
