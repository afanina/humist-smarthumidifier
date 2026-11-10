#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

#define DHTPIN D2
#define DHTTYPE DHT22
#define FLOAT_PIN D5
#define MIST_PIN D6
#define FAN_PIN D7

DHT dht(DHTPIN, DHTTYPE);

const char* ssid = "NAMA_WIFI";
const char* password = "PASSWORD_WIFI";
const char* serverIP = "192.168.1.XX";   // ganti sesuai IP laptop yang dicetak server pas npm start
const int serverPort = 3000;

unsigned long lastSend = 0;
const unsigned long interval = 3000;      // kirim data tiap 3 detik

void setup() {
  Serial.begin(115200);
  pinMode(FLOAT_PIN, INPUT_PULLUP);
  pinMode(MIST_PIN, OUTPUT);
  pinMode(FAN_PIN, OUTPUT);
  dht.begin();

  WiFi.begin(ssid, password);
  Serial.print("Menyambung ke WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nTersambung. IP ESP8266: " + WiFi.localIP().toString());
}

void kirimData(float suhu, float kelembapan, int levelAir) {
  WiFiClient client;
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/data";
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<200> doc;
  doc["suhu"] = suhu;
  doc["kelembapan"] = kelembapan;
  doc["levelAir"] = levelAir;
  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  Serial.println("POST /api/data -> " + String(code));
  http.end();
}

void ambilKontrol() {
  WiFiClient client;
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/control";
  http.begin(client, url);
  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    StaticJsonDocument<100> doc;
    deserializeJson(doc, payload);
    int mist = doc["mist"];
    int kipas = doc["kipas"];
    digitalWrite(MIST_PIN, mist ? HIGH : LOW);
    digitalWrite(FAN_PIN, kipas ? HIGH : LOW);
  } else {
    Serial.println("GET /api/control gagal -> " + String(code));
  }
  http.end();
}

void loop() {
  if (millis() - lastSend > interval) {
    lastSend = millis();

    float suhu = dht.readTemperature();
    float kelembapan = dht.readHumidity();
    int levelAir = !digitalRead(FLOAT_PIN);   // sesuaikan logikanya sama float switch kamu

    if (!isnan(suhu) && !isnan(kelembapan)) {
      kirimData(suhu, kelembapan, levelAir);
    } else {
      Serial.println("Gagal baca DHT22, cek wiring R1/pull-up.");
    }

    ambilKontrol();
  }
}
