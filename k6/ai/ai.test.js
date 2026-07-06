/**
 * ai-service 부하 테스트
 *
 * 대상 엔드포인트:
 *   GET  /api/v1/ai                          ← 관심 기업 목록
 *   GET  /api/v1/ai/:ticker/issue-analysis   ← 캐시된 분석 결과 조회
 *   POST /api/v1/ai/:ticker/issue-analysis   ← RAG + LLM 이슈 분석 생성 (고비용)
 *   GET  /api/v1/ai/news                     ← 뉴스 목록 조회
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

// 뉴스 조회 전용 메트릭
const newsDuration  = new Trend('ai_news_duration_ms', true);
const newsErrors    = new Rate('ai_news_error_rate');

// 삼성전자, SK하이닉스, 현대차 — 지원되는 종목만 포함
const TICKERS = ['005930', '000660', '005380'];

// 뉴스 필터용 데이터 (신규 추가)
const COMPANY_NAMES = ['삼성전자', 'SK하이닉스', '현대차'];
const KEYWORDS      = ['실적', '수주', '계약', 'M&A', '소송'];
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
    // 뉴스 목록 조회 부하 (신규 추가)
    news_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m',  target: 40 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'news_load' },
      exec: 'newsListScenario',
    },
    news_filter: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 10,
      maxVUs: 30,
      tags: { scenario: 'news_filter' },
      exec: 'newsFilterScenario',
    },
  },
  thresholds: {
    http_req_duration:    ['p(95)<10000', 'p(99)<20000'],
    http_req_failed:      ['rate<0.05'],
    ai_rag_duration_ms:   ['p(95)<15000'],
    ai_cache_duration_ms: ['p(95)<500'],
    ai_error_rate:        ['rate<0.05'],
    // 뉴스 조회 임계값
    ai_news_duration_ms:  ['p(95)<3000'],
    ai_news_error_rate:   ['rate<0.05'],
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
    { ...authHeaders(data.tokens), timeout: '30s'
    ,responseCallback: http.expectedStatuses(200, 409)
    },
  );
  ragDuration.add(r.timings.duration);
  ragCallCount.add(1);
  checkStatus(r, 'smoke/rag-create', 201, 409);

  sleep(2);

  // 스모크: 뉴스 기본 조회 (신규 추가)
  r = http.get(
      url('/api/v1/ai/news'),
      {
        ...authHeaders(data.tokens),
        responseCallback: http.expectedStatuses(200),
      }
  );
  newsDuration.add(r.timings.duration);
  newsErrors.add(!checkStatus(r, 'smoke/news-default', 200));

  sleep(1);

  // 스모크: ticker 필터 뉴스 조회 (신규 추가)
  r = http.get(
      url(`/api/v1/ai/news?ticker=005930`),
      {
        ...authHeaders(data.tokens),
        responseCallback: http.expectedStatuses(200),
      }
  );
  newsDuration.add(r.timings.duration);
  newsErrors.add(!checkStatus(r, 'smoke/news-ticker', 200));

  sleep(5);
}

export function watchlistScenario(data) {
  const r = http.get(url('/api/v1/ai'), authHeaders(data.tokens));
  aiErrors.add(!checkStatus(r, 'watchlist/list', 200));
  sleep(0.5 + Math.random());
}

export function cacheReadScenario(data) {
  const ticker = pick(TICKERS);
  const r      = http.get(url(`/api/v1/ai/${ticker}/issue-analysis`),
  {
  ...authHeaders(data.tokens),
      responseCallback: http.expectedStatuses(200, 404),  // 이게 http_req_failed에서 404 제외
  });
  cacheDuration.add(r.timings.duration);
  aiErrors.add(![200, 404].includes(r.status));
  checkStatus(r, 'cache/read', 200, 404);
  sleep(0.3 + Math.random() * 0.5);
}

// 뉴스 목록 기본 조회 시나리오 (신규 추가)
export function newsListScenario(data) {
  const r = http.get(
      url('/api/v1/ai/news'),
      {
        ...authHeaders(data.tokens),
        responseCallback: http.expectedStatuses(200),
      }
  );
  newsDuration.add(r.timings.duration);
  newsErrors.add(!checkStatus(r, 'news/list', 200));
  sleep(0.5 + Math.random());
}

// 뉴스 필터 조회 시나리오 (신규 추가)
// ticker / companyName / keyword / 날짜 조합을 랜덤으로 테스트
export function newsFilterScenario(data) {
  const scenario = Math.floor(Math.random() * 4);
  let queryUrl;

  switch (scenario) {
    case 0:
      // ticker 필터
      queryUrl = `/api/v1/ai/news?ticker=${pick(TICKERS)}`;
      break;
    case 1:
      // companyName 필터
      queryUrl = `/api/v1/ai/news?companyName=${encodeURIComponent(pick(COMPANY_NAMES))}`;
      break;
    case 2:
      // keyword 필터
      queryUrl = `/api/v1/ai/news?keyword=${encodeURIComponent(pick(KEYWORDS))}`;
      break;
    case 3:
      // ticker + 날짜 필터 조합
      const today = new Date().toISOString().split('T')[0];
      queryUrl = `/api/v1/ai/news?ticker=${pick(TICKERS)}&date=${today}`;
      break;
  }

  const r = http.get(
      url(queryUrl),
      {
        ...authHeaders(data.tokens),
        responseCallback: http.expectedStatuses(200),
      }
  );
  newsDuration.add(r.timings.duration);
  newsErrors.add(!checkStatus(r, 'news/filter', 200));
  sleep(0.3 + Math.random() * 0.5);
}

