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

// ID unik buat node ini — HARUS beda dari node lain yang udah ada di dashboard
const char* DEVICE_ID = "deteksi_suhu";

// ================= PEMETAAN PIN =================
#define PIN_DHT      D2   // GPIO4 - Data DHT11 (kasih pull-up 10k ke 3V3 kalau modulnya belum ada bawaan)
#define DHTTYPE      DHT11

DHT dht(PIN_DHT, DHTTYPE);

const unsigned long INTERVAL = 2000; // kirim data tiap 2 detik
unsigned long previousMillis = 0;
unsigned long lastLatencyMs = 0; // RTT pengiriman data sebelumnya, dalam milidetik

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
  } else {
    Serial.println("\n[Wi-Fi] Gagal terhubung. Mencoba lagi di siklus berikutnya.");
  }
}

// ================= FUNGSI KIRIM DATA KE DASHBOARD =================
void kirimDataKeServer(float suhu, float kelembapan) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/data";

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(2000);

  StaticJsonDocument<256> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["suhu"] = suhu;
  doc["kelembapan"] = kelembapan;
  doc["levelAir"] = 0;   // node ini nggak punya sensor level air, dikirim 0 (tidak relevan)
  doc["mist"] = 0;       // node ini nggak punya aktuator mist
  doc["kipas"] = 0;      // node ini nggak punya aktuator kipas
  doc["latencyMs"] = lastLatencyMs; // latency dari pengiriman SEBELUMNYA
  String body;
  serializeJson(doc, body);

  unsigned long t0 = millis();
  int code = http.POST(body);
  lastLatencyMs = millis() - t0;

  if (code != 200) {
    Serial.println("[Dashboard] Gagal kirim data, kode: " + String(code));
  } else {
    Serial.println("[Dashboard] Data terkirim.");
  }
  http.end();
}

void setup() {
  Serial.begin(9600);
  delay(1000);

  dht.begin();

  Serial.println("\n=== SENSOR NODE (DHT11) ===");
  Serial.println("Device ID: " + String(DEVICE_ID));
  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastWiFiCheck = 0;
    if (millis() - lastWiFiCheck > 15000) {
      lastWiFiCheck = millis();
      Serial.println("[Wi-Fi] Koneksi terputus. Mencoba rekoneksi...");
      WiFi.reconnect();
    }
  }

  unsigned long currentMillis = millis();
  if (currentMillis - previousMillis >= INTERVAL) {
    previousMillis = currentMillis;

    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();

    if (isnan(humidity) || isnan(temperature)) {
      Serial.println("[ERROR] Gagal membaca data dari DHT11! (cek wiring/pull-up)");
      return;
    }

    Serial.println("--------------------------------------------------");
    Serial.printf("Suhu: %.1f °C | Kelembapan: %.1f %%\n", temperature, humidity);

    kirimDataKeServer(temperature, humidity);
  }
}
