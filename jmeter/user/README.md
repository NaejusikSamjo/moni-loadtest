# user 동시성 테스트

## 테스트 대상 API

| 메서드  | 경로                     | 설명                                  |
|------|------------------------|-------------------------------------|
| POST | `/api/v1/auth/login`   | 사전 준비 — accessToken/refreshToken 발급 |
| POST | `/api/v1/auth/refresh` | 본 테스트 대상 — refresh token 기반 토큰 재발급  |

## 배경

- `AuthService.refresh()`: Redis에서 refresh token 조회(GET) → 검증 → 새 토큰으로 덮어쓰기(SET)
- GET → SET 원자성 없음 → 동일 토큰 동시 요청 시 전부 검증 통과 가능

## 시나리오

1. Setup (1회): 테스트 계정 로그인 → accessToken/refreshToken 획득
2. Concurrent Refresh: 동일한 refreshToken으로 N개 스레드가 SyncTimer로 동시 대기 → 동시에 `/api/v1/auth/refresh` 호출

## 실행

```bash
./jmeter/common/run.sh jmeter/user/refresh-token-race.jmx before 100   # Before — race condition 재현
./jmeter/common/run.sh jmeter/user/refresh-token-race.jmx after 100    # After — 수정 검증

# 대상 서버 override (기본값: 루트 .env의 BASE_URL)
BASE_URL=http://localhost:8080 ./jmeter/common/run.sh jmeter/user/refresh-token-race.jmx before 100

# run.sh 없이 직접 실행 (Windows 등)
jmeter -n -t jmeter/user/refresh-token-race.jmx -l results/jmeter/before.jtl \
  -JPROTOCOL=http -JHOST=localhost -JPORT=8080 \
  -JTEST_EMAIL=<이메일> -JTEST_PASSWORD=<비밀번호> -JCONCURRENCY=100

# GUI로 구조 확인/디버깅
jmeter -t jmeter/user/refresh-token-race.jmx
```

## 결과 확인

```bash
# run.sh 실행 시 라벨/상태코드별 개수 자동 집계

# 수동 집계 (리포 루트 기준)
awk -F',' 'NR>1 && $3 ~ /refresh/ {print $4}' results/jmeter/before.jtl | sort | uniq -c
awk -F',' 'NR>1 && $3 ~ /refresh/ {print $4}' results/jmeter/after.jtl  | sort | uniq -c

# HTML 리포트
jmeter -g results/jmeter/before.jtl -o results/jmeter/before-report
```

## 실측 결과 (CONCURRENCY=100)

| 상태                 | 200 성공 | 401 실패 |
|--------------------|--------|--------|
| Before (원자성 없음)    | 10     | 90     |
| After (원자적 CAS 적용) | **1**  | 99     |
