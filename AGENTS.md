# AI 채팅서비스 작업 헌법 (Codex 필독)

## 절대 금지
- 기존 기능 삭제/비활성화/롤백 금지
- 변경은 최소 + additive(추가/보완) 방식만
- 패치 목적이 아닌 대규모 리팩터링 금지

## 핵심 파일 주의
- ai/app/api/chat/send/route.ts : 스트리밍/요약/비용/저장 핵심 로직 훼손 금지
- ai/lib/ai.ts : 스트리밍 delta/heartbeat/ping 로직 훼손 금지
- ai/app/components/ChatArea.tsx : personaOverride, suggestions 갱신, stream pacer, thinking UI, renderMode(소설) 관련 로직 제거 금지

## 출력/포맷 규칙
- 소설 모드 출력 규칙 유지: *...* 지문 / "..." 대사 / INFO 메타 블록만 허용 (기준선 준수)
- 마크다운 과다 사용 금지(스트리밍 깨짐 방지)

## 작업 방식
- 먼저 "현재 동작/에러 재현/원인"을 요약하고 변경안 제시
- 변경 파일은 최소화하고, 바뀐 파일/라인/의도를 정리
- 테스트/빌드 명령을 먼저 제안하고 실행 전 위험요소 경고

## 환경
- Amazon Linux 2023, Node 20.x, Next.js 16.1.1(App Router/Turbopack), TS, SQLite(better-sqlite3)
- 경로는 반드시 ai/ 기준으로 표기 (예: ai/app/...)
