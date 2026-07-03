/**
 * user-service 부하 테스트 — 로그인 반복
 *
 * 대상 엔드포인트:
 *   POST /api/v1/auth/login  ← JWT 발급 + Redis 저장
 *
 * setup() 없음 — 로그인 자체를 테스트하는 파일이므로 토큰 사전 발급 불필요.
 * .env의 USER{n}_EMAIL / USER{n}_PASSWORD 를 VU별로 순환 사용.
 *
 * 실행:
 *   export $(cat .env | xargs)
 *   k6 run k6/user/user.test.js
 *   k6 run --scenario smoke k6/user/user.test.js
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { url, checkStatus } from '../common/helpers.js';

const loginDuration = new Trend('user_login_duration_ms', true);
const loginErrors   = new Rate('user_login_error_rate');

const CREDS = [
  { email: __ENV.USER1_EMAIL, password: __ENV.USER1_PASSWORD },
  { email: __ENV.USER2_EMAIL, password: __ENV.USER2_PASSWORD },
  { email: __ENV.USER3_EMAIL, password: __ENV.USER3_PASSWORD },
].filter((c) => c.email && c.password);

function getCred() {
  return CREDS[(__VU - 1) % CREDS.length];
}

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      tags: { scenario: 'smoke' },
      exec: 'loginScenario',
    },
    // 정상 부하 — 동시 로그인 ramping
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m',  target: 50 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'load' },
      exec: 'loginScenario',
    },
    // 순간 동시 로그인 급증
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: [
        { duration: '10s', target: 50 },
        { duration: '20s', target: 50 },
        { duration: '10s', target: 0  },
      ],
      preAllocatedVUs: 50,
      maxVUs: 50,
      tags: { scenario: 'spike' },
      exec: 'loginScenario',
    },
  },
  thresholds: {
    http_req_duration:      ['p(95)<1000', 'p(99)<2000'],
    http_req_failed:        ['rate<0.05'],
    user_login_duration_ms: ['p(95)<1000', 'p(99)<2000'],
    user_login_error_rate:  ['rate<0.05'],
  },
};

export function loginScenario() {
  const cred = getCred();

  const r = http.post(
    url('/api/v1/auth/login'),
    JSON.stringify(cred),
    { headers: { 'Content-Type': 'application/json' } },
  );

  loginDuration.add(r.timings.duration);
  loginErrors.add(r.status !== 200);
  checkStatus(r, 'login', 200);

  sleep(0.5 + Math.random());
}
