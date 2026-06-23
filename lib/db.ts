import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(process.cwd(), "data", "data.sqlite3");
export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
// (성능) 로컬 단일-프로세스 SQLite에 안전한 PRAGMA 기본값.
// - synchronous=NORMAL: WAL과 함께 commit 시 디스크 sync 회피 (전원 끊김 시 마지막 트랜잭션 손실 가능. 로컬 사용은 OK)
// - temp_store=MEMORY: 임시 인덱스/정렬 RAM에서. 대형 ORDER BY/JOIN 빨라짐.
// - mmap_size=256MB: 큰 DB도 페이지 캐시 hit ↑. 메모리 부족 환경엔 자동 줄임.
// - cache_size=-20000: 약 20MB 페이지 캐시 (음수=KB 기준)
// - busy_timeout=5000: 동시 쓰기 충돌 시 5초까지 대기 (lock 에러 회피)
db.pragma("synchronous = NORMAL");
db.pragma("temp_store = MEMORY");
db.pragma("mmap_size = 268435456");
db.pragma("cache_size = -20000");
db.pragma("busy_timeout = 5000");

function hasColumn(table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return rows.some((r) => r.name === column);
}

function ensureTableAndMigrations() {
  // 1) base tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      ownerEmail TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      background TEXT NOT NULL,
      character TEXT NOT NULL,
      systemPrompt TEXT NOT NULL,
      image TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT 'all',
      gallery TEXT NOT NULL DEFAULT '[]',
      firstMessages TEXT NOT NULL DEFAULT '[]',
      lorebooks TEXT NOT NULL DEFAULT '[]',
      memoryRoster TEXT NOT NULL DEFAULT '[]',
      createdAt INTEGER NOT NULL
    );

    
    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      imageUrl TEXT NOT NULL,
      linkUrl TEXT NOT NULL DEFAULT '',
      isActive INTEGER NOT NULL DEFAULT 1,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_banners_active_sort ON banners(isActive, sortOrder, createdAt);

    -- banners_live: what the public homepage actually reads.
    -- Admin edits go to "banners" (draft). Changes are published to banners_live only when admin clicks "적용".
    CREATE TABLE IF NOT EXISTS banners_live (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      imageUrl TEXT NOT NULL,
      linkUrl TEXT NOT NULL DEFAULT '',
      isActive INTEGER NOT NULL DEFAULT 1,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_banners_live_active_sort ON banners_live(isActive, sortOrder, createdAt);

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      presetId TEXT NOT NULL,
      title TEXT,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      imagesJson TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL DEFAULT 0,
      userEmail TEXT NOT NULL DEFAULT ''
    );CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      image TEXT,
      nickname TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      is_banned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      last_seen_at TEXT
    );
    
