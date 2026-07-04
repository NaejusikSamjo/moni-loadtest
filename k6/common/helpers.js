import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL;

/**
 * 테스트 시작 전 setup()에서 호출.
 * .env의 USER{n}_EMAIL / USER{n}_PASSWORD 로 로그인해 accessToken 배열 반환.
 *
 * 사용 예:
 *   export function setup() { return { tokens: setupTokens() }; }
 *   export function myScenario(data) { ... authHeaders(data.tokens) ... }
 */
export function setupTokens() {
  const creds = [
    { email: __ENV.USER1_EMAIL, password: __ENV.USER1_PASSWORD },
    { email: __ENV.USER2_EMAIL, password: __ENV.USER2_PASSWORD },
    { email: __ENV.USER3_EMAIL, password: __ENV.USER3_PASSWORD },
  ].filter((c) => c.email && c.password);

  if (creds.length === 0) {
    throw new Error('USER1_EMAIL / USER1_PASSWORD 환경변수를 설정하세요.');
  }

  return creds.map((cred) => {
    const res = http.post(
      url('/api/v1/auth/login'),
      JSON.stringify(cred),
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (res.status !== 200) {
      throw new Error(`로그인 실패 [${cred.email}] status=${res.status} body=${res.body}`);
    }

    const body = JSON.parse(res.body);
    return body.data.accessToken; // GlobalResponse<LoginResponse>.data.accessToken
  });
}

/**
 * VU 번호 기준으로 토큰을 순환 반환 (VU1→tokens[0], VU2→tokens[1], VU4→tokens[0] ...)
 */
export function getToken(tokens) {
  return tokens[(__VU - 1) % tokens.length];
}

export function authHeaders(tokens, extra = {}) {
  return {
    headers: {
      Authorization: `Bearer ${getToken(tokens)}`,
      'Content-Type': 'application/json',
      ...extra,
    },
  };
}

export function url(path) {
  return `${BASE_URL}${path}`;
}

/**
 * 응답 상태 체크. 허용 상태코드를 여러 개 지정 가능.
 * 반환값: 체크 통과 여부 (boolean)
 */
export function checkStatus(res, name, ...allowed) {
  const codes = allowed.length > 0 ? allowed : [200];
  return check(res, {
    [`${name} [${codes.join('|')}]`]: (r) => codes.includes(r.status),
  });
}
