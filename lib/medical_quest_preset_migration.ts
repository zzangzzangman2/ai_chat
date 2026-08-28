import type BetterSqlite3 from "better-sqlite3";
import {
  ABILITY_VIEW_QUICK_COMMAND_MARKER,
  EVENT_ONLY_META_POLICY_MARKER,
} from "./meta_panel_policy";

export const MEDICAL_QUEST_PRESET_ID = "22306dda-b854-4bd6-8514-fb83a8fc1dd2";

const OUTPUT_POLICY = `[출력 형식]
- 지문은 *별표 안에* 쓴다.
- 대사는 "큰따옴표"로 쓴다. 이름표를 대사 앞에 반복하지 말고 행동과 말투로 화자를 알 수 있게 한다.
- 본문 안에 원문 범위, 전체 채팅 수, 출처, 창작물 시뮬레이션 같은 제작 메타 문구를 넣지 않는다.
- 장면 제목이나 화수 제목을 매 응답마다 붙이지 않는다.

[${EVENT_ONLY_META_POLICY_MARKER}]
[${ABILITY_VIEW_QUICK_COMMAND_MARKER}]
- 변화 없는 일반 대화, 일상 행동, 단순 관찰에는 날짜·장소·현재 인물·단서·일정·관계·플레이어 정보를 붙이지 않는다. 서사 본문만 출력한다.
- 새 퀘스트가 실제로 발동한 순간, 중요한 단계가 완료된 순간, 퀘스트가 완료·보류·실패한 순간에만 짧은 퀘스트 패널을 정확히 한 번 표시한다. 사소한 단서 추가나 매 턴의 진행도 갱신에는 패널을 띄우지 않는다.
- 퀘스트 패널은 \`QUEST\` 라벨의 fenced 코드블록 하나로 출력한다. 내용은 UI가 읽을 JSON 객체이며 widget은 quest, id·category·title·desc·objectives·rewards만 사용한다. 현재 인물 목록, 날짜·장소, 반복 단서, 숨은 조건, 장문의 가설 목록은 넣지 않는다.
- 퀘스트 이벤트가 아닌 짧은 시스템 반응이 꼭 필요하면 본문 속 한 문장 알림만 사용하고 별도 패널을 만들지 않는다.
- 사용자가 정확히 '능력치 보기', '스탯 보기', '내 능력치'처럼 요청하면 서사를 진행하지 않고 \`ABILITY\` 라벨의 fenced 코드블록 하나만 출력한다. 박성준의 레벨·EXP·SP·집중력, 관찰·학습·추론·문진·연구·협업, 보유 스킬만 간결하게 표시한다.
- 사용자가 능력치 보기를 요청하지 않은 일반 턴에는 능력치와 스킬 목록을 출력하지 않는다. 확인되지 않은 수치나 해금 조건을 새로 만들지 않는다.`;

const COMPACT_QUEST_CARD = [
  "```QUEST",
  JSON.stringify(
    {
      widget: "quest",
      id: "CASE-D-TUTORIAL-01",
      category: "사건 퀘스트 · D",
      title: "무대가 숨긴 근력 저하",
      desc: "반복되는 이상 신호가 단순 과로인지 확인하고, 필요하면 보호자와 의료진에게 연결하라.",
      objectives: [
        { text: "확인 가능한 사실 3개 확보", progress: [1, 3] },
        { text: "당사자의 동의를 먼저 얻기" },
      ],
      rewards: [{ label: "EXP 40~90" }, { label: "SP 1" }],
      actions: [{ key: "accept", label: "퀘스트 확인" }],
    },
    null,
    2
  ),
  "```",
].join("\n");