`);

  // users columns migrations (role/admin, ban, last login/seen)
  if (!hasColumn("users", "role")) {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  }
  if (!hasColumn("users", "is_banned")) {
    db.exec(`ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("users", "last_login_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN last_login_at TEXT`);
  }
  if (!hasColumn("users", "last_seen_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN last_seen_at TEXT`);
  }

  // profile / account lifecycle
  // - nickname_changed_at: nickname 변경 주기 제한(예: 7일 1회)
  // - deleted_at: 회원탈퇴 처리(논리 삭제)
  if (!hasColumn("users", "nickname_changed_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN nickname_changed_at INTEGER`);
  }
  if (!hasColumn("users", "deleted_at")) {
    db.exec(`ALTER TABLE users ADD COLUMN deleted_at TEXT`);
  }

  // presets columns migrations
  // (작품 제작자 표시를 위해 ownerEmail 저장)
  if (!hasColumn("presets", "ownerEmail")) {
    db.exec(`ALTER TABLE presets ADD COLUMN ownerEmail TEXT NOT NULL DEFAULT ''`);
  }

  // banners_live bootstrap (one-time): if live table is empty but draft table has data,
  // copy current ACTIVE draft banners into live so existing deployments don't suddenly show no banners.
  try {
    const liveCnt = db.prepare(`SELECT COUNT(1) AS n FROM banners_live`).get() as any;
    const draftCnt = db.prepare(`SELECT COUNT(1) AS n FROM banners`).get() as any;
    if ((liveCnt?.n ?? 0) === 0 && (draftCnt?.n ?? 0) > 0) {
      db.exec(`DELETE FROM banners_live`);
      db.exec(`
        INSERT INTO banners_live (imageUrl, linkUrl, isActive, sortOrder, createdAt)
        SELECT imageUrl, linkUrl, isActive, sortOrder, createdAt
        FROM banners
        WHERE isActive = 1
        ORDER BY sortOrder ASC, createdAt DESC
      `);
    }
  } catch {
    // ignore
  }

  // 0) friendfee (서버 영속화: 계정/기기 무관)
  // - wallet: 현재 잔액(실수)
  // - ledger: 증감 이력(중복 차감 방지용 messageId UNIQUE)
  // - attendance: 출석(하루 1회) + 연속 출석 계산용
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendfee_wallet (
      userEmail TEXT PRIMARY KEY,
      balance REAL NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS friendfee_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userEmail TEXT NOT NULL,
      kind TEXT NOT NULL, -- spend/checkin/admin/adjust
      delta REAL NOT NULL,
      balanceAfter REAL NOT NULL,
      chatId TEXT,
      messageId TEXT,
      totalTokens INTEGER,
      model TEXT,
      meta TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL,
      UNIQUE(userEmail, kind, messageId)
    );

    CREATE TABLE IF NOT EXISTS friendfee_attendance (
      userEmail TEXT NOT NULL,
      dayKey TEXT NOT NULL, -- YYYY-MM-DD
      createdAt INTEGER NOT NULL,
      PRIMARY KEY(userEmail, dayKey)
    );

    CREATE INDEX IF NOT EXISTS idx_friendfee_ledger_user ON friendfee_ledger(userEmail);
    CREATE INDEX IF NOT EXISTS idx_friendfee_ledger_chat ON friendfee_ledger(userEmail, chatId);
    CREATE INDEX IF NOT EXISTS idx_friendfee_att_user ON friendfee_attendance(userEmail);
  `);

// (추가) 멀티 유저 분리: 소유자 컬럼
if (!hasColumn("presets", "userEmail")) {
  db.exec(`ALTER TABLE presets ADD COLUMN userEmail TEXT NOT NULL DEFAULT ''`);
}

if (!hasColumn("presets", "isPublic")) {
  db.exec(`ALTER TABLE presets ADD COLUMN isPublic INTEGER NOT NULL DEFAULT 1`);
  // 기존 작품은 모두 공개로
  db.exec(`UPDATE presets SET isPublic = 1 WHERE isPublic IS NULL`);
}

if (!hasColumn("presets", "isNsfw")) {
  db.exec(`ALTER TABLE presets ADD COLUMN isNsfw INTEGER NOT NULL DEFAULT 0`);
}
if (!hasColumn("chats", "userEmail")) {
  db.exec(`ALTER TABLE chats ADD COLUMN userEmail TEXT NOT NULL DEFAULT ''`);
}
if (!hasColumn("messages", "userEmail")) {
  db.exec(`ALTER TABLE messages ADD COLUMN userEmail TEXT NOT NULL DEFAULT ''`);
}


// messages columns (imagesJson / updatedAt)
if (!hasColumn("messages", "imagesJson")) {
  db.exec(`ALTER TABLE messages ADD COLUMN imagesJson TEXT NOT NULL DEFAULT ''`);
}
if (!hasColumn("messages", "updatedAt")) {
  db.exec(`ALTER TABLE messages ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0`);
  // backfill: treat createdAt as updatedAt when missing
  try {
    db.exec(`UPDATE messages SET updatedAt = createdAt WHERE updatedAt = 0 OR updatedAt IS NULL`);
  } catch {}
}
if (!hasColumn("persona_profiles", "userEmail")) {
  db.exec(`ALTER TABLE persona_profiles ADD COLUMN userEmail TEXT NOT NULL DEFAULT ''`);
}
if (!hasColumn("user_profile", "userEmail")) {
  db.exec(`ALTER TABLE user_profile ADD COLUMN userEmail TEXT NOT NULL DEFAULT ''`);
}

// 인덱스(조회 성능)
db.exec(`CREATE INDEX IF NOT EXISTS idx_presets_userEmail ON presets(userEmail)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_userEmail ON chats(userEmail)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_userEmail ON messages(userEmail)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_persona_profiles_userEmail ON persona_profiles(userEmail)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_preset_user_createdAt ON chats(presetId, userEmail, createdAt DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat_createdAt ON messages(chatId, createdAt)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat_role_createdAt_desc ON messages(chatId, role, createdAt DESC)`);

  // 2) presets columns (추가)
  if (!hasColumn("presets", "characterName")) {
    db.exec(`ALTER TABLE presets ADD COLUMN characterName TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("presets", "characterAge")) {
    db.exec(`ALTER TABLE presets ADD COLUMN characterAge INTEGER NOT NULL DEFAULT 0`);
  }

  // 3) workspace builder columns
  if (!hasColumn("presets", "image")) {
    db.exec(`ALTER TABLE presets ADD COLUMN image TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("presets", "tags")) {
    db.exec(`ALTER TABLE presets ADD COLUMN tags TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("presets", "target")) {
    db.exec(`ALTER TABLE presets ADD COLUMN target TEXT NOT NULL DEFAULT 'all'`);
  }
  if (!hasColumn("presets", "gallery")) {
    db.exec(`ALTER TABLE presets ADD COLUMN gallery TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!hasColumn("presets", "firstMessages")) {
    db.exec(`ALTER TABLE presets ADD COLUMN firstMessages TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!hasColumn("presets", "lorebooks")) {
    db.exec(`ALTER TABLE presets ADD COLUMN lorebooks TEXT NOT NULL DEFAULT '[]'`);
  }

  // Roster-only story memory: JSON array string (e.g. ["미연","천소"]).
  // - Empty roster means: do NOT auto-register characters.
  if (!hasColumn("presets", "memoryRoster")) {
    db.exec(`ALTER TABLE presets ADD COLUMN memoryRoster TEXT NOT NULL DEFAULT '[]'`);
  }

  // 3) chat_settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_settings (
      chatId TEXT PRIMARY KEY,

      personaName TEXT NOT NULL DEFAULT '',
      personaAge INTEGER NOT NULL DEFAULT 0,
      personaGender TEXT NOT NULL DEFAULT '',
      personaInfo TEXT NOT NULL DEFAULT '',

      memoryFrom INTEGER NOT NULL DEFAULT 12,
      memoryTo INTEGER NOT NULL DEFAULT 24,
      -- 최근 원문(유저 입력) 턴 수 (user 메시지 1개 = 1턴)
      keepUserTurns INTEGER NOT NULL DEFAULT 12,
      recentSummaryN INTEGER NOT NULL DEFAULT 50,
      summaryEvery INTEGER NOT NULL DEFAULT 5,
      -- 턴당 글자수: 10~200(step 10) (default 50)
      summaryLength INTEGER NOT NULL DEFAULT 50,

      userNote TEXT NOT NULL DEFAULT '',

	      model TEXT NOT NULL DEFAULT 'gemini-2.5-pro',
	      maxOutputTokens INTEGER NOT NULL DEFAULT 1300,
      maxReasoningTokens INTEGER NOT NULL DEFAULT 768,

      thinkingBudget INTEGER NOT NULL DEFAULT 1024,

      narrationColor TEXT NOT NULL DEFAULT '#666666',

      -- 렌더링 모드: chat(기존 채팅) / novel(소설형)
      renderMode TEXT NOT NULL DEFAULT 'novel',
      
      -- (장기기억 요약.txt) assistant 턴당 목표 글자수 (80/140/200)
      longMemoryPerTurnChars INTEGER NOT NULL DEFAULT 80,

      updatedAt INTEGER NOT NULL
    );
  `);

  // 3-1) chat_settings columns (추가)
  if (!hasColumn("chat_settings", "summaryEvery")) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN summaryEvery INTEGER NOT NULL DEFAULT 5`);
  }
  if (!hasColumn("chat_settings", "summaryLength")) {
    // 턴당 글자수: 10~200(step 10), default 50
    db.exec(`ALTER TABLE chat_settings ADD COLUMN summaryLength INTEGER NOT NULL DEFAULT 50`);
  }

  if (!hasColumn("chat_settings", "thinkingBudget")) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN thinkingBudget INTEGER NOT NULL DEFAULT 1024`);
  }
  
  
  // chat_settings: keepUserTurns (최근 원문으로 포함할 user턴 수)
  if (!hasColumn("chat_settings", "keepUserTurns")) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN keepUserTurns INTEGER NOT NULL DEFAULT 12`);
  }

