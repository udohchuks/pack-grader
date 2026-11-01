// Pack Grader demo firmware (ESP32, Arduino core).
//
// Prints the charger current in amps, one value per line, 50 lines a second,
// at 115200 baud. The Pack Grader server reads this over USB.
//
// BOOT button:
//   short press  -> "CMD PREDICT", then a simulated plug-in curve
//   long press   -> "CMD LABEL <health>", then a simulated plug-in curve
//   double press -> next simulated pack health (LED blinks N times for preset N)
// The LED stays on while a curve is running.
//
// Set USE_REAL_SENSOR to 1 to read the SCT-013 clamp on GPIO34 instead of
// simulating the current. Commands still work in that mode.

#include <Arduino.h>
#include <math.h>

#define USE_REAL_SENSOR 0

const int BUTTON_PIN = 0;
const int LED_PIN = 2;

const unsigned long PERIOD_US = 20000;     // one value every 20 ms = 50 Hz
const unsigned long LONG_PRESS_MS = 1000;
const unsigned long DOUBLE_PRESS_MS = 400;
const unsigned long PLUG_DELAY_MS = 1000;  // quiet time between command and curve
const unsigned long PLUGGED_MS = 40000;    // curve length before auto-unplug

const float PRESETS[] = {0.92, 0.85, 0.75, 0.65, 0.55};
const int N_PRESETS = sizeof(PRESETS) / sizeof(PRESETS[0]);
int preset = 0;

// Simulated plug-in state
bool pending = false;       // command sent, curve starts at plugAt
bool plugged = false;
unsigned long plugAt = 0;
float health = PRESETS[0];

// Button state
bool lastDown = false;
unsigned long downAt = 0;
unsigned long upAt = 0;
int shortPresses = 0;

// LED blink state (non-blocking, so the 50 Hz stream never stalls)
int blinksLeft = 0;
unsigned long nextToggle = 0;

#if USE_REAL_SENSOR
const int CLAMP_PIN = 34;
const int LOOPS = 10;          // times the live wire passes through the clamp
const float AMPS_PER_MV = 0.1; // SCT-013 100A/1V: 1 mV = 0.1 A
float mid = 0;                 // pin voltage at zero current, in mV
#endif

float gauss(float mean, float sd) {
  // Box-Muller, using the ESP32 hardware random number generator.
  float u1 = (esp_random() + 1.0f) / 4294967297.0f;
  float u2 = esp_random() / 4294967296.0f;
  return mean + sd * sqrtf(-2.0f * logf(u1)) * cosf(2.0f * PI * u2);
}

bool busy() { return pending || plugged; }

void sendCommand(bool label) {
  if (busy()) return;  // the server ignores commands while a curve runs
  health = PRESETS[preset];
  if (label) {
    Serial.printf("CMD LABEL %.2f\n", health);
  } else {
    Serial.println("CMD PREDICT");
  }
  pending = true;
  plugAt = millis() + PLUG_DELAY_MS;
}

void nextPreset() {
  if (busy()) return;
  preset = (preset + 1) % N_PRESETS;
  blinksLeft = (preset + 1) * 2;  // on + off per blink
  nextToggle = millis();
}

void pollButton() {
  bool down = digitalRead(BUTTON_PIN) == LOW;
  unsigned long now = millis();
  if (down && !lastDown) downAt = now;
  if (!down && lastDown) {
    unsigned long held = now - downAt;
    if (held >= LONG_PRESS_MS) {
      shortPresses = 0;
      sendCommand(true);
    } else if (held > 30) {  // ignore contact bounce
      shortPresses++;
      upAt = now;
    }
  }
  lastDown = down;

  // A short press waits DOUBLE_PRESS_MS to be sure it is not a double press.
  if (shortPresses && !down && now - upAt > DOUBLE_PRESS_MS) {
    if (shortPresses >= 2) nextPreset();
    else sendCommand(false);
    shortPresses = 0;
  }
}

void updateLed() {
  unsigned long now = millis();
  if (pending && now >= plugAt) {
    pending = false;
    plugged = true;
  }
  if (plugged && now - plugAt >= PLUGGED_MS) plugged = false;

  if (plugged) {
    digitalWrite(LED_PIN, HIGH);
  } else if (blinksLeft > 0) {
    if (now >= nextToggle) {
      digitalWrite(LED_PIN, blinksLeft % 2 == 0 ? HIGH : LOW);
      blinksLeft--;
      nextToggle = now + 180;
    }
  } else {
    digitalWrite(LED_PIN, LOW);
  }
}

float simulatedAmps() {
  if (!plugged) return fabsf(gauss(0.01, 0.006));
  // A worn pack steps higher and keeps rising for longer.
  float t = (millis() - plugAt) / 1000.0f;
  float wear = 1.0f - health;
  float step = 1.55f + 0.9f * wear;
  float rise = 0.12f + 0.8f * wear;
  float tau = 3.0f + 14.0f * wear;
  return step + rise * (1.0f - expf(-t / tau)) + gauss(0, 0.012);
}

#if USE_REAL_SENSOR
float clampAmps() {
  // RMS over one 50 Hz cycle; takes 20 ms, which also paces the output.
  double sumSq = 0;
  int n = 0;
  unsigned long start = micros();
  while (micros() - start < PERIOD_US) {
    float mv = analogReadMilliVolts(CLAMP_PIN) - mid;
    sumSq += mv * mv;
    n++;
  }
  return sqrt(sumSq / n) * AMPS_PER_MV / LOOPS;
}
#endif

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
#if USE_REAL_SENSOR
  analogSetAttenuation(ADC_11db);
  long sum = 0;
  for (int i = 0; i < 2000; i++) sum += analogReadMilliVolts(CLAMP_PIN);
  mid = sum / 2000.0;
#endif
}

void loop() {
  static unsigned long next = micros();
  pollButton();
  updateLed();
#if USE_REAL_SENSOR
  float amps = clampAmps();
#else
  float amps = simulatedAmps();
  while ((long)(micros() - next) < 0) {}
  next += PERIOD_US;
#endif
  Serial.println(amps, 3);
}
