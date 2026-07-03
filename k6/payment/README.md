# payment 부하 테스트

## 테스트 대상 API

| 메서드  | 경로                                      | 설명                       |
|------|-----------------------------------------|--------------------------|
| GET  | `/api/v1/payments/subscriptions/status` | 구독 상태 조회                 |
| GET  | `/api/v1/payments`                      | 결제 내역 페이징 조회             |
| POST | `/api/v1/payments/subscription`         | 구독 요청 — 검증 케이스(400)만 테스트 |

> `POST /api/v1/payments/subscription` 실제 결제는 Toss PG authKey/customerKey 필요 → 빈 body로 검증 레이어만 테스트  
> `DELETE /api/v1/payments/subscriptions` 는 실제 구독 취소로 반복 호출 불가 → 테스트 제외

## 시나리오

### smoke
- 2 VU / 30초
- 구독 상태·결제 내역 기본 응답 확인

### read_load
- 0 → 40 VU ramping
- 구독 상태 + 결제 내역을 배치로 동시 요청 — 결제 확인 페이지 진입 패턴
- DB 조회 응답 시간 측정

### subscription_validation
- 5 req/s / 1분 (arrival-rate)
- 빈 body로 구독 API 요청 → 400 응답 확인
- 실제 PG 호출 없이 검증 레이어 부하 측정

## 핵심 관찰 포인트

- 구독 상태 조회 응답 시간 (p95, p99)
- 결제 내역 페이징 DB 응답 시간
- 검증 레이어 처리 성능

## 메트릭

| 메트릭                           | 임계값            |
|-------------------------------|----------------|
| `payment_status_duration_ms`  | p(95) < 800ms  |
| `payment_history_duration_ms` | p(95) < 1000ms |
| `payment_error_rate`          | rate < 5%      |