// chat_settings: longMemoryGuidance (장기기억 생성 가이던스 - 채팅별)
  if (!hasColumn("chat_settings", "longMemoryGuidance")) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN longMemoryGuidance TEXT NOT NULL DEFAULT ''`);
  }


// chat_settings: longMemoryPerTurnChars (장기기억 요약.txt 턴당 글자 목표)
if (!hasColumn("chat_settings", "longMemoryPerTurnChars")) {
  db.exec(`ALTER TABLE chat_settings ADD COLUMN longMemoryPerTurnChars INTEGER NOT NULL DEFAULT 80`);
}

if (!hasColumn("chat_settings", "narrationColor")) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN narrationColor TEXT NOT NULL DEFAULT '#666666'`);
  }

  // chat_settings: renderMode (채팅/소설 렌더링 모드)
  if (!hasColumn("chat_settings", "renderMode")) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN renderMode TEXT NOT NULL DEFAULT 'novel'`);
  }

  db.prepare(
    `UPDATE chat_settings
     SET model='gemini-2.5-pro'
     WHERE model IN ('gemini-2.5-flash', 'gemini-2-5-pro', 'gemini-2-5-flash')`
  ).run();
  // (변경) flash 모델 통합 ID: gemini-3.5-flash. 이전 별칭들 모두 자동 매핑.
  db.prepare(
    `UPDATE chat_settings
     SET model='gemini-3.5-flash'
     WHERE model IN ('gemini-3-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-preview', 'gemini-3.5-flash-preview', 'gemini-3.5-flash-lite')`
  ).run();
  db.prepare(
    `UPDATE chat_settings
     SET model='gemini-3.1-pro-preview'
     WHERE model IN ('gemini-3-pro', 'gemini-3-pro-preview', 'gemini-3.1-pro')`
  ).run();
  // 4) chat_memory_cache (최근 요약/길이 확인용)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_memory_cache (
      chatId TEXT PRIMARY KEY,
      recentSummary TEXT NOT NULL DEFAULT '',
      recentSummaryChars INTEGER NOT NULL DEFAULT 0,
      summaryEvery INTEGER NOT NULL DEFAULT 5,
      summaryLength INTEGER NOT NULL DEFAULT 50,
      updatedAt INTEGER NOT NULL
    );
  `);

  // chat_memory_cache columns (누적 요약을 위한 포인터)
  if (!hasColumn("chat_memory_cache", "summaryEvery")) {
    db.exec(`ALTER TABLE chat_memory_cache ADD COLUMN summaryEvery INTEGER NOT NULL DEFAULT 5`);
  }
  if (!hasColumn("chat_memory_cache", "summaryLength")) {
    db.exec(`ALTER TABLE chat_memory_cache ADD COLUMN summaryLength INTEGER NOT NULL DEFAULT 50`);
  }
  if (!hasColumn("chat_memory_cache", "lastSummarizedAt")) {
    db.exec(`ALTER TABLE chat_memory_cache ADD COLUMN lastSummarizedAt INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("chat_memory_cache", "rolledUpCount")) {
    db.exec(`ALTER TABLE chat_memory_cache ADD COLUMN rolledUpCount INTEGER NOT NULL DEFAULT 0`);
  }

  // chat_memory_cache: summarizedEndTurn (요약이 어디까지 생성되었는지 포인터)
  // - recentSummary 텍스트(헤더) 파싱에만 의존하면, 사용자가 수동 편집하거나 모델이 포맷을 바꾸는 경우
  //   다음 구간(예: 6-10)이 1-5로 반복 생성되는 문제가 발생할 수 있어 별도 포인터를 둔다.
  if (!hasColumn("chat_memory_cache", "summarizedEndTurn")) {
    db.exec(`ALTER TABLE chat_memory_cache ADD COLUMN summarizedEndTurn INTEGER NOT NULL DEFAULT 0`);
  }

  // 4-0) chat_memory_blocks (장기기억 블록 단위 저장; append-only)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_memory_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId TEXT NOT NULL,
      startTurn INTEGER NOT NULL,
      endTurn INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      summaryChars INTEGER NOT NULL DEFAULT 0,
      summaryEvery INTEGER NOT NULL DEFAULT 5,
      summaryLength INTEGER NOT NULL DEFAULT 50,
      model TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(chatId, startTurn)
    );
  `);
  // Ensure UNIQUE(chatId, startTurn) even if the table existed before without the constraint.
  // (CREATE TABLE IF NOT EXISTS does not retrofit constraints on existing tables.)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_memory_blocks_chat_start ON chat_memory_blocks(chatId, startTurn)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_memory_blocks_chat_end_desc ON chat_memory_blocks(chatId, endTurn DESC)`);


  // chat_memory_blocks column migrations (forward compatible)
  if (!hasColumn("chat_memory_blocks", "summaryEvery")) {
    db.exec(`ALTER TABLE chat_memory_blocks ADD COLUMN summaryEvery INTEGER NOT NULL DEFAULT 5`);
  }
  if (!hasColumn("chat_memory_blocks", "summaryLength")) {
    db.exec(`ALTER TABLE chat_memory_blocks ADD COLUMN summaryLength INTEGER NOT NULL DEFAULT 50`);
  }
  if (!hasColumn("chat_memory_blocks", "model")) {
    db.exec(`ALTER TABLE chat_memory_blocks ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("chat_memory_blocks", "meta")) {
    db.exec(`ALTER TABLE chat_memory_blocks ADD COLUMN meta TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("chat_memory_blocks", "createdAt")) {
    db.exec(`ALTER TABLE chat_memory_blocks ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("chat_memory_blocks", "updatedAt")) {
    db.exec(`ALTER TABLE chat_memory_blocks ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0`);
  }

  // 4-0-FTS) chat_memory_blocks 검색 가속용 FTS5 인덱스
  // - 기존 검색은 1200행 LIMIT 후 JS에서 부분문자열 매칭이라 채팅이 길어질수록 느려진다.
  // - FTS5(trigram) 인덱스를 추가해 한국어/영어 부분일치를 SQL 인덱스로 처리.
  // - 암호화 저장 환경에서는 summary가 "enc:v1:..."로 들어가 인덱싱이 무의미하므로,
  //   트리거에서 평문(=prefix가 아닌 것)만 인덱싱하도록 가드한다.
  // - 검색측은 FTS 결과가 없으면 기존 스캔으로 자연 fallback되도록 호출측에서 처리한다.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_memory_blocks_fts USING fts5(
        chatId UNINDEXED,
        summary,
        tokenize = 'trigram'
      );
    `);

    // INSERT: 평문일 때만 인덱스 추가. rowid는 원본 PK(id)와 매칭해 추후 JOIN을 빠르게 함.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chat_memory_blocks_ai
      AFTER INSERT ON chat_memory_blocks
      WHEN substr(new.summary, 1, 7) != 'enc:v1:'
      BEGIN
        INSERT INTO chat_memory_blocks_fts(rowid, chatId, summary)
        VALUES (new.id, new.chatId, new.summary);
      END;
    `);

    // DELETE: 인덱스에서 해당 rowid 제거.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chat_memory_blocks_ad
      AFTER DELETE ON chat_memory_blocks
      BEGIN
        DELETE FROM chat_memory_blocks_fts WHERE rowid = old.id;
      END;
    `);

    // UPDATE: 일단 삭제 후 평문이면 다시 추가. (암호화 토글되는 경우 대비)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chat_memory_blocks_au
      AFTER UPDATE ON chat_memory_blocks
      BEGIN
        DELETE FROM chat_memory_blocks_fts WHERE rowid = old.id;
        INSERT INTO chat_memory_blocks_fts(rowid, chatId, summary)
        SELECT new.id, new.chatId, new.summary
        WHERE substr(new.summary, 1, 7) != 'enc:v1:';
      END;
    `);

    // 백필: 평문 행 중 인덱스에 없는 것만 보충(반복 실행 안전).
    db.exec(`
      INSERT INTO chat_memory_blocks_fts(rowid, chatId, summary)
      SELECT b.id, b.chatId, b.summary
      FROM chat_memory_blocks b
      WHERE substr(b.summary, 1, 7) != 'enc:v1:'
        AND NOT EXISTS (
          SELECT 1 FROM chat_memory_blocks_fts f WHERE f.rowid = b.id
        );
    `);
  } catch {
    // FTS5는 빌드 옵션에 따라 사용 불가할 수 있다. 그 경우 인덱스 없이도 기존 경로가 동작하므로 무시.
  }

  // 4-1) message_usage (메시지별 토큰/지연 정보)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_character_roster (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      profile TEXT NOT NULL DEFAULT '',
      relationshipNote TEXT NOT NULL DEFAULT '',
      emotionNote TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(chatId, name)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_character_roster_chat ON chat_character_roster(chatId, enabled, updatedAt DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_character_turn_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId TEXT NOT NULL,
      rosterId TEXT NOT NULL,
      characterName TEXT NOT NULL DEFAULT '',
      turnNo INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(chatId, rosterId, turnNo)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_character_turn_memories_chat_roster ON chat_character_turn_memories(chatId, rosterId, turnNo)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_character_turn_memories_roster ON chat_character_turn_memories(rosterId)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_usage (
      messageId TEXT PRIMARY KEY,
      chatId TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
	      promptTokens INTEGER NOT NULL DEFAULT 0,
	      outputTokens INTEGER NOT NULL DEFAULT 0,
	      reasoningTokens INTEGER NOT NULL DEFAULT 0,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      estPromptTotal INTEGER NOT NULL DEFAULT 0,
      tokenBreakdown TEXT NOT NULL DEFAULT '',
      finishReason TEXT NOT NULL DEFAULT '',
      maxOutputTokensRequested INTEGER NOT NULL DEFAULT 0,
      maxOutputTokensForProvider INTEGER NOT NULL DEFAULT 0,
      effectiveMaxOutputTokens INTEGER NOT NULL DEFAULT 0,
      reasoningHeadroomTokens INTEGER NOT NULL DEFAULT 0,
      thinkingBudget INTEGER NOT NULL DEFAULT 0,
      thinkingLevel TEXT NOT NULL DEFAULT '',
      usageMetaJson TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
  `);

  // (성능) chat 삭제/조회 시 message_usage.chatId 풀스캔 방지.
  // 기존엔 messageId PRIMARY KEY만 있어 chatId WHERE 조회가 풀스캔이었음.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_message_usage_chat ON message_usage(chatId)`);


  // message_usage columns (추가)
  if (!hasColumn("message_usage", "estPromptTotal")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN estPromptTotal INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "reasoningTokens")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN reasoningTokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "tokenBreakdown")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN tokenBreakdown TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("message_usage", "finishReason")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN finishReason TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("message_usage", "maxOutputTokensRequested")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN maxOutputTokensRequested INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "maxOutputTokensForProvider")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN maxOutputTokensForProvider INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "effectiveMaxOutputTokens")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN effectiveMaxOutputTokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "reasoningHeadroomTokens")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN reasoningHeadroomTokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "thinkingBudget")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN thinkingBudget INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "thinkingLevel")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN thinkingLevel TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn("message_usage", "usageMetaJson")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN usageMetaJson TEXT NOT NULL DEFAULT '{}'`);
  }

  // (추가) 비용 추정용 컬럼
  if (!hasColumn("message_usage", "costUsd")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN costUsd REAL NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "costKrw")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN costKrw REAL NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("message_usage", "usdToKrw")) {
    db.exec(`ALTER TABLE message_usage ADD COLUMN usdToKrw REAL NOT NULL DEFAULT 0`);
  }

  // 4-2) chat_character_events (턴별 인물/행동/관계 변화 로그)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_character_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      turnNo INTEGER NOT NULL DEFAULT 0,
      sourceRole TEXT NOT NULL DEFAULT 'assistant',
      eventType TEXT NOT NULL DEFAULT 'action',
      actor TEXT NOT NULL DEFAULT 'unknown',
      target TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      confidence INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_character_events_chat_turn_created
      ON chat_character_events(chatId, turnNo, createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_character_events_message ON chat_character_events(messageId);
  `);

  // 5) user_profile (전 채팅 공통으로 쓰는 페르소나 기본값)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      personaName TEXT NOT NULL DEFAULT '',
      personaAge INTEGER NOT NULL DEFAULT 0,
      personaGender TEXT NOT NULL DEFAULT '',
      personaInfo TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    );
  `);

  // 6) persona_profiles (여러 개 저장/선택 가능한 페르소나)
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_profiles (
      id TEXT PRIMARY KEY,
      personaName TEXT NOT NULL DEFAULT '',
      personaAge INTEGER NOT NULL DEFAULT 0,
      personaGender TEXT NOT NULL DEFAULT '',
      personaInfo TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);

  // --- Preset social (views/likes/follows/comments) ---
  // NOTE: This is additive and safe to run multiple times.
  db.exec(`
    CREATE TABLE IF NOT EXISTS preset_stats (
      presetId TEXT PRIMARY KEY,
      views INTEGER NOT NULL DEFAULT 0,
      chatCountTotal INTEGER NOT NULL DEFAULT 0,
      likeCountTotal INTEGER NOT NULL DEFAULT 0,
      followCountTotal INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS preset_follows (
      presetId TEXT NOT NULL,
      userEmail TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (presetId, userEmail)
    );

    CREATE TABLE IF NOT EXISTS preset_likes (
      presetId TEXT NOT NULL,
      userEmail TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (presetId, userEmail)
    );

    CREATE TABLE IF NOT EXISTS preset_comments (
      id TEXT PRIMARY KEY,
      presetId TEXT NOT NULL,
      userEmail TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS preset_comment_likes (
      commentId TEXT NOT NULL,
      userEmail TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (commentId, userEmail)
    );

    CREATE INDEX IF NOT EXISTS idx_preset_comments_preset_createdAt ON preset_comments (presetId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_preset_follows_preset ON preset_follows (presetId);
    CREATE INDEX IF NOT EXISTS idx_preset_likes_preset ON preset_likes (presetId);
    CREATE INDEX IF NOT EXISTS idx_preset_comment_likes_comment ON preset_comment_likes (commentId);

    CREATE TABLE IF NOT EXISTS preset_like_ever (
      presetId TEXT NOT NULL,
      userEmail TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (presetId, userEmail)
    );

    CREATE TABLE IF NOT EXISTS preset_follow_ever (
      presetId TEXT NOT NULL,
      userEmail TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (presetId, userEmail)
    );

    CREATE INDEX IF NOT EXISTS idx_preset_like_ever_preset ON preset_like_ever (presetId);
    CREATE INDEX IF NOT EXISTS idx_preset_follow_ever_preset ON preset_follow_ever (presetId);
  `);

  if (!hasColumn("preset_stats", "chatCountTotal")) {
    db.exec(`ALTER TABLE preset_stats ADD COLUMN chatCountTotal INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("preset_stats", "likeCountTotal")) {
    db.exec(`ALTER TABLE preset_stats ADD COLUMN likeCountTotal INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn("preset_stats", "followCountTotal")) {
    db.exec(`ALTER TABLE preset_stats ADD COLUMN followCountTotal INTEGER NOT NULL DEFAULT 0`);
  }

  try {
    const now = Date.now();

    // 모든 preset에 대응되는 stats row 보장
    db.prepare(
      `INSERT INTO preset_stats (
        presetId, views, chatCountTotal, likeCountTotal, followCountTotal, createdAt, updatedAt
      )
      SELECT p.id, 0, 0, 0, 0, ?, ?
      FROM presets p
      WHERE NOT EXISTS (SELECT 1 FROM preset_stats s WHERE s.presetId = p.id)`
    ).run(now, now);

    // active 관계를 누적(unique-ever) 테이블에 1회 동기화
    db.exec(`
      INSERT OR IGNORE INTO preset_like_ever (presetId, userEmail, createdAt)
      SELECT presetId, userEmail, createdAt
      FROM preset_likes;

      INSERT OR IGNORE INTO preset_follow_ever (presetId, userEmail, createdAt)
      SELECT presetId, userEmail, createdAt
      FROM preset_follows;
    `);

    // 기존 데이터는 현재 값을 하한선으로 초기화하고, 이후에는 누적 증가만 유지
    db.exec(`
      UPDATE preset_stats
      SET
        chatCountTotal = MAX(
          chatCountTotal,
          COALESCE((SELECT COUNT(1) FROM chats c WHERE c.presetId = preset_stats.presetId), 0)
        ),
        likeCountTotal = MAX(
          likeCountTotal,
          COALESCE((SELECT COUNT(1) FROM preset_like_ever le WHERE le.presetId = preset_stats.presetId), 0)
        ),
        followCountTotal = MAX(
          followCountTotal,
          COALESCE((SELECT COUNT(1) FROM preset_follow_ever fe WHERE fe.presetId = preset_stats.presetId), 0)
        )
    `);
  } catch {
    // ignore
  }

  try {
    const now = Date.now();
    const localEmail = (
      process.env.LOCAL_USER_EMAIL ||
      "godhotyes@gmail.com"
    ).trim().toLowerCase() || "local@arca.local";

    const heal = db.transaction(() => {
      db.prepare(`UPDATE chats SET userEmail=? WHERE COALESCE(userEmail, '')=''`).run(localEmail);
      db.exec(`
        UPDATE messages
        SET userEmail = (SELECT c.userEmail FROM chats c WHERE c.id = messages.chatId)
        WHERE COALESCE(userEmail, '') = ''
          AND EXISTS (
            SELECT 1 FROM chats c
            WHERE c.id = messages.chatId
              AND COALESCE(c.userEmail, '') <> ''
          );

        UPDATE messages
        SET updatedAt = createdAt
        WHERE COALESCE(updatedAt, 0) = 0;

        DELETE FROM messages
        WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = messages.chatId);

        DELETE FROM message_usage
        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = message_usage.messageId)
           OR NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = message_usage.chatId);

        DELETE FROM chat_character_events
        WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = chat_character_events.chatId)
           OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = chat_character_events.messageId);

        DELETE FROM chat_memory_cache
        WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = chat_memory_cache.chatId);

        DELETE FROM chat_memory_blocks
        WHERE NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = chat_memory_blocks.chatId);

        INSERT OR IGNORE INTO chat_settings (
          chatId,
          personaName, personaAge, personaGender, personaInfo,
          memoryFrom, summaryEvery, summaryLength,
          userNote, model, maxOutputTokens, maxReasoningTokens, thinkingBudget,
          narrationColor, renderMode, longMemoryPerTurnChars, updatedAt
        )
        SELECT
          c.id,
          '', 0, '', '',
          7, 3, 80,
          '', 'gemini-2.5-pro', 1200, 384, 384,
          '#CCC7C7', 'novel', 80, ${now}
        FROM chats c
        WHERE NOT EXISTS (SELECT 1 FROM chat_settings s WHERE s.chatId = c.id);
      `);
    });

    heal();
  } catch {
    // Database health cleanup is best-effort; never block app startup.
  }



  // (호환) 기존 단일 user_profile이 있고 persona_profiles가 비어있으면 1개를 마이그레이션
  try {
    const cnt = db.prepare(`SELECT COUNT(1) AS c FROM persona_profiles`).get() as any;
    if (Number(cnt?.c || 0) === 0) {
      const row = db
        .prepare(`SELECT personaName, personaAge, personaGender, personaInfo, updatedAt FROM user_profile WHERE id=1`)
        .get() as any;
      if (row && (row.personaName || row.personaInfo)) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO persona_profiles (id, personaName, personaAge, personaGender, personaInfo, createdAt, updatedAt)
           VALUES (@id, @personaName, @personaAge, @personaGender, @personaInfo, @createdAt, @updatedAt)`
        ).run({
          id: `p_${now}`,
          personaName: row.personaName || "기본",
          personaAge: Number(row.personaAge || 0),
          personaGender: row.personaGender || "",
          personaInfo: row.personaInfo || "",
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  } catch {
    // ignore
  }
}

