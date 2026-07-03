/**
 * portfolio-service 부하 테스트
 *
 * 대상 엔드포인트:
 *   POST /api/v1/portfolio
 *   POST /api/v1/portfolio/ai-analysis              ← 202 Accepted → ai-service LLM
 *   GET  /api/v1/portfolio/ai-analysis/latest
 *   GET  /api/v1/portfolio/ai-analysis/:analysisId
 *   GET  /api/v1/portfolio/ai-analysis?page=&size=
 *
 * 실행:
 *   export $(cat .env | xargs)
 *   k6 run k6/portfolio/portfolio.test.js
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { setupTokens, authHeaders, url, checkStatus } from '../common/helpers.js';

const analysisReqDuration  = new Trend('portfolio_ai_request_duration_ms', true);
const analysisReadDuration = new Trend('portfolio_ai_read_duration_ms', true);
const readStressDuration   = new Trend('portfolio_read_stress_duration_ms', true);
const aiTriggerCount       = new Counter('portfolio_ai_trigger_count');
const portfolioErrors      = new Rate('portfolio_error_rate');

export function setup() {
  const tokens = setupTokens();

  // 포트폴리오가 없으면 생성, 이미 있으면 409 무시
  tokens.forEach((token) => {
    http.post(url('/api/v1/portfolio'), null, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  });

  return { tokens };
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
    read_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 15 },
        { duration: '1m',  target: 30 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'read_load' },
      exec: 'readScenario',
    },
    // AI 분석 요청 → Kafka → ai-service LLM 파이프라인 전체 부하
    ai_analysis_load: {
      executor: 'constant-arrival-rate',
      rate: 3,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 10,
      maxVUs: 30,
      tags: { scenario: 'ai_analysis_load' },
      exec: 'aiAnalysisScenario',
    },
    // AI 분석 조회 집중 — 제한 없는 GET 엔드포인트로 portfolio DB 커넥션 풀 스트레스
    read_stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 30 },
        { duration: '2m',  target: 50 },
        { duration: '30s', target: 0  },
      ],
      tags: { scenario: 'read_stress' },
      exec: 'readStressScenario',
    },
    // 순간 다수 분석 요청 — Kafka consumer lag 및 큐 깊이 관찰
    ai_analysis_spike: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: [
        { duration: '10s', target: 20 },
        { duration: '20s', target: 20 },
        { duration: '10s', target: 0  },
      ],
      preAllocatedVUs: 20,
      maxVUs: 50,
      tags: { scenario: 'ai_analysis_spike' },
      exec: 'aiAnalysisSpikeScenario',
    },
  },
  thresholds: {
    http_req_duration:                  ['p(95)<3000', 'p(99)<8000'],
    http_req_failed:                    ['rate<0.05'],
    portfolio_ai_request_duration_ms:   ['p(95)<2000'],
    portfolio_ai_read_duration_ms:      ['p(95)<1500'],
    portfolio_read_stress_duration_ms:  ['p(95)<1000'],
    portfolio_error_rate:               ['rate<0.05'],
  },
};

export function smokeScenario(data) {
  let r = http.post(url('/api/v1/portfolio'), null, authHeaders(data.tokens));
  checkStatus(r, 'smoke/portfolio-create', 201, 409);

  r = http.get(url('/api/v1/portfolio/ai-analysis/latest'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/ai-latest', 200, 404);

  r = http.get(url('/api/v1/portfolio/ai-analysis?page=0&size=5'), authHeaders(data.tokens));
  checkStatus(r, 'smoke/ai-history', 200);

  sleep(3);
}

export function readScenario(data) {
  let r = http.get(url('/api/v1/portfolio/ai-analysis/latest'), authHeaders(data.tokens));
  analysisReadDuration.add(r.timings.duration);
  portfolioErrors.add(!checkStatus(r, 'read/ai-latest', 200, 404));

  const page = Math.floor(Math.random() * 3);
  r = http.get(url(`/api/v1/portfolio/ai-analysis?page=${page}&size=10`), authHeaders(data.tokens));
  analysisReadDuration.add(r.timings.duration);
  portfolioErrors.add(!checkStatus(r, 'read/ai-history', 200));

  sleep(1 + Math.random() * 2);
}

export function readStressScenario(data) {
  // GET만 사용 — 1일 1회 제한 없음, portfolio DB 커넥션 풀 한계 관찰
  let r = http.get(url('/api/v1/portfolio/ai-analysis/latest'), authHeaders(data.tokens));
  readStressDuration.add(r.timings.duration);
  portfolioErrors.add(!checkStatus(r, 'stress/ai-latest', 200, 404));

  const page = Math.floor(Math.random() * 5);
  r = http.get(url(`/api/v1/portfolio/ai-analysis?page=${page}&size=10`), authHeaders(data.tokens));
  readStressDuration.add(r.timings.duration);
  portfolioErrors.add(!checkStatus(r, 'stress/ai-history', 200));

  sleep(0.5 + Math.random() * 0.5);
}

export function aiAnalysisScenario(data) {
  const r = http.post(url('/api/v1/portfolio/ai-analysis'), null, authHeaders(data.tokens));
  analysisReqDuration.add(r.timings.duration);

  // 429: 하루 1회 제한 초과 / 403: 무료 플랜 5회 총 한도 초과 → 서비스 정책 응답으로 에러 아님
  const ok = checkStatus(r, 'ai/analysis-request', 202, 429, 403);
  portfolioErrors.add(!ok);
  if (ok && r.status === 202) aiTriggerCount.add(1);

  sleep(1 + Math.random());
}

export function aiAnalysisSpikeScenario(data) {
  const r = http.post(url('/api/v1/portfolio/ai-analysis'), null, authHeaders(data.tokens));
  analysisReqDuration.add(r.timings.duration);
  portfolioErrors.add(![202, 429, 403].includes(r.status));
  checkStatus(r, 'spike/ai-analysis', 202, 429, 403);
}
