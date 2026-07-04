# JMeter 부하 테스트

MONI 프로젝트의 JMeter 부하 테스트 스크립트입니다.

## 구조

```
jmeter/
├── common/
│   └── run.sh                  # 실행 스크립트
└── user/
    ├── refresh-token-race.jmx  # refresh token rotation 동시성 검증
    └── README.md
```

## 사전 준비

### 1. JMeter 설치

```bash
brew install jmeter
```

### 2. 환경변수 설정

k6와 동일한 루트 `.env`를 재사용합니다.

```bash
cp .env.example .env
```

| 변수                                  | 설명           |
|-------------------------------------|--------------|
| `BASE_URL`                          | 테스트 대상 서버 주소 |
| `USER1_EMAIL` ~ `USER3_EMAIL`       | 테스트 계정 이메일   |
| `USER1_PASSWORD` ~ `USER3_PASSWORD` | 테스트 계정 비밀번호  |

### 3. 실행

```bash
# 서비스별 실행
./jmeter/common/run.sh jmeter/user/refresh-token-race.jmx before 100
./jmeter/common/run.sh jmeter/user/refresh-token-race.jmx after 100

# run.sh 없이 직접 실행 (Windows 등)
jmeter -n -t jmeter/user/refresh-token-race.jmx -l results/jmeter/result.jtl \
  -JPROTOCOL=http -JHOST=localhost -JPORT=8080 \
  -JTEST_EMAIL=<이메일> -JTEST_PASSWORD=<비밀번호> -JCONCURRENCY=100

# GUI로 구조 확인/디버깅
jmeter -t jmeter/user/refresh-token-race.jmx
```

## 시나리오 구성

각 서비스별 테스트 대상 API, 시나리오 상세는 각 폴더의 README를 참조하세요.

| 서비스  | README                                  |
|------|-----------------------------------------|
| user | [jmeter/user/README.md](user/README.md) |

## 주의사항

- GUI 모드는 테스트 작성/디버깅 용도로만 사용하고, 실제 측정값(Before/After 비교 등)은 반드시 non-GUI(`-n`) 모드로 뽑을 것
- 동시성 재현 테스트는 서버 상태(Redis/DB)를 변경하므로, 운영 서버가 아닌 개발/테스트 서버 대상으로만 실행할 것
