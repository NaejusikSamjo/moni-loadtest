# ai 부하 테스트

## 테스트 대상 API

| 메서드  | 경로                                  | 설명                                             |
|------|-------------------------------------|------------------------------------------------|
| GET  | `/api/v1/ai`                        | 뉴스 수집 대상 관심 기업 목록 조회                           |
| GET  | `/api/v1/ai/:ticker/issue-analysis` | 캐시된 기업 이슈 분석 결과 조회                             |
| POST | `/api/v1/ai/:ticker/issue-analysis` | RAG + LLM 기업 이슈 분석 생성 (body 없이 호출, 캐시 있으면 400) |

> 어드민 전용 뉴스 수집 API (`/api/v1/admin/ai/**`) 는 게이트웨이 미노출로 테스트 제외

## 시나리오

### smoke
- 1 VU / 30초
- 관심 기업 목록 → 캐시 조회 → RAG 분석 생성 순서로 1회씩 호출
- 전체 파이프라인 정상 동작 확인

### watchlist_load
- 0 → 40 VU ramping
- 관심 기업 목록 반복 조회 — 가벼운 엔드포인트 처리량 측정

### cache_read
- 15 req/s / 2분 (arrival-rate, 최대 50 VU)
- 종목별 캐시된 분석 결과 조회 반복
- Redis/pgvector 캐시 히트율 및 응답 시간 측정


## 핵심 관찰 포인트

- 캐시 조회 응답 시간 (p95 목표 500ms 이내)
- RAG + LLM 분석 생성 응답 시간 분포 (수초 ~ 수십초 범위)
- LLM 호출 횟수 추적 (`ai_rag_call_count`)

## 메트릭

| 메트릭                    | 임계값                  |
|------------------------|----------------------|
| `ai_cache_duration_ms` | p(95) < 500ms        |
| `ai_rag_duration_ms`   | p(95) < 15000ms      |
| `ai_rag_call_count`    | LLM 호출 횟수 누적 (비용 추적) |
| `ai_error_rate`        | rate < 5%            |
