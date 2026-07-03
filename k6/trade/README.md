# trade 부하 테스트

## 테스트 대상 API

| 메서드  | 경로                         | 설명                 |
|------|----------------------------|--------------------|
| GET  | `/api/v1/accounts`         | 계좌 조회              |
| POST | `/api/v1/accounts`         | 계좌 생성 (setup에서 1회) |
| GET  | `/api/v1/assets`           | 총 자산 조회            |
| GET  | `/api/v1/assets/holdings`  | 보유 종목 페이징 조회       |
| GET  | `/api/v1/holdings`         | 보유 종목 목록           |
| GET  | `/api/v1/holdings/:ticker` | 특정 종목 보유 조회        |
| POST | `/api/v1/trades/buy`       | 매수 → Kafka 이벤트 발행  |
| POST | `/api/v1/trades/sell`      | 매도 → Kafka 이벤트 발행  |
| GET  | `/api/v1/trades`           | 거래 내역 페이징 조회       |

## 시나리오

### smoke
- 2 VU / 30초
- 계좌·자산 조회 기본 응답 확인

### read_load
- 0 → 30 VU ramping
- 계좌·자산·보유종목·거래내역 조회를 순차 반복
- 조회 API 응답 시간 및 DB 부하 측정

### trade_cycle
- 10 req/s / 2분 (arrival-rate, 최대 50 VU)
- 매수 → 매도 순서로 반복 실행
- 매수/매도 각각 Kafka 이벤트 발행 → holding, portfolio, notification 서비스까지 연쇄 부하 발생
- Kafka 가장 많이 발생하는 시나리오

### spike
- 0 → 50 VU 순간 급증
- 동시 매수 집중 상황에서 처리량 한계 및 오류율 관찰

## setup / teardown

- **setup**: 로그인 후 계좌 자동 생성 (이미 있으면 409 무시)
- **teardown**: 테스트 종료 후 전 유저의 보유 종목 전량 매도 → 잔액 정리

## 핵심 관찰 포인트

- 매수/매도 응답 시간 (p95, p99)
- Kafka 이벤트 발행 후 downstream 서비스(portfolio, notification) 지연 여부
- 동시 거래 집중 시 오류율

## 메트릭

| 메트릭                         | 임계값                            |
|-----------------------------|--------------------------------|
| `trade_buy_duration_ms`     | p(95) < 3000ms, p(99) < 6000ms |
| `trade_sell_duration_ms`    | p(95) < 3000ms, p(99) < 6000ms |
| `trade_kafka_trigger_count` | 매수+매도 성공 횟수 누적                 |
| `trade_error_rate`          | rate < 5%                      |
