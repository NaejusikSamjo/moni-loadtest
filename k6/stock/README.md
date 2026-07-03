# stock 부하 테스트

## 테스트 대상 API

| 메서드 | 경로                             | 설명                      |
|-----|--------------------------------|-------------------------|
| GET | `/api/v1/stocks/themes`        | 시장 카테고리별 거래량 Top5 테마 조회 |
| GET | `/api/v1/stocks/top-volume`    | 거래량 Top5 종목 조회          |
| GET | `/api/v1/stocks/search`        | 키워드 종목 검색 (페이징)         |
| GET | `/api/v1/stocks/:ticker`       | 종목 상세 단건 조회             |
| GET | `/api/v1/stocks/:ticker/chart` | 분봉 차트 조회 (MIN_1/3/5/10) |

> `POST /api/v1/stocks/download/stocks` 는 마스터 초기 적재용으로 **테스트에 절대 포함 금지**

## 시나리오

### smoke
- 2 VU / 30초
- 전 엔드포인트 정상 응답 확인

### market_overview
- 0 → 50 VU ramping
- themes + top-volume 배치 호출 후 키워드 검색 — 홈 화면 진입 패턴 시뮬레이션
- Redis 캐시 히트율 및 응답 시간 분포 측정

### detail_chart
- 20 req/s / 2분 (arrival-rate, 최대 50 VU)
- 종목 상세 + 분봉 차트를 배치로 동시 요청 — 종목 상세 페이지 진입 패턴
- 차트 데이터는 Redis 스케줄링 캐시 기반 → KIS API 직접 호출 없음

### search_stress
- 0 → 50 VU ramping
- 다양한 키워드(삼성, SK, 현대 등)로 검색 반복
- 검색 처리량 한계 및 응답 시간 분포 측정

## 핵심 관찰 포인트

- 검색 응답 시간 (p95, p99)
- 차트 조회 캐시 히트율 (Redis 스케줄링 캐시)
- 동시 검색 증가 시 처리량 한계

## 메트릭

| 메트릭                        | 임계값            |
|----------------------------|----------------|
| `stock_search_duration_ms` | p(95) < 1000ms |
| `stock_chart_duration_ms`  | p(95) < 2000ms |
| `stock_error_rate`         | rate < 3%      |
