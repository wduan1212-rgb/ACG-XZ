import { buildZipBlob } from "../core/util.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const encoder = new TextEncoder();

function xml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function shanghaiParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Number(timestamp) || Date.now()));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

export function supplierReturnDayKey(asset = {}) {
  const timestamp = Number(asset.publishedUpdatedAt || asset.publishedAt || 0);
  if (!timestamp) return "";
  const value = shanghaiParts(timestamp);
  return `${value.year}-${value.month}-${value.day}`;
}

function excelDateSerial(timestamp) {
  const value = shanghaiParts(timestamp);
  const wallClock = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second),
  );
  return wallClock / 86400000 + 25569;
}

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
}

export function collectDeliveryReturnRows(items = [], { start = "", end = "" } = {}) {
  const from = String(start || "").trim();
  const to = String(end || "").trim();
  if (!DAY_KEY_PATTERN.test(from) || !DAY_KEY_PATTERN.test(to)) {
    throw new Error("请选择完整的导出开始和结束日期");
  }
  if (from > to) throw new Error("导出开始日期不能晚于结束日期");
  return (items || []).flatMap(item => {
    const asset = item?.asset || item || {};
    const returnedAt = Number(asset.publishedUpdatedAt || asset.publishedAt || 0);
    const returnedDay = supplierReturnDayKey(asset);
    const publishedUrl = cleanText(asset.publishedUrl);
    if (!publishedUrl || !returnedAt || returnedDay < from || returnedDay > to) return [];
    const account = item?.acc || item?.account || {};
    return [{
      title: cleanText(asset.title || asset.name, "未命名内容"),
      account: cleanText(account.name || asset.byAccount, "未命名账号"),
      publishedUrl,
      viewCount: Math.max(0, Math.trunc(Number(asset.viewCount || 0))),
      returnedAt,
      publisher: cleanText(item?.publisher || asset.byMemberName, "未记录"),
      platform: cleanText(account.platform || asset.platform, "未记录"),
    }];
  }).sort((a, b) => b.returnedAt - a.returnedAt);
}

function inlineCell(ref, value, style = 0) {
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function numberCell(ref, value, style = 0) {
  return `<c r="${ref}" s="${style}"><v>${Number(value) || 0}</v></c>`;
}

function workbookEntries(rows, { start, end, generatedAt }) {
  const headers = ["序号", "标题", "账号", "回传链接", "观看量", "回传时间", "发布人", "平台"];
  const headerCells = headers.map((value, index) => inlineCell(`${String.fromCharCode(65 + index)}4`, value, 1)).join("");
  const hyperlinks = [];
  const relationships = [];
  const dataRows = rows.map((row, index) => {
    const rowNumber = index + 5;
    const relationId = `rId${index + 1}`;
    hyperlinks.push(`<hyperlink ref="D${rowNumber}" r:id="${relationId}" display="${xml(row.publishedUrl)}"/>`);
    relationships.push(`<Relationship Id="${relationId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(row.publishedUrl)}" TargetMode="External"/>`);
    return `<row r="${rowNumber}">${[
      numberCell(`A${rowNumber}`, index + 1),
      inlineCell(`B${rowNumber}`, row.title),
      inlineCell(`C${rowNumber}`, row.account),
      inlineCell(`D${rowNumber}`, row.publishedUrl, 5),
      numberCell(`E${rowNumber}`, row.viewCount, 6),
      numberCell(`F${rowNumber}`, excelDateSerial(row.returnedAt), 2),
      inlineCell(`G${rowNumber}`, row.publisher),
      inlineCell(`H${rowNumber}`, row.platform),
    ].join("")}</row>`;
  }).join("");
  const lastRow = Math.max(4, rows.length + 4);
  const generated = shanghaiParts(generatedAt);
  const generatedLabel = `${generated.year}-${generated.month}-${generated.day} ${generated.hour}:${generated.minute}`;
  const sheetXml = `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="24" customWidth="1"/><col min="4" max="4" width="54" customWidth="1"/><col min="5" max="5" width="14" customWidth="1"/><col min="6" max="6" width="21" customWidth="1"/><col min="7" max="7" width="18" customWidth="1"/><col min="8" max="8" width="14" customWidth="1"/></cols><sheetData><row r="1" ht="30" customHeight="1">${inlineCell("A1", "发布回传明细", 3)}</row><row r="2" ht="22" customHeight="1">${inlineCell("A2", `回传日期：${start} 至 ${end}　·　共 ${rows.length} 条　·　导出时间：${generatedLabel}`, 4)}</row><row r="3" ht="8" customHeight="1"/><row r="4" ht="24" customHeight="1">${headerCells}</row>${dataRows}</sheetData><autoFilter ref="A4:H${lastRow}"/><mergeCells count="2"><mergeCell ref="A1:H1"/><mergeCell ref="A2:H2"/></mergeCells>${hyperlinks.length ? `<hyperlinks>${hyperlinks.join("")}</hyperlinks>` : ""}<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  const stylesXml = `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FF17365D"/><sz val="18"/><name val="Aptos Display"/></font><font><color rgb="FF0563C1"/><u/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9E2F3"/></left><right style="thin"><color rgb="FFD9E2F3"/></right><top style="thin"><color rgb="FFD9E2F3"/></top><bottom style="thin"><color rgb="FFD9E2F3"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbookXml = `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews><sheets><sheet name="发布回传明细" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`;
  return [
    ["[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ["_rels/.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ["docProps/core.xml", `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>发布回传明细</dc:title><dc:creator>ACG-XZ</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date(generatedAt).toISOString()}</dcterms:created></cp:coreProperties>`],
    ["docProps/app.xml", `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>ACG-XZ</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><AppVersion>143.4</AppVersion></Properties>`],
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", stylesXml],
    ["xl/worksheets/sheet1.xml", sheetXml],
    ["xl/worksheets/_rels/sheet1.xml.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>`],
  ].map(([name, content]) => ({ name, u8: encoder.encode(content) }));
}

export function buildDeliveryReturnWorkbook(rows = [], { start, end, generatedAt = Date.now() } = {}) {
  if (!DAY_KEY_PATTERN.test(String(start || "")) || !DAY_KEY_PATTERN.test(String(end || ""))) {
    throw new Error("导出日期范围不完整");
  }
  const entries = workbookEntries(rows, { start, end, generatedAt });
  return buildZipBlob(entries, XLSX_MIME);
}

export function deliveryReturnWorkbookName(start, end) {
  return `发布回传明细_${start}_${end}.xlsx`;
}
