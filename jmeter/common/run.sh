#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

JMX_FILE="${1:?사용법: run.sh <jmx파일 경로> <결과 라벨> [CONCURRENCY]}"
LABEL="${2:?결과 라벨을 지정하세요 (예: before, after)}"
CONCURRENCY="${3:-10}"

if command -v jmeter >/dev/null 2>&1; then
  JMETER_BIN="$(command -v jmeter)"
elif [ -n "${JMETER_HOME:-}" ] && [ -x "$JMETER_HOME/bin/jmeter" ]; then
  JMETER_BIN="$JMETER_HOME/bin/jmeter"
else
  echo "JMeter 실행 파일을 찾을 수 없습니다."
  echo "brew install jmeter 로 설치하거나, JMETER_HOME 환경변수로 설치 경로를 지정하세요."
  exit 1
fi

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo ".env 파일이 없습니다 ($ROOT_DIR/.env). .env.example을 참고해 생성하세요."
  exit 1
fi

while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  if [ -z "${!key:-}" ]; then
    export "$key=$value"
  fi
done < "$ROOT_DIR/.env"

PROTOCOL="${BASE_URL%%://*}"
REST="${BASE_URL#*://}"
HOST="${REST%%:*}"
if [[ "$REST" == *:* ]]; then
  PORT="${REST##*:}"
else
  PORT=""
fi

RESULT_DIR="$ROOT_DIR/results/jmeter"
mkdir -p "$RESULT_DIR"
RESULT_FILE="$RESULT_DIR/${LABEL}.jtl"
rm -f "$RESULT_FILE"

echo "=== JMeter 실행 ==="
echo "대상: $PROTOCOL://$HOST${PORT:+:$PORT}"
echo "동시 요청 수(CONCURRENCY): $CONCURRENCY"
echo "결과 파일: $RESULT_FILE"
echo "==================="

"$JMETER_BIN" -n \
  -t "$ROOT_DIR/$JMX_FILE" \
  -l "$RESULT_FILE" \
  -JPROTOCOL="$PROTOCOL" \
  -JHOST="$HOST" \
  -JPORT="$PORT" \
  -JTEST_EMAIL="${USER3_EMAIL:?.env에 USER3_EMAIL 필요}" \
  -JTEST_PASSWORD="${USER3_PASSWORD:?.env에 USER3_PASSWORD 필요}" \
  -JCONCURRENCY="$CONCURRENCY"

echo ""
echo "=== 결과 요약 (라벨/상태코드별 응답 수) ==="
awk -F',' 'NR>1 {print $3","$4}' "$RESULT_FILE" | sort | uniq -c
