/**
 * trade-service 부하 테스트
 *
 * 대상 엔드포인트:
 *   GET  /api/v1/accounts
 *   GET  /api/v1/assets
 *   GET  /api/v1/assets/holdings
 *   GET  /api/v1/holdings
 *   GET  /api/v1/holdings/:ticker
 *   POST /api/v1/trades/buy   ← Kafka 발행 (holding·portfolio·notification 갱신)
 *   POST /api/v1/trades/sell  ← Kafka 발행
 *   GET  /api/v1/trades
 *
 * 실행:
 *   export $(cat .env | xargs)
 *   k6 run k6/trade/trade.test.js
 *   k6 run --scenario smoke k6/trade/trade.test.js
 */

import http from 'k6/http';

import { sleep, check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { setupTokens, authHeaders, url, checkStatus } from '../common/helpers.js';

// ── 커스텀 메트릭 ───────────────────────────────────────────────
const buyDuration   = new Trend('trade_buy_duration_ms', true);
const sellDuration  = new Trend('trade_sell_duration_ms', true);
const tradeErrors   = new Rate('trade_error_rate');
const kafkaTriggers = new Counter('trade_kafka_trigger_count');

// ── 테스트 데이터 ────────────────────────────────────────────────
const TICKERS = ['005930', '000660', '005380', '035420', '000270', '068270', '035720'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Setup: 테스트 시작 전 1회 로그인 + 계좌 생성 ────────────────
export function setup() {
  const tokens = setupTokens();

  // 계좌가 없으면 생성, 이미 있으면 409 무시
  tokens.forEach((token) => {
    http.post(url('/api/v1/accounts'), null, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  });

  return { tokens };
}

// ── 옵션 & 시나리오 ─────────────────────────────────────────────
export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      tags: { scenario: 'smoke' },
      exec: 'smokeScenario',
    },
    read_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m',  target: 30 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'read_load' },
      exec: 'readScenario',
    },
    // 매수→매도 사이클 — Kafka 이벤트 가장 많이 발생
    trade_cycle: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 50,
      tags: { scenario: 'trade_cycle' },
      exec: 'tradeCycleScenario',
    },
    // 순간 동시 매수 spike
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
      exec: 'spikeBuyScenario',
    },
  },
  thresholds: {
    http_req_duration:      ['p(95)<2000', 'p(99)<5000'],
    http_req_failed:        ['rate<0.05'],
    trade_buy_duration_ms:  ['p(95)<3000', 'p(99)<6000'],
    trade_sell_duration_ms: ['p(95)<3000', 'p(99)<6000'],
    trade_error_rate:       ['rate<0.05'],
  },
};

// ── Teardown: 테스트 종료 후 보유 종목 전량 매도 ─────────────────
export function teardown(data) {
  data.tokens.forEach((token) => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const res = http.get(url('/api/v1/holdings?page=0&size=100'), { headers });
    if (res.status !== 200) return;

    const body = JSON.parse(res.body);
    const holdings = body.data?.content ?? [];

    holdings.forEach((h) => {
      http.post(
        url('/api/v1/trades/sell'),
        JSON.stringify({ ticker: h.ticker, quantity: h.quantity }),
        { headers },
      );
    });
  });
}

// ── Scenario 함수들 ─────────────────────────────────────────────

export function smokeScenario(data) {
  let r = http.get(url('/api/v1/accounts'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/accounts', 200, 404);

  r = http.get(url('/api/v1/assets'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/assets', 200, 404);

  sleep(2);
}

export function readScenario(data) {
  const ticker = pick(TICKERS);

  let r = http.get(url('/api/v1/accounts'), authHeaders(data.tokens));
  checkStatus(r, 'read/accounts', 200);

  r = http.get(url('/api/v1/assets'), authHeaders(data.tokens));
  checkStatus(r, 'read/assets', 200);

  r = http.get(url('/api/v1/assets/holdings?page=0&size=10'), authHeaders(data.tokens));
  checkStatus(r, 'read/assets-holdings', 200);

  r = http.get(url('/api/v1/holdings?page=0&size=10'), authHeaders(data.tokens));
  checkStatus(r, 'read/holdings', 200);

  r = http.get(url(`/api/v1/holdings/${ticker}`), authHeaders(data.tokens));
  checkStatus(r, 'read/holdings-ticker', 200, 404);

  r = http.get(url('/api/v1/trades?page=0&size=10'), authHeaders(data.tokens));
  checkStatus(r, 'read/trades', 200);

  sleep(1 + Math.random());
}

export function tradeCycleScenario(data) {
  const ticker = pick(TICKERS);
  const qty    = Math.floor(Math.random() * 3) + 1;

  // 매수 (Kafka: holding 생성/갱신, portfolio 갱신, notification)
  const buyRes = http.post(
    url('/api/v1/trades/buy'),
    JSON.stringify({ ticker, quantity: qty }),
    authHeaders(data.tokens),
  );
  buyDuration.add(buyRes.timings.duration);
  const buyOk = checkStatus(buyRes, 'trade/buy', 201);
  tradeErrors.add(!buyOk);

  if (!buyOk) { sleep(0.5); return; }
  kafkaTriggers.add(1);

  sleep(0.5 + Math.random() * 0.5);

  // 매도 (Kafka: holding 감소/삭제, portfolio 갱신, notification)
  const sellRes = http.post(
    url('/api/v1/trades/sell'),
    JSON.stringify({ ticker, quantity: qty }),
    authHeaders(data.tokens),
  );
  sellDuration.add(sellRes.timings.duration);
  const sellOk = checkStatus(sellRes, 'trade/sell', 200, 201);
  tradeErrors.add(!sellOk);
  if (sellOk) kafkaTriggers.add(1);

  sleep(0.5 + Math.random() * 0.5);
}

export function spikeBuyScenario(data) {
  const res = http.post(
    url('/api/v1/trades/buy'),
    JSON.stringify({ ticker: pick(TICKERS), quantity: 1 }),
    authHeaders(data.tokens),
  );
  buyDuration.add(res.timings.duration);
  tradeErrors.add(res.status !== 201);
  checkStatus(res, 'spike/buy', 201);
}
