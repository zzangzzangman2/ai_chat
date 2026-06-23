export function labelTokenKey(k: string) {
  const map: Record<string, string> = {
    presetPrompt: "캐릭터 프롬프트",
    lorebookPrompt: "활성화 로어북",
    persona: "유저 페르소나",
    userNote: "유저 노트",
    longMemorySummary: "장기 기억",
    recentTurns: "최근 대화",
    systemAndRules: "시스템/규칙",
    userInput: "사용자 입력",
    imagePrompt: "이미지 프롬프트",
    other: "기타",
  };
  return map[k] || k;
}
