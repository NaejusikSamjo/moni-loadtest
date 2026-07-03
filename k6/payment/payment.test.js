/**
 * payment-service 부하 테스트
 *
 * 대상 엔드포인트:
 *   GET    /api/v1/payments                       ← 결제 내역 페이징
 *   GET    /api/v1/payments/subscriptions/status  ← 구독 상태 조회
 *
 * 제외:
 *   POST   /api/v1/payments/subscription  — Toss PG authKey/customerKey 필요 (실제 결제 발생)
 *   DELETE /api/v1/payments/subscriptions — 실제 구독 취소, 반복 호출 불가
 *
 * 실행:
 *   export $(cat .env | xargs)
 *   k6 run k6/payment/payment.test.js
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { setupTokens, authHeaders, url, checkStatus } from '../common/helpers.js';

const statusDuration  = new Trend('payment_status_duration_ms', true);
const historyDuration = new Trend('payment_history_duration_ms', true);
const paymentErrors   = new Rate('payment_error_rate');

export function setup() {
  return { tokens: setupTokens() };
}

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      tags: { scenario: 'smoke' },
      exec: 'smokeScenario',
    },
    // 결제 확인 페이지 진입 패턴
    read_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m',  target: 40 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'read_load' },
      exec: 'readScenario',
    },
    // 빈 body → 400 확인 (실제 결제 미발생, 검증 레이어 부하 측정)
    subscription_validation: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 10,
      maxVUs: 20,
      tags: { scenario: 'subscription_validation' },
      exec: 'subscriptionValidationScenario',
    },
  },
  thresholds: {
    http_req_duration:           ['p(95)<1000', 'p(99)<2000'],
    http_req_failed:             ['rate<0.05'],
    payment_status_duration_ms:  ['p(95)<800'],
    payment_history_duration_ms: ['p(95)<1000'],
    payment_error_rate:          ['rate<0.05'],
  },
};

export function smokeScenario(data) {
  let r = http.get(url('/api/v1/payments/subscriptions/status'), authHeaders(data.tokens));
  statusDuration.add(r.timings.duration);
  checkStatus(r, 'smoke/sub-status', 200, 404);

  r = http.get(url('/api/v1/payments?page=0&size=10'), authHeaders(data.tokens));
  historyDuration.add(r.timings.duration);
  checkStatus(r, 'smoke/history', 200);

  sleep(3);
}

export function readScenario(data) {
  const responses = http.batch([
    ['GET', url('/api/v1/payments/subscriptions/status'), null, authHeaders(data.tokens)],
    ['GET', url('/api/v1/payments?page=0&size=10'),       null, authHeaders(data.tokens)],
  ]);

  statusDuration.add(responses[0].timings.duration);
  paymentErrors.add(!checkStatus(responses[0], 'read/sub-status', 200, 404));

  historyDuration.add(responses[1].timings.duration);
  paymentErrors.add(!checkStatus(responses[1], 'read/history', 200));

  sleep(1 + Math.random() * 2);
}

export function subscriptionValidationScenario(data) {
  // 빈 body로 validation 레이어 테스트 — 실제 PG 호출 없음
  const r = http.post(
    url('/api/v1/payments/subscription'),
    JSON.stringify({}),
    authHeaders(data.tokens),
  );
  paymentErrors.add(![400, 422].includes(r.status));
  checkStatus(r, 'validation/subscription', 400, 422);

  sleep(0.5 + Math.random());
}
