import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const FONT = "Arial";

function hebrewParagraph(text, { size = 26, bold = false } = {}) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.START,
    spacing: { after: 120 },
    children: [
      new TextRun({ text, rightToLeft: true, font: { name: FONT, hint: "cs" }, size, sizeComplexScript: size, bold, boldComplexScript: bold }),
    ],
  });
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

const noBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};

/**
 * @param {{title?: string, pages: {heading?: string, lines: {text: string, image?: string, width?: number, height?: number}[]}[], withImages?: boolean}} input
 */
export async function buildDocx({ title, pages, withImages }) {
  const children = [];
  if (title) children.push(hebrewParagraph(title, { size: 36, bold: true }));

  pages.forEach((page) => {
    // The heading ("Page 2" / "עמוד 2") comes from the browser, in the interface language.
    if (typeof page.heading === "string" && page.heading) {
      children.push(hebrewParagraph(page.heading.slice(0, 100), { size: 22, bold: true }));
    }
    if (!withImages) {
      for (const line of page.lines) children.push(hebrewParagraph(line.text));
      return;
    }
    const rows = page.lines.map((line) => {
      const imageCell = [];
      if (line.image) {
        const maxW = 300;
        const w = line.width || maxW;
        const h = line.height || 60;
        const scale = Math.min(1, maxW / w);
        imageCell.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: "jpg",
                data: dataUrlToBuffer(line.image),
                transformation: { width: Math.round(w * scale), height: Math.round(h * scale) },
              }),
            ],
          })
        );
      } else {
        imageCell.push(new Paragraph(""));
      }
      return new TableRow({
        children: [
          new TableCell({ borders: noBorders, width: { size: 50, type: WidthType.PERCENTAGE }, children: [hebrewParagraph(line.text)] }),
          new TableCell({ borders: noBorders, width: { size: 50, type: WidthType.PERCENTAGE }, children: imageCell }),
        ],
      });
    });
    if (rows.length) {
      children.push(
        new Table({ visuallyRightToLeft: true, width: { size: 100, type: WidthType.PERCENTAGE }, rows })
      );
    }
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, rightToLeft: true } } } },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}
