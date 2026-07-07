/**
 * stock-service 부하 테스트
 *
 * 대상 엔드포인트:
 *   GET /api/v1/stocks/search?keyword=&page=&size=
 *   GET /api/v1/stocks/:ticker
 *   GET /api/v1/stocks/:ticker/chart?index=MIN_1|MIN_3|MIN_5|MIN_10
 *   GET /api/v1/stocks/themes
 *   GET /api/v1/stocks/top-volume
 *
 * 절대 호출 금지:
 *   POST /api/v1/admin/stocks/download/stocks — 코스피/코스닥/테마 마스터 초기 적재용.
 *   한 번이라도 호출하면 전체 마스터 데이터가 덮어씌워짐 (upsert 없이 매번 재적재, 멱등성 없음). 테스트에 절대 포함 금지.
 *
 * 실행:
 *   export $(cat .env | xargs)
 *   k6 run k6/stock/stock.test.js
 *   MSYS_NO_PATHCONV=1 docker run --rm -i --network moni-network --env-file .env -e SCENARIO=market_overview -v "$(pwd)/k6:/scripts" grafana/k6 run /scripts/stock/stock.test.js
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { setupTokens, authHeaders, url, checkStatus } from '../common/helpers.js';

const searchDuration = new Trend('stock_search_duration_ms', true);
const chartDuration  = new Trend('stock_chart_duration_ms', true);
const stockErrors    = new Rate('stock_error_rate');

const TICKERS  = ['005930', '000660', '005380', '035420', '000270', '068270', '035720', '373220', '012450', '086790'];
const KEYWORDS = ['삼성', 'SK', '현대', 'LG', '카카오', '네이버', '반도체'];
const INTERVALS = ['MIN_1', 'MIN_3', 'MIN_5', 'MIN_10'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function setup() {
  return { tokens: setupTokens() };
}

// SCENARIO 환경변수로 특정 시나리오만 실행 가능 (예: -e SCENARIO=smoke). k6 run 자체에는 시나리오 필터링 플래그가 없음.
const allScenarios = {
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      tags: { scenario: 'smoke' },
      exec: 'smokeScenario',
    },
    // 홈/메인 화면 진입 — themes + top-volume + search 동시 부하
    market_overview: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 30 },
        { duration: '2m',  target: 50 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'market_overview' },
      exec: 'marketOverviewScenario',
    },
    // 종목 상세 + 차트 동시 조회 (KIS API 응답 시간 관찰)
    // chart는 캐시 없이 매 요청마다 KIS API를 실시간 호출하므로 rate를 낮게 유지 — KIS 레이트리밋/제재 위험
    detail_chart: {
      executor: 'constant-arrival-rate',
      rate: 3,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 10,
      maxVUs: 20,
      tags: { scenario: 'detail_chart' },
      exec: 'detailChartScenario',
    },
    // 검색 키워드 다양화 스트레스
    search_stress: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: [
        { duration: '30s', target: 30 },
        { duration: '1m',  target: 50 },
        { duration: '30s', target: 0  },
      ],
      preAllocatedVUs: 40,
      maxVUs: 50,
      tags: { scenario: 'search_stress' },
      exec: 'searchStressScenario',
    },
};

export const options = {
  scenarios: __ENV.SCENARIO
    ? { [__ENV.SCENARIO]: allScenarios[__ENV.SCENARIO] }
    : allScenarios,
  thresholds: {
    http_req_duration:        ['p(95)<1500', 'p(99)<3000'],
    http_req_failed:          ['rate<0.03'],
    stock_search_duration_ms: ['p(95)<1000'],
    stock_chart_duration_ms:  ['p(95)<2000'],
    stock_error_rate:         ['rate<0.03'],
  },
};

export function smokeScenario(data) {
  let r = http.get(url('/api/v1/stocks/themes'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/themes', 200);

  r = http.get(url('/api/v1/stocks/top-volume'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/top-volume', 200);

  r = http.get(url(`/api/v1/stocks/search?keyword=${encodeURIComponent('삼성')}&page=0&size=10`), authHeaders(data.tokens));
  searchDuration.add(r.timings.duration);
  checkStatus(r, 'smoke/search', 200);

  r = http.get(url('/api/v1/stocks/005930'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/detail', 200);

  r = http.get(url('/api/v1/stocks/005930/chart?index=MIN_5'), authHeaders(data.tokens));
  chartDuration.add(r.timings.duration);
  checkStatus(r, 'smoke/chart', 200);

  sleep(3);
}

export function marketOverviewScenario(data) {
  const responses = http.batch([
    ['GET', url('/api/v1/stocks/themes'),     null, authHeaders(data.tokens)],
    ['GET', url('/api/v1/stocks/top-volume'), null, authHeaders(data.tokens)],
  ]);
  checkStatus(responses[0], 'overview/themes',     200);
  checkStatus(responses[1], 'overview/top-volume', 200);

  const kw = pick(KEYWORDS);
  const r  = http.get(
    url(`/api/v1/stocks/search?keyword=${encodeURIComponent(kw)}&page=0&size=10`),
    authHeaders(data.tokens),
  );
  searchDuration.add(r.timings.duration);
  stockErrors.add(!checkStatus(r, 'overview/search', 200));

  sleep(1 + Math.random() * 2);
}

export function detailChartScenario(data) {
  const ticker   = pick(TICKERS);
  const interval = pick(INTERVALS);

  const responses = http.batch([
    ['GET', url(`/api/v1/stocks/${ticker}`),                         null, authHeaders(data.tokens)],
    ['GET', url(`/api/v1/stocks/${ticker}/chart?index=${interval}`), null, authHeaders(data.tokens)],
  ]);

  stockErrors.add(!checkStatus(responses[0], 'detail/stock', 200, 404));
  chartDuration.add(responses[1].timings.duration);
  stockErrors.add(!checkStatus(responses[1], 'detail/chart', 200, 404));

  sleep(0.5 + Math.random());
}

export function searchStressScenario(data) {
  const kw   = pick(KEYWORDS);
  const page = Math.floor(Math.random() * 3);
  const r    = http.get(
    url(`/api/v1/stocks/search?keyword=${encodeURIComponent(kw)}&page=${page}&size=10`),
    authHeaders(data.tokens),
  );
  searchDuration.add(r.timings.duration);
  stockErrors.add(!checkStatus(r, 'stress/search', 200));

  sleep(0.3 + Math.random() * 0.5);
}
