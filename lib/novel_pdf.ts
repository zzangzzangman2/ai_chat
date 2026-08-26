import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import type { NovelChapter } from "@/lib/novel_export";

export type NovelPdfInput = {
  title: string;
  subtitle?: string;
  author?: string;
  chapters: NovelChapter[];
  generatedAt?: Date;
};

function findFont(candidates: string[]) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}

export function resolveNovelPdfFonts() {
  const regular = findFont([
    String(process.env.NOVEL_PDF_FONT || ""),
    path.join(process.cwd(), "assets", "fonts", "NotoSansKR-Regular.ttf"),
    "C:\\Windows\\Fonts\\malgun.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
  ]);
  const bold = findFont([
    String(process.env.NOVEL_PDF_FONT_BOLD || ""),
    path.join(process.cwd(), "assets", "fonts", "NotoSansKR-Bold.ttf"),
    "C:\\Windows\\Fonts\\malgunbd.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    regular,
  ]);
  if (!regular) {
    throw new Error(
      "한국어 PDF 글꼴을 찾지 못했습니다. NOVEL_PDF_FONT에 한글 TTF/TTC 경로를 설정해 주세요."
    );
  }
  return { regular, bold: bold || regular };
}

function normalizePdfText(value: unknown) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u2011/g, "-")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function addChapterBody(doc: PDFKit.PDFDocument, bodyRaw: string) {
  const body = normalizePdfText(bodyRaw);
  const paragraphs = body.split(/\n\s*\n/g).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const isDialogue = /^["“‘']/u.test(paragraph);
    doc
      .font("NovelRegular")
      .fontSize(10.4)
      .fillColor("#242424")
      .text(paragraph, {
        align: "left",
        indent: isDialogue ? 0 : 12,
        lineGap: 4.4,
        paragraphGap: 9,
        wordSpacing: 0,
      });
  }
}

export async function buildNovelPdf(input: NovelPdfInput) {
  const fonts = resolveNovelPdfFonts();
  const title = normalizePdfText(input.title) || "소설";
  const generatedAt = input.generatedAt || new Date();
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({
    size: "A5",
    margins: { top: 50, right: 44, bottom: 50, left: 44 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: title,
      Author: normalizePdfText(input.author) || "ARCA 로컬 소설 제작기",
      Subject: "채팅 원문을 바탕으로 재구성한 한국 웹소설",
      Creator: "ARCA Local Novel Export",
      CreationDate: generatedAt,
    },
  });
  doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });

  doc.registerFont("NovelRegular", fonts.regular);
  doc.registerFont("NovelBold", fonts.bold);

  // Cover
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#f5f0e7");
  doc
    .fillColor("#24211d")
    .font("NovelBold")
    .fontSize(25)
    .text(title, 46, 170, { width: doc.page.width - 92, align: "center", lineGap: 7 });
  if (input.subtitle) {
    doc
      .moveDown(1.2)
      .font("NovelRegular")
      .fontSize(10)
      .fillColor("#6e665c")
      .text(normalizePdfText(input.subtitle), { align: "center" });
  }
  doc
    .font("NovelRegular")
    .fontSize(8.5)
    .fillColor("#81786d")
    .text(
      `${generatedAt.getFullYear()}.${String(generatedAt.getMonth() + 1).padStart(2, "0")}.${String(generatedAt.getDate()).padStart(2, "0")}`,
      46,
      doc.page.height - 84,
      { width: doc.page.width - 92, align: "center" }
    );

  // Contents
  doc.addPage();
  doc.font("NovelBold").fontSize(18).fillColor("#24211d").text("차례", { align: "center" });
  doc.moveDown(1.4);
  for (const chapter of input.chapters) {
    doc
      .font("NovelRegular")
      .fontSize(10)
      .fillColor("#3c3833")
      .text(chapter.title, { paragraphGap: 7 });
  }

  for (const chapter of input.chapters) {
    doc.addPage();
    doc
      .font("NovelBold")
      .fontSize(17)
      .fillColor("#24211d")
      .text(normalizePdfText(chapter.title), { align: "center", lineGap: 5 });
    doc
      .moveDown(0.7)
      .font("NovelRegular")
      .fontSize(7.5)
      .fillColor("#8a8177")
      .text(`원문 ${chapter.startTurn}-${chapter.endTurn}턴`, { align: "center" });
    doc.moveDown(1.8);
    addChapterBody(doc, chapter.body);
  }

  const range = doc.bufferedPageRange();
  for (let pageIndex = 1; pageIndex < range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    const originalBottomMargin = doc.page.margins.bottom;
    // PDFKit은 여백 아래에 text()를 그리면 새 페이지를 만들 수 있다.
    // 머리말/쪽번호를 그리는 동안만 하단 여백 제한을 해제한다.
    doc.page.margins.bottom = 0;
    doc
      .font("NovelRegular")
      .fontSize(7)
      .fillColor("#92897f")
      .text(title, 44, 22, { width: doc.page.width - 88, align: "center", lineBreak: false });
    doc
      .font("NovelRegular")
      .fontSize(7.5)
      .fillColor("#92897f")
      .text(String(pageIndex), 44, doc.page.height - 28, {
        width: doc.page.width - 88,
        align: "center",
        lineBreak: false,
      });
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
  return done;
}
