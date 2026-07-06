# portfolio 부하 테스트

## 테스트 대상 API

| 메서드  | 경로                                          | 설명                                               |
|------|---------------------------------------------|--------------------------------------------------|
| POST | `/api/v1/portfolio`                         | 포트폴리오 생성 (setup에서 1회)                            |
| POST | `/api/v1/portfolio/ai-analysis`             | AI 분석 요청 → 202 Accepted 또는 정책 응답              |
| GET  | `/api/v1/portfolio/ai-analysis/latest`      | 최신 AI 분석 결과 조회                                   |
| GET  | `/api/v1/portfolio/ai-analysis/:analysisId` | AI 분석 단건 조회                                      |
| GET  | `/api/v1/portfolio/ai-analysis`             | AI 분석 이력 페이징 조회                                  |

## 시나리오

### smoke
- 2 VU / 30초
- 포트폴리오 생성·분석 이력 조회 기본 응답 확인

### read_load
- 0 → 30 VU ramping
- 최신 분석 결과 및 이력 페이징 반복 조회
- 분석 결과 DB 조회 응답 시간 측정

### read_stress
- 0 → 50 VU ramping (30s 증가 → 2분 유지 → 30s 감소)
- AI 분석 조회 GET 엔드포인트만 사용 — **1일 1회 제한 없음**
- sleep 0.5~1초로 read_load보다 짧게 → DB 커넥션 풀 포화 지점 탐색
- portfolio-service DB 처리량 한계 및 커넥션 풀 고갈 여부 관찰

### ai_analysis_load
- 3 req/s / 2분 (arrival-rate, 최대 30 VU)
- 아래 흐름을 동시에 관찰:
- **신규 요청** → 202 Accepted — portfolio-service 요청 수락 및 async worker 등록 성능
- **오늘 PENDING 분석이 있는 요청** → 202 Accepted — 기존 analysisId를 반환하는 멱등 응답 성능
- **이미 성공한 분석 또는 무료 한도 초과** → 429/403 — 정책 차단 응답 성능
- 202 응답이면 body의 `analysisId`로 `GET /api/v1/portfolio/ai-analysis/:analysisId`를 1회 호출해 단건 조회까지 확인
- 429/403은 **정상 정책 응답**으로 처리 — `portfolio_error_rate`에 집계되지 않음
- `http_req_failed`에서도 403/404/409/429를 expected status로 처리
- 실제 LLM 호출은 계정당 하루 1번 수준이므로, 이 시나리오는 대량 LLM 부하보다 요청 수락/멱등/정책 응답 부하를 관찰하는 목적이 크다.

### ai_analysis_spike
- 0 → 50 VU 순간 급증
- 동시 다수 분석 요청 집중 시 202 멱등 응답과 429/403 정책 응답 지연 여부 관찰
- 202 응답이면 단건 조회를 1회 추가 호출
- 429/403 에러로 집계 안 함 — 정책 차단 자체가 정상 동작

## setup

- 로그인 후 포트폴리오 자동 생성 (이미 있으면 409 무시)

## 핵심 관찰 포인트

- AI 분석 요청 응답 시간 (202 반환까지, p95 목표 2초 이내)
- 202 응답 이후 단건 조회 응답 시간
- 분석 이력 조회 DB 응답 시간
- 202 멱등 응답, 429/403 정책 차단 비율 (테스트 계정 무료 플랜 기준, 정상 동작)

## 메트릭

| 메트릭                                 | 임계값                |
|-------------------------------------|--------------------|
| `portfolio_ai_request_duration_ms`  | p(95) < 2000ms     |
| `portfolio_ai_read_duration_ms`     | p(95) < 1500ms     |
| `portfolio_read_stress_duration_ms` | p(95) < 1000ms     |
| `portfolio_ai_accepted_count`       | 202 Accepted 응답 누적 횟수 |
| `portfolio_error_rate`              | rate < 5%          |

## 정상 정책 응답

아래 상태 코드는 k6 `http_req_failed`에서도 expected status로 처리한다.

| 상태 코드 | 의미 |
|---------|------|
| 403 | 무료 플랜 분석 가능 횟수 초과 |
| 404 | 최신 성공 분석 결과 없음 |
| 409 | 포트폴리오가 이미 존재함 |
| 429 | 일일 분석 제한 초과 |
