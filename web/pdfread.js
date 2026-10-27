/* ============================================================
 * PDF 讀取：把戶政系統匯出的文字型 PDF 還原成表格（欄位＋資料列）
 * - 使用內嵌的 pdf.js（Apache-2.0），於主執行緒執行，不連網
 * - 中文 CMap 內嵌於頁面，不從網路下載
 * - 依文字座標還原「列」與「欄」；支援跨頁重複表頭、儲存格換行
 * - 找不到表格時，改用「欄位名稱：值」的表單格式讀取（一份 PDF 一人）
 * - 沒有文字層（掃描影像）時回報 scanned，不硬猜
 * ============================================================ */
"use strict";

/* 內嵌 CMap 讀取器（瀏覽器版從 #cmaps 讀 base64；Node 測試可自行傳入） */
function embeddedCMapFactory(getBytes, missing) {
  return class {
    constructor() {}
    async fetch({ name }) {
      const data = getBytes(name);
      if (!data) { missing.push(name); throw new Error(`缺少字碼對照表 ${name}`); }
      return { cMapData: data, compressionType: 1 };     // 1 = BINARY
    }
  };
}
function cmapsFromPage() {
  let table = null;
  return name => {
    if (!table) { try { table = JSON.parse(document.getElementById("cmaps").textContent); } catch { table = {}; } }
    const b64 = table[name];
    if (!b64) return null;
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
}

/* 讀出每頁的文字片段 */
async function pdfTextItems(data, opts = {}, missing = []) {
  const lib = opts.lib || globalThis.pdfjsLib;
  if (!lib) throw new Error("PDF 讀取元件未載入");
  const doc = await lib.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    CMapReaderFactory: embeddedCMapFactory(opts.cmap || cmapsFromPage(), missing),
    cMapUrl: "embedded/", cMapPacked: true, useWorkerFetch: false,
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    pages.push(tc.items.filter(it => typeof it.str === "string").map(it => {
      const [a, b, c, d, x, y] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
      return { str: it.str, x, y, w: it.width || size * it.str.length, size };
    }));
  }
  await doc.destroy();
  return pages;
}

const PDF_HEADER_WORDS = ["姓名", "統一編號", "身分證統一編號", "身分證字號", "稱謂", "關係", "出生日期", "出生年月日",
  "死亡日期", "死亡年月日", "性別", "父姓名", "母姓名", "配偶姓名", "父親姓名", "母親姓名", "與本人關係",
  "統號", "父親統號", "母親統號", "配偶統號", "結婚日期", "統號變更註記", "姓名變更註記", "項目"];
/* 兩行表頭的第二行常見片段（例如「配偶／統號」「姓名變更／註記」） */
const PDF_HEADER_TAIL = /^(統號|統一編號|姓名|日期|年月日|註記|變更註記|編號|關係)$/;
const pdfNorm = s => String(s || "").replace(/[\s　]/g, "");

/* 同一頁內，依 y 座標分成多行；每行依 x 排序 */
function pdfLines(items) {
  const sorted = items.filter(i => i.str.trim() !== "").sort((p, q) => q.y - p.y || p.x - q.x);
  const lines = [];
  for (const it of sorted) {
    const ln = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, it.size * 0.45));
    if (ln) ln.items.push(it); else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  for (const l of lines) l.items.sort((p, q) => p.x - q.x);
  return lines.sort((p, q) => q.y - p.y);
}

/* 相鄰片段合併成「詞組」（用於找表頭與欄位位置） */
function pdfChunks(line) {
  const out = [];
  for (const it of line.items) {
    const last = out[out.length - 1];
    const gap = last ? it.x - (last.x + last.w) : Infinity;
    if (last && gap < it.size * 0.6) { last.str += it.str; last.w = it.x + it.w - last.x; }
    else out.push({ str: it.str, x: it.x, w: it.w, size: it.size });
  }
  return out.map(c => ({ ...c, str: c.str.trim() })).filter(c => c.str);
}

function pdfIsHeader(line) {
  const chunks = pdfChunks(line).map(c => pdfNorm(c.str));
  const hits = chunks.filter(c => PDF_HEADER_WORDS.includes(c)).length;
  return chunks.some(c => c === "姓名") && hits >= 2 && chunks.length >= 3;
}

