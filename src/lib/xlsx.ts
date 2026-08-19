import ExcelJS from "exceljs";

import type { Extraction } from "./validation";

const UNCLEAR = "UNCLEAR";

/**
 * Builds the workbook in memory and hands back the bytes.
 *
 * Nothing here touches the filesystem: the buffer goes straight into the HTTP
 * response and is released when the request ends. There is no temp file to
 * forget to delete, which is the point.
 */
export async function buildWorkbook(extraction: Extraction): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  // Deliberately no creator/company metadata — the file should not carry the
  // account that produced it into whatever the user forwards it to.

  const sheet = workbook.addWorksheet("Registrations", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  // "Page" is prepended so an UNCLEAR cell can be traced back to a specific
  // sheet of paper and checked by hand. Without it, a flagged cell is a dead
  // end and the flag is much less useful.
  const headers = ["Page", ...extraction.columns];

  sheet.columns = headers.map((header) => ({
    header,
    width: header === "Page" ? 6 : Math.min(Math.max(header.length + 4, 14), 40),
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.border = { bottom: { style: "thin" } };

  for (const row of extraction.rows) {
    const added = sheet.addRow([row.page, ...row.values]);

    // Bold rather than red, per the palette: weight carries the signal, so the
    // file stays readable when printed in black and white and does not depend
    // on the reader distinguishing colours.
    added.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value === UNCLEAR) cell.font = { bold: true };
    });
  }

  // Widen any column whose content outgrew the header-based guess, so nothing
  // arrives as ####.
  sheet.columns.forEach((column, index) => {
    if (index === 0) return;
    let longest = headers[index]?.length ?? 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const length = String(cell.value ?? "").length;
      if (length > longest) longest = length;
    });
    column.width = Math.min(Math.max(longest + 3, 14), 50);
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