ensureTableAndMigrations();

function deleteChatDataRows(targetChatId: string) {
  db.prepare(`DELETE FROM message_usage WHERE chatId=?`).run(targetChatId);
  db.prepare(`DELETE FROM chat_character_events WHERE chatId=?`).run(targetChatId);
  db.prepare(`DELETE FROM messages WHERE chatId=?`).run(targetChatId);
  db.prepare(`DELETE FROM chat_settings WHERE chatId=?`).run(targetChatId);
  db.prepare(`DELETE FROM chat_memory_cache WHERE chatId=?`).run(targetChatId);
  db.prepare(`DELETE FROM chat_memory_blocks WHERE chatId=?`).run(targetChatId);
  db.prepare(`DELETE FROM chat_character_roster WHERE chatId=?`).run(targetChatId);
  db.prepare(`DELETE FROM chat_character_turn_memories WHERE chatId=?`).run(targetChatId);
}

export function deleteChatData(chatId: string) {
  const id = String(chatId || "").trim();
  if (!id) return;
  const run = db.transaction((targetChatId: string) => {
    deleteChatDataRows(targetChatId);
  });
  run(id);
}

export function deletePresetData(presetId: string, userEmail?: string) {
  const id = String(presetId || "").trim();
  if (!id) return;
  const owner = String(userEmail || "").trim();
  const run = db.transaction((targetPresetId: string, targetUserEmail: string) => {
    if (targetUserEmail) {
      const allowed = db.prepare(`SELECT 1 FROM presets WHERE id=? AND userEmail=?`).get(targetPresetId, targetUserEmail);
      if (!allowed) return;
    }

    const chats = db.prepare(`SELECT id FROM chats WHERE presetId=?`).all(targetPresetId) as Array<{ id: string }>;

    for (const c of chats) {
      const chatId = String(c?.id || "");
      if (chatId) deleteChatDataRows(chatId);
    }

    db.prepare(`DELETE FROM chats WHERE presetId=?`).run(targetPresetId);
    if (targetUserEmail) db.prepare(`DELETE FROM presets WHERE id=? AND userEmail=?`).run(targetPresetId, targetUserEmail);
    else db.prepare(`DELETE FROM presets WHERE id=?`).run(targetPresetId);

    db.prepare(`DELETE FROM preset_comment_likes WHERE commentId IN (SELECT id FROM preset_comments WHERE presetId=?)`).run(targetPresetId);
    db.prepare(`DELETE FROM preset_comments WHERE presetId=?`).run(targetPresetId);
    db.prepare(`DELETE FROM preset_likes WHERE presetId=?`).run(targetPresetId);
    db.prepare(`DELETE FROM preset_follows WHERE presetId=?`).run(targetPresetId);
    db.prepare(`DELETE FROM preset_like_ever WHERE presetId=?`).run(targetPresetId);
    db.prepare(`DELETE FROM preset_follow_ever WHERE presetId=?`).run(targetPresetId);
    db.prepare(`DELETE FROM preset_stats WHERE presetId=?`).run(targetPresetId);
  });
  run(id, owner);
}



