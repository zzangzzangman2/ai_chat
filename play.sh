#!/bin/sh
set -eu

# 프로젝트 경로
PROJECT_DIR="/root/ai-chat/ai"

# 백업 저장 경로
OUTDIR="/home/ec2-user/ai-backup"

cd "$PROJECT_DIR"

# 1) build (실패 시 종료)
npm run build

# 2) KST 기준 파일명: chat_MMDD_HHMM.zip (예: chat_0108_1000.zip)
# TZ=Asia/Seoul 은 한국시간(KST)로 date를 찍어줌
TS="$(TZ=Asia/Seoul date +"%m%d_%H%M")"

mkdir -p "$OUTDIR"

zip -r "$OUTDIR/chat_${TS}.zip" . \
  -x "node_modules/*" \
  -x ".next/*" \
  -x ".env.local" \
  -x "data/*" \
  -x "data.sqlite3" \
  -x "*.log" \
  -x ".turbo/*" \
  -x ".vercel/*" \
  -x "out/*" \
  -x "coverage/*" \
  -x "**/*.map" \
  -x "ai/public/uploads/*" \
  -x "ai/public/uploads/**" \
  -x "**/.DS_Store"

echo "✅ BACKUP CREATED: $OUTDIR/chat_${TS}.zip"

# 3) start
npm run start
