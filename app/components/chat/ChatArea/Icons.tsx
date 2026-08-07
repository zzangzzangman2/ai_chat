"use client";

// lucide-react를 설치하지 않은 환경에서도 동작하도록, 필요한 아이콘은 인라인 SVG로 렌더링한다.

export function Icon({
  name,
  size = 16,
}: {
  // 기존 코드에서 "refresh"라는 이름으로 호출되는 케이스가 있어 alias를 함께 허용한다.
  name: "rotate" | "refresh" | "edit" | "trash" | "info" | "check" | "close" | "chevronLeft" | "paperPlane" | "chevronDown" | "asterisk" | "sparkles" | "narration" | "magic" | "stop";
  size?: number;
}) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", xmlns: "http://www.w3.org/2000/svg" } as const;
  switch (name) {
    case "rotate":
    case "refresh":
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 0 1 15.3-6.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M18 3v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M21 12a9 9 0 0 1-15.3 6.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M6 21v-5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M12 20h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M3 6h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M8 6V4h8v2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M6 6l1 14h10l1-14" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M10 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "chevronLeft":
      return (
        <svg {...common}>
          <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "chevronDown":
      return (
        <svg {...common}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "paperPlane":
      return (
        <svg {...common}>
          <path d="M22 2 11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M22 2 15 22l-4-9-9-4 20-7Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </svg>
      );

    case "asterisk":
      return (
        <svg {...common}>
          <path d="M12 2v20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M4 6l16 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 6L4 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...common}>
          <path d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M4 14l.9 2.6L7.5 18l-2.6.9L4 21l-.9-2.1L.5 18l2.6-1.4L4 14Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );

    case "narration":
      // A scroll-like icon ("narration" feel)
      return (
        <svg {...common}>
          <path d="M7 4h10a3 3 0 0 1 0 6H8a2 2 0 0 0 0 4h9a3 3 0 0 1 0 6H7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 8h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M8 16h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );

    case "magic":
      // A wand + sparkle
      return (
        <svg {...common}>
          <path d="M3 21l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M8 16l8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 6l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M14.5 3.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );


    case "info":
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
          <path d="M12 10v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 7h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      );
  }
}

export function SettingsIcon({
  name,
  size = 18,
}: {
  name: "persona" | "note" | "memory" | "relations" | "sliders" | "pencil" | "chevronLeft";
  size?: number;
}) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", xmlns: "http://www.w3.org/2000/svg" } as const;
  switch (name) {
    case "persona":
      return (
        <svg {...common}>
          <path d="M20 21a8 8 0 0 0-16 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case "note":
      return (
        <svg {...common}>
          <path d="M7 3h10a2 2 0 0 1 2 2v14l-4-2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M9 7h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M9 11h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "memory":
      return (
        <svg {...common}>
          <path d="M4 7c0-2 4-4 8-4s8 2 8 4-4 4-8 4-8-2-8-4Z" stroke="currentColor" strokeWidth="2" />
          <path d="M4 7v10c0 2 4 4 8 4s8-2 8-4V7" stroke="currentColor" strokeWidth="2" />
          <path d="M4 12c0 2 4 4 8 4s8-2 8-4" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case "relations":
      return (
        <svg {...common}>
          <circle cx="6" cy="7" r="3" stroke="currentColor" strokeWidth="2" />
          <circle cx="18" cy="7" r="3" stroke="currentColor" strokeWidth="2" />
          <circle cx="12" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
          <path d="M8.7 8.4 10.8 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="m15.3 8.4-2.1 6.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M9 7h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "sliders":
      return (
        <svg {...common}>
          <path d="M4 21v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M4 10V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 21v-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 8V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 21v-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 12V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M2 14h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M10 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M18 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...common}>
          <path d="M12 20h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case "chevronLeft":
    default:
      return (
        <svg {...common}>
          <path d="M15 18 9 12l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