export type DbUser = {
  email: string;
  name?: string | null;
  image?: string | null;
  nickname?: string | null;
};

export function getUserByEmail(email: string): DbUser | null {
  const row = db
    .prepare("SELECT email, name, image, nickname FROM users WHERE email = ?")
    .get(email) as DbUser | undefined;
  return row ?? null;
}

export function upsertUserByEmail(user: { email: string; name?: string; image?: string }): DbUser {
  db.prepare(
    `INSERT INTO users (email, name, image, nickname)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(email) DO UPDATE SET
       name=excluded.name,
       image=excluded.image,
       updated_at=datetime('now')`
  ).run(user.email, user.name ?? null, user.image ?? null);

  const saved = getUserByEmail(user.email);
  if (!saved) {
    return { email: user.email, name: user.name ?? null, image: user.image ?? null, nickname: null };
  }
  return saved;
}

export function setUserNicknameByEmail(email: string, nickname: string) {
  // Upsert so nickname persists even if the user row wasn't created yet
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (email, name, image, nickname, nickname_changed_at)
     VALUES (?, NULL, NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       nickname=excluded.nickname,
       nickname_changed_at=excluded.nickname_changed_at,
       updated_at=datetime('now')`
  ).run(email, nickname, now);
}

export function setUserImageByEmail(email: string, imageUrl: string) {
  db.prepare(
    `INSERT INTO users (email, name, image)
     VALUES (?, NULL, ?)
     ON CONFLICT(email) DO UPDATE SET
       image=excluded.image,
       updated_at=datetime('now')`
  ).run(email, imageUrl);
}

export function markUserDeletedByEmail(email: string) {
  db.prepare(`UPDATE users SET deleted_at = datetime('now'), is_banned = 1, updated_at = datetime('now') WHERE email = ?`).run(email);
}


// ------------------------------
// Preset social helpers
// ------------------------------

export type PresetMeta = {
  presetId: string;
  views: number;
  likeCount: number;
  followCount: number;
  chatCount: number;
  likedByMe: boolean;
  followedByMe: boolean;
};

export type PresetComment = {
  id: string;
  presetId: string;
  userEmail: string;
  userNickname?: string | null;
  userImage?: string | null;
  content: string;
  createdAt: number;
  likeCount: number;
  likedByMe: boolean;
};

function ensurePresetStatsRow(presetId: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO preset_stats (presetId, views, createdAt, updatedAt)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(presetId) DO NOTHING`
  ).run(presetId, now, now);
}