/* 主函式：回傳與 CSV 相同的表格格式 { headers, body, headerRow }，另附 meta */
async function pdfReadTable(data, opts = {}) {
  const missing = [];
  const pages = await pdfTextItems(data, opts, missing);
  const charCount = pages.reduce((a, p) => a + p.reduce((b, i) => b + pdfNorm(i.str).length, 0), 0);
  const meta = { pages: pages.length, chars: charCount, scanned: charCount < 8, mode: "", notes: [] };
  if (missing.length) meta.notes.push(`此 PDF 使用的字碼對照表（${[...new Set(missing)].join("、")}）未內建，中文可能無法正確辨識，請改用 CSV 匯出`);
  if (meta.scanned) return { headers: [], body: [], headerRow: 1, meta };

  const pageLines = pages.map(pdfLines);
  let headers = null, cols = null, headerKey = "";
  const body = [];
  let lastRowY = null, lastRow = null;

  const colOf = (cx) => {                              // 依欄位邊界決定所屬欄
    for (let i = 0; i < cols.length; i++) if (cx < cols[i].right) return i;
    return cols.length - 1;
  };
  const setCols = chunks => {
    cols = chunks.map((c, i) => {
      const next = chunks[i + 1];
      return { left: c.x, right: next ? (c.x + c.w + next.x) / 2 : Infinity };
    });
  };

  const uidCol = () => headers.findIndex(h => ["統一編號", "身分證統一編號", "身分證字號", "統號"].includes(h));
  // 兩行表頭：下一行緊接在表頭下方，且全是「統號」「日期」「註記」這類片段 → 依水平位置接到上一行的欄名
  const headerTail = (chunks, line, next) => {
    if (!next || line.y - next.y > line.size * 1.9) return false;
    const tail = pdfChunks(next);
    if (!tail.length || !tail.every(t => PDF_HEADER_TAIL.test(pdfNorm(t.str)))) return false;
    for (const t of tail) {
      const cx = t.x + t.w / 2;
      let best = null, dist = Infinity;
      for (const c of chunks) { const d = Math.abs(c.x + c.w / 2 - cx); if (d < dist) { dist = d; best = c; } }
      if (best) best.str = pdfNorm(best.str) + pdfNorm(t.str);
    }
    return true;
  };
  let skipLine = -1;
  pageLines.forEach((lines, pi) => {
    let pageHasHeader = false;
    lastRowY = null; skipLine = -1;
    const hIdx = lines.findIndex(pdfIsHeader);           // 表頭以上（標題、查詢條件）不屬於表格
    lines.forEach((line, li) => {
      if (hIdx > 0 && li < hIdx) return;
      if (li === skipLine) return;
      if (pdfIsHeader(line)) {
        const chunks = pdfChunks(line);
        if (headerTail(chunks, line, lines[li + 1])) skipLine = li + 1;
        const key = chunks.map(c => pdfNorm(c.str)).join("|");
        if (!headers) { headers = chunks.map(c => pdfNorm(c.str)); headerKey = key; }
        else if (key !== headerKey) meta.notes.push(`第 ${pi + 1} 頁的表頭與第一頁不同，已依第一頁欄位讀取`);
        setCols(chunks);
        pageHasHeader = true;
        lastRow = null;
        return;
      }
      if (!headers || !cols) return;
      // 沒有重複表頭的續頁：沿用前一頁欄位位置
      const cells = new Array(cols.length).fill("");
      for (const it of line.items) {
        const i = colOf(it.x + it.w / 2);
        cells[i] += it.str;
      }
      const trimmed = cells.map(c => c.trim());
      const filled = trimmed.filter(Boolean).length;
      const nameIdx = headers.indexOf("姓名");
      const lineGap = lastRowY === null ? Infinity : lastRowY - line.y;
      // 儲存格換行：姓名欄空白、只有少數欄有字、緊接在上一列之下 → 併入上一列
      if (lastRow && !trimmed[nameIdx] && filled <= Math.max(2, Math.floor(cols.length / 3)) && lineGap < line.size * 2.2) {
        trimmed.forEach((v, i) => { if (v) lastRow[i] = (lastRow[i] + v).trim(); });
        lastRowY = line.y;
        return;
      }
      // 頁尾、頁碼、說明文字：欄數太少或沒有姓名
      const ui = uidCol();
      // 統一編號欄有字但不像統號 → 標題或說明文字；空白則可能是早年死亡、無統號的人（至少要有 3 欄資料）
      const uv = pdfNorm(trimmed[ui] || "");
      const badUid = ui >= 0 && (uv ? !/^[A-Za-z][0-9A-Za-z]\d{8}$/.test(uv) : filled < 3);
      if (filled < 2 || !trimmed[nameIdx] || badUid) {
        const txt = trimmed.filter(Boolean).join(" ");
        if (filled && !/^(第?\s*\d+\s*頁.*|page\s*\d+.*|\d+\s*[\/／]\s*\d+)$/i.test(pdfNorm(txt))) meta.notes.push(`略過非表格文字：「${trimmed.filter(Boolean).join(" ").slice(0, 30)}」（第 ${pi + 1} 頁）`);
        return;
      }
      body.push(trimmed);
      lastRow = trimmed; lastRowY = line.y;
    });
  });

  if (headers && body.length) {
    meta.mode = "table";
    return { headers, body, headerRow: 1, meta };
  }

  // 表單格式：「欄位名稱：值」
  const allText = pageLines.flat().map(l => pdfChunks(l).map(c => c.str).join("　")).join("\n");
  const labels = [...new Set(PDF_HEADER_WORDS)].sort((a, b) => b.length - a.length);
  const found = {};
  for (const lb of labels) {
    const re = new RegExp(`(?<![父母偶親])${lb}[ \\t　]*[：:][ \\t]*([^\\s　：:]+)`);   // 不誤抓「父姓名」；冒號後不跨行
    const m = allText.match(re);
    if (m) found[lb] = m[1];
  }
  if (found["姓名"]) {
    meta.mode = "form";
    const hs = Object.keys(found);
    return { headers: hs, body: [hs.map(h => found[h])], headerRow: 1, meta };
  }
  meta.notes.push("PDF 中找不到含「姓名」欄位的表格，也找不到「姓名：」格式的資料");
  return { headers: [], body: [], headerRow: 1, meta };
}

if (typeof module !== "undefined") module.exports = { pdfReadTable, pdfTextItems, pdfLines, pdfChunks };
