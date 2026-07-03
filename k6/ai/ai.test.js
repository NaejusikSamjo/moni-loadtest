/**
 * ai-service 부하 테스트
 *
 * 대상 엔드포인트:
 *   GET  /api/v1/ai                          ← 관심 기업 목록
 *   GET  /api/v1/ai/:ticker/issue-analysis   ← 캐시된 분석 결과 조회
 *   POST /api/v1/ai/:ticker/issue-analysis   ← RAG + LLM 이슈 분석 생성 (고비용)
 *
 * 주의:
 *   POST는 Gemini/OpenAI LLM 호출 포함 — rate를 낮게 유지하고 API 비용/rate limit 주의
 *
 * 실행:
 *   export $(cat .env | xargs)
 *   k6 run k6/ai/ai.test.js
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { setupTokens, authHeaders, url, checkStatus } from '../common/helpers.js';

const ragDuration   = new Trend('ai_rag_duration_ms', true);
const cacheDuration = new Trend('ai_cache_duration_ms', true);
const ragCallCount  = new Counter('ai_rag_call_count');
const aiErrors      = new Rate('ai_error_rate');

// 삼성전자, SK하이닉스, 현대차 — 지원되는 종목만 포함
const TICKERS = ['005930', '000660', '005380'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function setup() {
  return { tokens: setupTokens() };
}

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      tags: { scenario: 'smoke' },
      exec: 'smokeScenario',
    },
    // 관심 기업 목록 — 가벼운 조회 부하
    watchlist_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m',  target: 40 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'watchlist_load' },
      exec: 'watchlistScenario',
    },
    // 캐시 조회 — Redis/pgvector 캐시 히트율 관찰
    cache_read: {
      executor: 'constant-arrival-rate',
      rate: 15,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 50,
      tags: { scenario: 'cache_read' },
      exec: 'cacheReadScenario',
    },
  },
  thresholds: {
    http_req_duration:    ['p(95)<10000', 'p(99)<20000'],
    http_req_failed:      ['rate<0.05'],
    ai_rag_duration_ms:   ['p(95)<15000'],
    ai_cache_duration_ms: ['p(95)<500'],
    ai_error_rate:        ['rate<0.05'],
  },
};

export function smokeScenario(data) {
  let r = http.get(url('/api/v1/ai'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/watchlist', 200);

  sleep(1);

  r = http.get(url('/api/v1/ai/005930/issue-analysis'), authHeaders(data.tokens));
  cacheDuration.add(r.timings.duration);
  checkStatus(r, 'smoke/cache-read', 200, 404);

  sleep(2);

  // question 없이 호출 — RAG 프롬프트가 알아서 처리, 캐시 있으면 400
  r = http.post(
    url('/api/v1/ai/005930/issue-analysis'),
    null,
    { ...authHeaders(data.tokens), timeout: '30s' },
  );
  ragDuration.add(r.timings.duration);
  ragCallCount.add(1);
  checkStatus(r, 'smoke/rag-create', 201, 400);

  sleep(5);
}

export function watchlistScenario(data) {
  const r = http.get(url('/api/v1/ai'), authHeaders(data.tokens));
  aiErrors.add(!checkStatus(r, 'watchlist/list', 200));
  sleep(0.5 + Math.random());
}

export function cacheReadScenario(data) {
  const ticker = pick(TICKERS);
  const r      = http.get(url(`/api/v1/ai/${ticker}/issue-analysis`), authHeaders(data.tokens));
  cacheDuration.add(r.timings.duration);
  aiErrors.add(![200, 404].includes(r.status));
  checkStatus(r, 'cache/read', 200, 404);
  sleep(0.3 + Math.random() * 0.5);
}