export function incrementPresetViews(presetId: string) {
  ensurePresetStatsRow(presetId);
  const now = Date.now();
  db.prepare(`UPDATE preset_stats SET views = views + 1, updatedAt = ? WHERE presetId = ?`).run(now, presetId);
}

export function incrementPresetChatCount(presetId: string) {
  ensurePresetStatsRow(presetId);
  const now = Date.now();
  db.prepare(`UPDATE preset_stats SET chatCountTotal = chatCountTotal + 1, updatedAt = ? WHERE presetId = ?`).run(now, presetId);
}

export function getPresetMeta(presetId: string, userEmail?: string | null): PresetMeta {
  ensurePresetStatsRow(presetId);

  const stats = db
    .prepare(
      `SELECT
         views,
         chatCountTotal,
         likeCountTotal,
         followCountTotal
       FROM preset_stats
       WHERE presetId = ?`
    )
    .get(presetId) as any;
  const views = Number(stats?.views || 0);
  const chatCount = Number(stats?.chatCountTotal || 0);
  const likeRow = db.prepare(`SELECT COUNT(1) AS c FROM preset_likes WHERE presetId = ?`).get(presetId) as any;
  const likeCount = Number(likeRow?.c || 0);
  const followRow = db.prepare(`SELECT COUNT(1) AS c FROM preset_follows WHERE presetId = ?`).get(presetId) as any;
  const followCount = Number(followRow?.c || 0);

  let likedByMe = false;
  let followedByMe = false;
  const email = (userEmail || "").trim();
  if (email) {
    const lr = db.prepare(`SELECT 1 FROM preset_likes WHERE presetId = ? AND userEmail = ?`).get(presetId, email);
    likedByMe = !!lr;
    const fr = db.prepare(`SELECT 1 FROM preset_follows WHERE presetId = ? AND userEmail = ?`).get(presetId, email);
    followedByMe = !!fr;
  }

  return { presetId, views, likeCount, followCount, chatCount, likedByMe, followedByMe };
}

