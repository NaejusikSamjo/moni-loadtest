# portfolio 부하 테스트

## 테스트 대상 API

| 메서드  | 경로                                          | 설명                                               |
|------|---------------------------------------------|--------------------------------------------------|
| POST | `/api/v1/portfolio`                         | 포트폴리오 생성 (setup에서 1회)                            |
| POST | `/api/v1/portfolio/ai-analysis`             | AI 분석 요청 → 202 Accepted → Kafka → ai-service LLM |
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
- 두 가지를 동시에 테스트:
  1. **첫 번째 요청** → 202 Accepted — Kafka 발행 후 ai-service LLM까지 파이프라인 처리 성능
  2. **이후 요청** → 429(일별 한도 초과) 또는 403(무료 5회 총 한도 초과) — 차단 정책이 높은 요청량에서도 빠르게 응답하는지 측정
- 429/403은 **정상 정책 응답**으로 처리 — `portfolio_error_rate`에 집계되지 않음
- 실제 LLM 호출은 계정당 하루 1번이므로 비용 과다 없음

### ai_analysis_spike
- 0 → 50 VU 순간 급증
- 동시 다수 분석 요청 집중 시 429/403 차단 응답 지연 여부 관찰
- 429/403 에러로 집계 안 함 — 차단 자체가 정상 동작

## setup

- 로그인 후 포트폴리오 자동 생성 (이미 있으면 409 무시)

## Kafka 흐름

```
POST /api/v1/portfolio/ai-analysis
  → portfolio-service (202 즉시 반환)
  → Kafka produce
  → ai-service consume → LLM 분석
  → Kafka produce (결과)
  → portfolio-service consume → DB 저장
```

## 핵심 관찰 포인트

- AI 분석 요청 응답 시간 (202 반환까지, p95 목표 2초 이내)
- Kafka consumer lag (분석 요청 집중 시)
- 분석 이력 조회 DB 응답 시간
- 429/403 정책 차단 비율 (테스트 계정 무료 플랜 기준, 정상 동작)

## 메트릭

| 메트릭                                 | 임계값                   |
|-------------------------------------|-----------------------|
| `portfolio_ai_request_duration_ms`  | p(95) < 2000ms        |
| `portfolio_ai_read_duration_ms`     | p(95) < 1500ms        |
| `portfolio_read_stress_duration_ms` | p(95) < 1000ms        |
| `portfolio_ai_kafka_trigger_count`  | AI 분석 Kafka 트리거 누적 횟수 |
| `portfolio_error_rate`              | rate < 5%             |
