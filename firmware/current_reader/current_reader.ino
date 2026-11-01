// Read an SCT-013 100A/1V clamp on an ESP32 and print the current in amps.
// Clamp -> bias circuit (centre about 1.65 V) -> GPIO34.
// Prints one amps value per line, about 50 a second, for the Pack Grader server.

const int   PIN         = 34;     // ADC1 pin, input only
const int   LOOPS       = 1;      // times the live wire passes through the clamp
const float AMPS_PER_MV = 0.1;    // clamp: 1 V = 100 A, so 1 mV = 0.1 A
const unsigned long CYCLE_US = 20000;  // one 50 Hz cycle = 20 ms

float mid = 0;  // pin voltage at zero current, in mV

void setup() {
  Serial.begin(115200);
  analogSetAttenuation(ADC_11db);  // lets the pin read up to about 3.1 V

  // Step 1: find the zero. Nothing may run through the clamp now.
  long sum = 0;
  for (int i = 0; i < 2000; i++) {
    sum += analogReadMilliVolts(PIN);
  }
  mid = sum / 2000.0;
  Serial.printf("mid = %.1f mV\n", mid);
}

void loop() {
  // Step 2: size of one wave (RMS) over one 20 ms cycle.
  double sumSq = 0;
  int n = 0;
  unsigned long start = micros();
  while (micros() - start < CYCLE_US) {
    float mv = analogReadMilliVolts(PIN) - mid;
    sumSq += mv * mv;
    n++;
  }
  float rmsMv = sqrt(sumSq / n);

  // Step 3: millivolts to amps.
  float amps = rmsMv * AMPS_PER_MV / LOOPS;

  Serial.println(amps, 3);
}