export function getPresetCreator(presetId: string): {
  email: string | null;
  nickname: string | null;
  name: string | null;
  image: string | null;
} {
  const row = db.prepare(`SELECT ownerEmail FROM presets WHERE id = ?`).get(presetId) as any;
  const email = String(row?.ownerEmail || "").trim();
  if (!email) return { email: null, nickname: null, name: null, image: null };

  const u = getUserByEmail(email);
  return {
    email,
    nickname: u?.nickname ? String(u.nickname) : null,
    name: u?.name ? String(u.name) : null,
    image: u?.image ? String(u.image) : null,
  };
}

export function togglePresetLike(presetId: string, userEmail: string) {
  const email = (userEmail || "").trim();
  if (!email) throw new Error("userEmail required");
  const now = Date.now();
  ensurePresetStatsRow(presetId);

  const exists = db.prepare(`SELECT 1 FROM preset_likes WHERE presetId = ? AND userEmail = ?`).get(presetId, email);
  if (exists) {
    db.prepare(`DELETE FROM preset_likes WHERE presetId = ? AND userEmail = ?`).run(presetId, email);
  } else {
    db.prepare(`INSERT INTO preset_likes (presetId, userEmail, createdAt) VALUES (?, ?, ?)`).run(presetId, email, now);
    const ins = db
      .prepare(`INSERT OR IGNORE INTO preset_like_ever (presetId, userEmail, createdAt) VALUES (?, ?, ?)`)
      .run(presetId, email, now);
    if (Number(ins?.changes || 0) > 0) {
      db.prepare(`UPDATE preset_stats SET likeCountTotal = likeCountTotal + 1, updatedAt = ? WHERE presetId = ?`).run(now, presetId);
    }
  }

  const likeRow = db.prepare(`SELECT COUNT(1) AS c FROM preset_likes WHERE presetId = ?`).get(presetId) as any;
  const likeCount = Number(likeRow?.c || 0);
  const likedByMe = !exists;
  return { likeCount, likedByMe };
}

