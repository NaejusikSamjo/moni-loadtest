# stock 부하 테스트

## 테스트 대상 API

| 메서드 | 경로                             | 설명                      |
|-----|--------------------------------|-------------------------|
| GET | `/api/v1/stocks/themes`        | 시장 카테고리별 거래량 Top5 테마 조회 |
| GET | `/api/v1/stocks/top-volume`    | 거래량 Top5 종목 조회 — 캐시 없음, 매 요청마다 KIS API 실시간 호출 |
| GET | `/api/v1/stocks/search`        | 키워드 종목 검색 (페이징)         |
| GET | `/api/v1/stocks/:ticker`       | 종목 상세 단건 조회             |
| GET | `/api/v1/stocks/:ticker/chart` | 분봉 차트 조회 (MIN_1/3/5/10) |

> `POST /api/v1/admin/stocks/download/stocks` 는 마스터 초기 적재용으로 **테스트에 절대 포함 금지** (호출마다 코스피/코스닥/테마 마스터 전체 재적재, 멱등성 없음)

## 시나리오

### smoke
- 2 VU / 30초
- 전 엔드포인트 정상 응답 확인

### market_overview
- 0 → 50 VU ramping
- themes + top-volume 배치 호출 후 키워드 검색 — 홈 화면 진입 패턴 시뮬레이션
- themes는 Redis 캐시(스케줄러가 60초마다 KIS 호출해 채움, 조회는 캐시만 읽음)라 안전하지만,
  top-volume은 캐시가 연결되어 있지 않아 매 요청이 KIS API를 직접 호출함 —
  고VU 구간에서 KIS 초당 호출 제한(EGW00201) 초과로 503 발생 가능 (실측: 50VU에서 top-volume 0.3~0.4% 실패)

### detail_chart
- 3 req/s / 2분 (arrival-rate, 최대 20 VU)
- 종목 상세 + 분봉 차트를 배치로 동시 요청 — 종목 상세 페이지 진입 패턴
- 차트 조회는 캐시 없이 매 요청마다 KIS API를 실시간 호출 → KIS 레이트리밋/제재 위험으로 rate를 낮게 유지

### search_stress
- 0 → 50 VU ramping
- 다양한 키워드(삼성, SK, 현대 등)로 검색 반복
- 검색 처리량 한계 및 응답 시간 분포 측정

## 핵심 관찰 포인트

- 검색 응답 시간 (p95, p99)
- 차트 조회 응답 시간 및 KIS API 실시간 호출 부하 (캐시 없음)
- top-volume KIS 레이트리밋 발생 빈도 (캐시 미연결 — themes만 실제로 Redis 캐시됨)
- 동시 검색 증가 시 처리량 한계

## 메트릭

| 메트릭                        | 임계값            |
|----------------------------|----------------|
| `stock_search_duration_ms` | p(95) < 1000ms |
| `stock_chart_duration_ms`  | p(95) < 2000ms |
| `stock_error_rate`         | rate < 3%      |
