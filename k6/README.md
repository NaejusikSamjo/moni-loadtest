# k6 부하 테스트

MONI 프로젝트의 k6 부하 테스트 스크립트입니다.

## 구조

```
k6/
├── common/
│   └── helpers.js          # 공통 — 인증 헤더, URL 빌더, 체크 래퍼
├── trade/
│   └── trade.test.js       # 계좌·자산·보유·매수/매도 (Kafka 가장 많음)
├── stock/
│   └── stock.test.js       # 종목 검색·상세·차트·테마·거래량
├── portfolio/
│   └── portfolio.test.js   # 포트폴리오 생성·AI 분석 요청·이력
├── payment/
│   └── payment.test.js     # 구독 상태·결제 내역·검증 케이스
├── ai/
│   └── ai.test.js          # 관심 기업 목록·캐시 조회·RAG 이슈 분석
└── user/
    └── user.test.js        # 로그인 반복 부하
```

## 사전 준비

### 1. k6 설치

```bash
brew install k6
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어 아래 항목을 추가합니다.

| 변수                                  | 설명           |
|-------------------------------------|--------------|
| `BASE_URL`                          | 테스트 대상 서버 주소 |
| `USER1_EMAIL` ~ `USER3_EMAIL`       | 테스트 계정 이메일   |
| `USER1_PASSWORD` ~ `USER3_PASSWORD` | 테스트 계정 비밀번호  |

테스트 계정은 `POST /api/v1/auth/signup` 으로 사전 생성 필요.  
가입 조건: 이메일, 비밀번호(영문+숫자+특수문자 8자 이상), 이름(한글 2자 이상)

k6 실행 시 `setup()`에서 자동 로그인하여 매 테스트마다 신규 토큰을 발급받습니다. 토큰을 직접 관리할 필요 없습니다.

### 3. 실행

```bash
# 서비스별 실행
k6 run k6/user/user.test.js
k6 run k6/trade/trade.test.js
k6 run k6/stock/stock.test.js
k6 run k6/portfolio/portfolio.test.js
k6 run k6/payment/payment.test.js
k6 run k6/ai/ai.test.js

# 특정 시나리오만
k6 run --scenario smoke k6/trade/trade.test.js

# 결과 JSON 저장
k6 run --out json=results/trade.json k6/trade/trade.test.js
```

## 시나리오 구성

각 서비스별 테스트 대상 API, 시나리오 상세, 커스텀 메트릭은 각 폴더의 README를 참조하세요.

| 서비스       | README                                        |
|-----------|-----------------------------------------------|
| user      | [k6/user/README.md](user/README.md)           |
| trade     | [k6/trade/README.md](trade/README.md)         |
| stock     | [k6/stock/README.md](stock/README.md)         |
| portfolio | [k6/portfolio/README.md](portfolio/README.md) |
| payment   | [k6/payment/README.md](payment/README.md)     |
| ai        | [k6/ai/README.md](ai/README.md)               |

## 주의사항

- `POST /api/v1/stocks/download/stocks` — 코스피/코스닥/테마 마스터 초기 적재용. 한 번이라도 호출하면 전체 마스터 데이터가 덮어씌워짐. **테스트에 절대 포함 금지.**
- `POST /api/v1/payments/subscription` — 실제 Toss PG 연동 필요, 검증 케이스(400)만 포함
- `DELETE /api/v1/payments/subscriptions` — 실제 구독 취소, 반복 호출 불가