export function togglePresetFollow(presetId: string, userEmail: string) {
  const email = (userEmail || "").trim();
  if (!email) throw new Error("userEmail required");
  const now = Date.now();
  ensurePresetStatsRow(presetId);

  const exists = db.prepare(`SELECT 1 FROM preset_follows WHERE presetId = ? AND userEmail = ?`).get(presetId, email);
  if (exists) {
    db.prepare(`DELETE FROM preset_follows WHERE presetId = ? AND userEmail = ?`).run(presetId, email);
  } else {
    db.prepare(`INSERT INTO preset_follows (presetId, userEmail, createdAt) VALUES (?, ?, ?)`).run(presetId, email, now);
    const ins = db
      .prepare(`INSERT OR IGNORE INTO preset_follow_ever (presetId, userEmail, createdAt) VALUES (?, ?, ?)`)
      .run(presetId, email, now);
    if (Number(ins?.changes || 0) > 0) {
      db.prepare(`UPDATE preset_stats SET followCountTotal = followCountTotal + 1, updatedAt = ? WHERE presetId = ?`).run(now, presetId);
    }
  }

  const followRow = db.prepare(`SELECT COUNT(1) AS c FROM preset_follows WHERE presetId = ?`).get(presetId) as any;
  const followCount = Number(followRow?.c || 0);
  const followedByMe = !exists;
  return { followCount, followedByMe };
}

export function listPresetComments(presetId: string, userEmail?: string | null, limit = 50): PresetComment[] {
  const email = (userEmail || "").trim();
  const rows = db
    .prepare(
      `SELECT c.id, c.presetId, c.userEmail, c.content, c.createdAt,
              (SELECT COUNT(1) FROM preset_comment_likes l WHERE l.commentId = c.id) AS likeCount,
              (SELECT 1 FROM preset_comment_likes l2 WHERE l2.commentId = c.id AND l2.userEmail = ?) AS likedByMe
       FROM preset_comments c
       WHERE c.presetId = ?
       ORDER BY c.createdAt DESC
       LIMIT ?`
    )
    .all(email, presetId, limit) as any[];

  return rows.map((r) => ({
    id: String(r.id),
    presetId: String(r.presetId),
    userEmail: String(r.userEmail),
    content: String(r.content),
    createdAt: Number(r.createdAt || 0),
    likeCount: Number(r.likeCount || 0),
    likedByMe: !!r.likedByMe,
  }));
}

export function addPresetComment(presetId: string, userEmail: string, content: string): PresetComment {
  const email = (userEmail || "").trim();
  if (!email) throw new Error("userEmail required");
  const text = String(content || "").trim();
  if (!text) throw new Error("content required");
  const id = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const now = Date.now();

  db.prepare(`INSERT INTO preset_comments (id, presetId, userEmail, content, createdAt) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    presetId,
    email,
    text,
    now
  );

  return { id, presetId, userEmail: email, content: text, createdAt: now, likeCount: 0, likedByMe: false };
}

export function toggleCommentLike(commentId: string, userEmail: string) {
  const email = (userEmail || "").trim();
  if (!email) throw new Error("userEmail required");
  const now = Date.now();

  const exists = db.prepare(`SELECT 1 FROM preset_comment_likes WHERE commentId = ? AND userEmail = ?`).get(commentId, email);
  if (exists) {
    db.prepare(`DELETE FROM preset_comment_likes WHERE commentId = ? AND userEmail = ?`).run(commentId, email);
  } else {
    db.prepare(`INSERT INTO preset_comment_likes (commentId, userEmail, createdAt) VALUES (?, ?, ?)`).run(commentId, email, now);
  }

  const row = db.prepare(`SELECT COUNT(1) AS c FROM preset_comment_likes WHERE commentId = ?`).get(commentId) as any;
  return { likeCount: Number(row?.c || 0), likedByMe: !exists };
}
