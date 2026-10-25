#include <LiquidCrystal.h>
#include <avr/io.h>
#include <avr/interrupt.h>
#include <math.h>

LiquidCrystal lcd(7, 8, 9, 10, 11, 12);

const int SENSOR_PIN = A0;
const int BUTTON_PIN = 2;
const int AUDIO_PIN = 4;
const long DERIV_THRESHOLD = 3500L;

const unsigned long REFRACTORY_MS = 250;
const unsigned long MIN_BLOCKED_MS = 80;
const unsigned long MAX_BLOCKED_MS = 1500;

unsigned long lastTriggerTime = 0;
unsigned long blockedStartTime = 0;

const int N = 11;

const int diffCoeff[N] =
{
  -5,-4,-3,-2,-1,
   0,
   1, 2, 3, 4, 5
};

volatile uint16_t adcValue = 0;
volatile bool newSample = false;

uint16_t sgBuffer[N];
uint8_t sgIndex = 0;
bool sgFilled = false;

unsigned long trafficCount = 0;
unsigned long startTime = 0;
unsigned long lastEventTime = 0;

float lastPeak = 0;
float peak500 = 0;
float sgMin500 = 99999.0;
float sgMax500 = -99999.0;

enum DetectorState
{
  IDLE,
  BLOCKED
};

DetectorState detectorState = IDLE;

float currentPeak = 0;
int8_t triggerDirection = 0;

unsigned long lastDump = 0;

bool lastButtonState = HIGH;
bool audioPlaying = false;
unsigned long audioStartTime = 0;

void formatTime(unsigned long ms, char *buf)
{
  unsigned long totalSec = ms / 1000;

  int sec = totalSec % 60;
  int min = (totalSec / 60) % 60;
  int hr = totalSec / 3600;

  sprintf(buf, "%02d:%02d:%02d", hr, min, sec);
}

void setupTimer1()
{
  TCCR1A = 0;
  TCCR1B = 0;

  TCCR1B |= (1 << WGM12);
  OCR1A = 399;
  TIMSK1 |= (1 << OCIE1A);
  TCCR1B |= (1 << CS11);
}

void setupADC()
{
  ADMUX = (1 << REFS0);

  ADCSRA =
      (1 << ADEN)  |
      (1 << ADIE)  |
      (1 << ADPS2) |
      (1 << ADPS1);
}

ISR(TIMER1_COMPA_vect)
{
  ADCSRA |= (1 << ADSC);
}

ISR(ADC_vect)
{
  adcValue = ADC;
  newSample = true;
}

void setup()
{
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  pinMode(AUDIO_PIN, OUTPUT);
  digitalWrite(AUDIO_PIN, LOW);

  Serial.begin(115200);

  lcd.begin(16, 2);
  lcd.clear();
  lcd.print("Traffic Counter");
  delay(1000);
  lcd.clear();

  startTime = millis();

  cli();
  setupADC();
  setupTimer1();
  sei();
}

void loop()
{
  bool currentButton = digitalRead(BUTTON_PIN);

  if(lastButtonState == HIGH && currentButton == LOW)
  {
    trafficCount = 0;
    lastEventTime = 0;
    lastPeak = 0;

    peak500 = 0;
    sgMin500 = 99999.0;
    sgMax500 = -99999.0;

    detectorState = IDLE;
    triggerDirection = 0;
    startTime = millis();

    lastTriggerTime = 0;
    blockedStartTime = 0;
  }

  lastButtonState = currentButton;

  if(newSample)
  {
    uint16_t sample;

    noInterrupts();
    sample = adcValue;
    newSample = false;
    interrupts();

    sgBuffer[sgIndex] = sample;
    sgIndex++;

    if(sgIndex >= N)
    {
      sgIndex = 0;
      sgFilled = true;
    }

    if(sgFilled)
    {
      long diffSum = 0;

      for(int i = 0; i < N; i++)
      {
        int idx = (sgIndex + i) % N;
        diffSum += (long)sgBuffer[idx] * diffCoeff[i];
      }

      float sgDeriv =
          (diffSum / 110.0f) *
          5000.0f;

      float absDeriv = fabs(sgDeriv);

      if(absDeriv > peak500)
      {
        peak500 = absDeriv;
      }

      if(sgDeriv < sgMin500)
      {
        sgMin500 = sgDeriv;
      }

      if(sgDeriv > sgMax500)
      {
        sgMax500 = sgDeriv;
      }

      if(detectorState == IDLE)
      {
        if(absDeriv > DERIV_THRESHOLD &&
           !audioPlaying &&
           (millis() - lastTriggerTime > REFRACTORY_MS))
        {
          trafficCount++;

          digitalWrite(AUDIO_PIN, HIGH);
          audioStartTime = millis();
          audioPlaying = true;

          lastEventTime = millis() - startTime;
          blockedStartTime = millis();

          currentPeak = absDeriv;
          triggerDirection = (sgDeriv > 0) ? 1 : -1;
          detectorState = BLOCKED;

          char timeStr[10];
          formatTime(lastEventTime, timeStr);

          Serial.print("PASS,");
          Serial.print(timeStr);
          Serial.print(",");
          Serial.print(trafficCount);
          Serial.print(",,");
          Serial.print(lastEventTime);
          Serial.print(",");
          Serial.println(currentPeak, 0);
        }
      }
      else
      {
        if(absDeriv > currentPeak)
        {
          currentPeak = absDeriv;
        }

        unsigned long blockedTime = millis() - blockedStartTime;
        bool oppositeEdge =
            (triggerDirection > 0 && sgDeriv < -DERIV_THRESHOLD) ||
            (triggerDirection < 0 && sgDeriv > DERIV_THRESHOLD);

        if(blockedTime >= MIN_BLOCKED_MS && oppositeEdge)
        {
          lastPeak = currentPeak;

          lastTriggerTime = millis();
          triggerDirection = 0;
          detectorState = IDLE;
        }
        else if(blockedTime >= MAX_BLOCKED_MS)
        {
          lastTriggerTime = millis();
          triggerDirection = 0;
          detectorState = IDLE;
        }
      }
    }
  }

  if(millis() - lastDump >= 500)
  {
    lastDump = millis();

    char timeStr[10];
    formatTime(lastEventTime, timeStr);

    lcd.setCursor(0, 0);

    char line1[17];
    snprintf(line1, sizeof(line1), "Total Count:%4lu", trafficCount);
    lcd.print(line1);

    int len1 = strlen(line1);
    while(len1++ < 16)
    {
      lcd.print(' ');
    }

    lcd.setCursor(0, 1);

    char line2[17];
    snprintf(line2, sizeof(line2), "Last t :%s", timeStr);
    lcd.print(line2);

    int len2 = strlen(line2);
    while(len2++ < 16)
    {
      lcd.print(' ');
    }

    Serial.print("CNT=");
    Serial.print(trafficCount);

    Serial.print(" Peak500=");
    Serial.print(peak500, 0);

    Serial.print(" SGmin=");
    Serial.print(sgMin500, 1);

    Serial.print(" SGmax=");
    Serial.println(sgMax500, 1);

    peak500 = 0;
    sgMin500 = 99999.0;
    sgMax500 = -99999.0;
  }

  if(audioPlaying && millis() - audioStartTime >= 100)
  {
    digitalWrite(AUDIO_PIN, LOW);
    audioPlaying = false;
  }
}