export function stripLegacyInfoPanels(text: string): string {
  return String(text || "")
    .replace(/\n*```\s*INFO\b[\s\S]*?```\s*/giu, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function rewriteMedicalQuestSystemPrompt(systemPrompt: string): string {
  let source = String(systemPrompt || "").trim();
  if (source.includes(EVENT_ONLY_META_POLICY_MARKER)) return source;

  source = source.replace(
    /퀘스트 창에는 종류와 난도[^\n]*예상 보상을 간결하게 표시한다\./u,
    "퀘스트 창은 새 퀘스트 발동, 중요한 단계 완료, 완료·보류·실패 때만 표시하며 제목, 핵심 목표, 진행도, 보상만 간결하게 표시한다. 일반 단서 발견이나 평범한 대화에는 표시하지 않는다."
  );

  const outputHeading = source.indexOf("[출력 형식]");
  if (outputHeading >= 0) {
    source = `${source.slice(0, outputHeading).trimEnd()}\n\n${OUTPUT_POLICY}`;
  } else {
    source = `${source}\n\n${OUTPUT_POLICY}`;
  }
  return source.trim();
}

export function rewriteMedicalQuestLorebooks(lorebooksJson: string): string {
  try {
    const books = JSON.parse(String(lorebooksJson || "[]"));
    if (!Array.isArray(books)) return lorebooksJson;

    for (const book of books) {
      const name = String(book?.name || "");
      if (name === "게임 시스템―퀘스트 엔진") {
        book.content = String(book.content || "")
          .replace(/\n*퀘스트 창 형식:[\s\S]*?히든 조건과 내부 정답은 달성 전까지 표시하지 않는다\.?/u, "")
          .trimEnd();
        book.content +=
          "\n\n표시 정책: 퀘스트 패널은 새 발동, 중요한 단계 완료, 최종 결과 때만 짧게 표시한다. 일반 대화와 사소한 단서 갱신에는 표시하지 않는다. 제목, 핵심 목표, 진행도, 보상만 남기고 날짜·장소·현재 인물·반복 단서는 넣지 않는다.";
      }
      if (name === "게임 시스템―스킬·업적·전직") {
        const keys = Array.isArray(book.activationKeys) ? book.activationKeys.map(String) : [];
        book.activationKeys = Array.from(
          new Set([...keys.filter((key: string) => key !== "상태창"), "능력치 보기", "스탯 보기"])
        );
        const content = String(book.content || "").trimEnd();
        if (!content.includes("능력치 보기 요청")) {
          book.content =
            content +
            "\n\n능력치 보기 요청: 사용자가 능력치나 스탯 보기를 직접 요청했을 때만 현재 레벨·EXP·SP·집중력, 6개 능력치, 보유 스킬을 간결하게 보여 준다. 이 요청에는 서사를 진행하지 않는다.";
        }
      }
    }
    return JSON.stringify(books);
  } catch {
    return lorebooksJson;
  }
}

export function rewriteMedicalQuestOpening(text: string): string {
  let source = String(text || "");
  let replacedFirst = false;
  source = source.replace(/```\s*INFO\b[\s\S]*?```/iu, () => {
    replacedFirst = true;
    return COMPACT_QUEST_CARD;
  });
  if (!replacedFirst) return source.trim();

  source = stripLegacyInfoPanels(source)
    .replace("*창은 사라지지 않았다.*", "*짧은 퀘스트 창은 시야 한구석으로 접혔다.*")
    .replace(/\n{3,}/g, "\n\n");
  return source.trim();
}

export function rewriteMedicalQuestFirstMessages(firstMessagesJson: string): string {
  try {
    const rows = JSON.parse(String(firstMessagesJson || "[]"));
    if (!Array.isArray(rows)) return firstMessagesJson;
    for (const row of rows) {
      if (row && typeof row === "object" && typeof row.text === "string") {
        row.text = rewriteMedicalQuestOpening(row.text);
      }
    }
    return JSON.stringify(rows);
  } catch {
    return firstMessagesJson;
  }
}

export function applyMedicalQuestPresetUiMigration(db: BetterSqlite3.Database): {
  applied: boolean;
  messagesUpdated: number;
} {
  const row = db
    .prepare("SELECT systemPrompt, lorebooks, firstMessages FROM presets WHERE id=?")
    .get(MEDICAL_QUEST_PRESET_ID) as
    | { systemPrompt?: string; lorebooks?: string; firstMessages?: string }
    | undefined;
  if (!row || String(row.systemPrompt || "").includes(EVENT_ONLY_META_POLICY_MARKER)) {
    return { applied: false, messagesUpdated: 0 };
  }

  const chats = db
    .prepare("SELECT id FROM chats WHERE presetId=?")
    .all(MEDICAL_QUEST_PRESET_ID) as Array<{ id?: string }>;
  const chatIds = new Set(chats.map((chat) => String(chat.id || "")).filter(Boolean));
  const messages = chatIds.size
    ? (db
        .prepare(
          "SELECT id, chatId, content FROM messages WHERE role IN ('assistant','model') AND chatId IN (SELECT id FROM chats WHERE presetId=?)"
        )
        .all(MEDICAL_QUEST_PRESET_ID) as Array<{ id?: string; chatId?: string; content?: string }>)
    : [];

  let messagesUpdated = 0;
  db.transaction(() => {
    db.prepare("UPDATE presets SET systemPrompt=?, lorebooks=?, firstMessages=? WHERE id=?").run(
      rewriteMedicalQuestSystemPrompt(String(row.systemPrompt || "")),
      rewriteMedicalQuestLorebooks(String(row.lorebooks || "[]")),
      rewriteMedicalQuestFirstMessages(String(row.firstMessages || "[]")),
      MEDICAL_QUEST_PRESET_ID
    );

    const updateMessage = db.prepare("UPDATE messages SET content=?, updatedAt=? WHERE id=?");
    for (const message of messages) {
      const id = String(message.id || "");
      const content = String(message.content || "");
      if (!id || !content) continue;
      const next = content.includes("[의학적 오류 수정 시스템 최초 연결]")
        ? rewriteMedicalQuestOpening(content)
        : stripLegacyInfoPanels(content);
      if (next === content) continue;
      updateMessage.run(next, Date.now(), id);
      messagesUpdated += 1;
    }
  })();

  return { applied: true, messagesUpdated };
}
