/* ============================================================
 * Excel 讀取（不依賴外部套件，離線可用）
 * - .xlsx：自行解析 ZIP，以瀏覽器內建 DecompressionStream 解壓，再讀取第一張工作表
 * - .xls（Excel 97-2003，BIFF8）：自行解析複合文件格式與 BIFF 紀錄
 * - 部分系統匯出的 .xls 其實是 HTML 表格：以純文字方式解析（不插入畫面、不執行任何內容）
 * - 日期格式的儲存格（Excel 日期序號）轉為西元日期；數字型民國日期（如 370512）保留數字交給日期解析
 * 回傳 { rows: string[][], sheet: 工作表名稱, format: "xlsx" | "xls" | "html" }
 * ============================================================ */
"use strict";

const XL_SIG = { zip: [0x50, 0x4B, 0x03, 0x04], cfb: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] };
function xlStarts(b, sig) { return sig.every((v, i) => b[i] === v); }
function xlKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (xlStarts(b, XL_SIG.zip)) return "xlsx";
  if (xlStarts(b, XL_SIG.cfb)) return "xls";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.slice(0, 2048)).toLowerCase();
  if (/<table|<html|<\?xml[^>]*>\s*<workbook/.test(head)) return "html";
  return "";
}

/* ---------- 共用：日期序號與格式 ---------- */
const XL_DATE_BUILTIN = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
function xlIsDateFormat(id, code) {
  if (XL_DATE_BUILTIN.has(id)) return true;
  if (!code) return false;
  const c = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");    // 去掉字串常值、跳脫字元、色彩與條件
  return /[ymde]/i.test(c) && !/^(general|@|0|#)/i.test(c.trim());
}
function xlSerialToIso(n) {
  if (!(n > 0 && n < 2958466)) return null;
  const ms = Math.round((n - 25569) * 86400000);           // 1900 日期系統：25569 = 1970-01-01
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function xlNum(n) { return Number.isInteger(n) ? String(n) : String(+n.toPrecision(15)); }
function xlEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k];
  });
}
function xlColIndex(ref) { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

/* ---------- .xlsx ---------- */
async function xlUnzip(bytes) {
  const b = bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Excel 檔案結構不完整（找不到 ZIP 目錄）");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014B50) throw new Error("Excel 檔案結構不完整（ZIP 目錄錯誤）");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    files[name] = { method, csize, local };
    p += 46 + nlen + elen + clen;
  }
  const read = async name => {
    const f = files[name];
    if (!f) return null;
    const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
    const data = b.subarray(start, start + f.csize);
    if (f.method === 0) return dec.decode(data);
    if (f.method !== 8) throw new Error("Excel 使用了不支援的壓縮方式");
    if (typeof DecompressionStream !== "function") throw new Error("瀏覽器版本過舊，無法讀取 .xlsx，請改用 Edge／Chrome 新版，或另存為 CSV");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return dec.decode(await new Response(stream).arrayBuffer());
  };
  return { names: Object.keys(files), read };
}
function xlAttr(tag, name) { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? xlEntities(m[1]) : ""; }

async function xlsxRows(bytes) {
  const z = await xlUnzip(bytes);
  const wb = await z.read("xl/workbook.xml");
  if (!wb) throw new Error("不是有效的 Excel 活頁簿");
  const firstSheet = (wb.match(/<(?:\w+:)?sheet\b[^>]*>/) || [""])[0];
  const sheetName = xlAttr(firstSheet, "name") || "工作表1";
  const rid = xlAttr(firstSheet, "r:id");
  let target = "worksheets/sheet1.xml";
  const rels = await z.read("xl/_rels/workbook.xml.rels");
  if (rels && rid) {
    for (const rel of rels.match(/<Relationship\b[^>]*>/g) || []) if (xlAttr(rel, "Id") === rid) target = xlAttr(rel, "Target");
  }
  const sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  const xml = await z.read(sheetPath);
  if (!xml) throw new Error("找不到工作表內容");

  const textOf = frag => [...frag.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => xlEntities(m[1])).join("");
  const sst = [];
  const ss = await z.read("xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) sst.push(textOf(m[1].replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "")));

  // 樣式：哪些儲存格格式是日期
  const dateXf = new Set();
  const st = await z.read("xl/styles.xml");
  if (st) {
    const codes = {};
    for (const m of st.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) codes[+xlAttr(m[0], "numFmtId")] = xlAttr(m[0], "formatCode");
    const xfs = (st.match(/<(?:\w+:)?cellXfs\b[\s\S]*?<\/(?:\w+:)?cellXfs>/) || [""])[0];
    [...xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].forEach((m, i) => { const id = +xlAttr(m[0], "numFmtId"); if (xlIsDateFormat(id, codes[id])) dateXf.add(i); });
  }

  const rows = [];
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const r = +(xlAttr(" " + rm[1], "r") || rows.length + 1) - 1;
    const row = [];
    for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = " " + cm[1], inner = cm[2] || "";
      const ref = xlAttr(attrs, "r"), t = xlAttr(attrs, "t"), sIdx = +(xlAttr(attrs, "s") || 0);
      const col = ref ? xlColIndex(ref) : row.length;
      const v = (inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
      let val = "";
      if (t === "s") val = sst[+v] ?? "";
      else if (t === "inlineStr") val = textOf(inner);
      else if (t === "str" || t === "e") val = v !== undefined ? xlEntities(v) : "";
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) { const n = +v; val = dateXf.has(sIdx) ? (xlSerialToIso(n) || xlNum(n)) : xlNum(n); }
      row[col] = val;
    }
    rows[r] = Array.from(row, x => x ?? "");
  }
  return { rows: Array.from(rows, x => x || []), sheet: sheetName, format: "xlsx" };
}

/* ---------- .xls（BIFF8） ---------- */
function cfbStream(bytes, wanted) {
  const b = bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ssz = 1 << dv.getUint16(0x1E, true), mssz = 1 << dv.getUint16(0x20, true);
  const nFat = dv.getUint32(0x2C, true), dirStart = dv.getUint32(0x30, true), cutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3C, true), difatStart = dv.getUint32(0x44, true);
  const off = sid => (sid + 1) * ssz;
  const END = 0xFFFFFFFA;
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(dv.getUint32(0x4C + i * 4, true));
  for (let d = difatStart, guard = 0; d < END && fatSectors.length < nFat && guard < 10000; guard++) {
    const per = ssz / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < nFat; i++) fatSectors.push(dv.getUint32(off(d) + i * 4, true));
    d = dv.getUint32(off(d) + per * 4, true);
  }
  const fat = [];
  for (const s of fatSectors) for (let i = 0; i < ssz / 4; i++) fat.push(dv.getUint32(off(s) + i * 4, true));
  const chain = (start, table) => { const out = []; for (let s = start, g = 0; s < END && g < 1e6; g++) { out.push(s); s = table[s]; } return out; };
  const readChain = (start, size) => {
    const out = new Uint8Array(size); let p = 0;
    for (const s of chain(start, fat)) { const n = Math.min(ssz, size - p); if (n <= 0) break; out.set(b.subarray(off(s), off(s) + n), p); p += n; }
    return out;
  };
  // 目錄
  const dirSids = chain(dirStart, fat);
  const entries = [];
  for (const s of dirSids) for (let i = 0; i < ssz / 128; i++) {
    const base = off(s) + i * 128;
    const nlen = dv.getUint16(base + 0x40, true);
    const name = String.fromCharCode(...Array.from({ length: Math.max(0, nlen / 2 - 1) }, (_, k) => dv.getUint16(base + k * 2, true)));
    entries.push({ name, type: b[base + 0x42], start: dv.getUint32(base + 0x74, true), size: dv.getUint32(base + 0x78, true) });
  }
  const root = entries.find(e => e.type === 5);
  const ent = entries.find(e => e.type === 2 && wanted.includes(e.name));
  if (!ent) return null;
  if (ent.size >= cutoff) return readChain(ent.start, ent.size);
  // 小於門檻的串流存在迷你串流中
  const miniStream = readChain(root.start, root.size);
  const nMini = dv.getUint32(0x40, true);
  const miniFatBytes = readChain(miniFatStart, nMini * ssz);
  const mdv = new DataView(miniFatBytes.buffer);
  const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, i) => mdv.getUint32(i * 4, true));
  const out = new Uint8Array(ent.size); let p = 0;
  for (const s of chain(ent.start, miniFat)) { const n = Math.min(mssz, ent.size - p); if (n <= 0) break; out.set(miniStream.subarray(s * mssz, s * mssz + n), p); p += n; }
  return out;
}

function xlsRows(bytes) {
  const wb = cfbStream(bytes, ["Workbook", "Book"]);
  if (!wb) throw new Error("讀不到 .xls 的活頁簿內容，請在 Excel 另存為 .xlsx 後再匯入");
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const recs = [];
  for (let p = 0; p + 4 <= wb.length;) {
    const type = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
    recs.push({ type, pos: p + 4, len });
    p += 4 + len;
  }
  if (!recs.length || recs[0].type !== 0x0809 || dv.getUint16(recs[0].pos, true) !== 0x0600) {
    throw new Error("這是較舊的 Excel 格式（Excel 95 以前），請在 Excel 另存為 .xlsx 後再匯入");
  }
  const u16 = p => dv.getUint16(p, true), u32 = p => dv.getUint32(p, true);
  const dec16 = new TextDecoder("utf-16le"), dec8 = new TextDecoder("latin1");

  // 讀取可能跨越 CONTINUE 紀錄的字串
  function makeReader(segs) {
    let si = 0, p = segs[0].pos;
    const left = () => segs[si].pos + segs[si].len - p;
    const next = () => { si++; p = segs[si].pos; };
    return {
      u8() { if (left() < 1) next(); return wb[p++]; },
      u16() { if (left() < 2) next(); const v = u16(p); p += 2; return v; },
      u32() { if (left() < 4) next(); const v = u32(p); p += 4; return v; },
      skip(n) { while (n > 0) { if (left() === 0) next(); const k = Math.min(n, left()); p += k; n -= k; } },
      str(cch, flags) {
        let out = "", wide = flags & 1;
        while (cch > 0) {
          if (left() === 0) { next(); wide = wb[p++] & 1; }
          const can = Math.min(cch, wide ? Math.floor(left() / 2) : left());
          const bytes = wb.subarray(p, p + can * (wide ? 2 : 1));
          out += wide ? dec16.decode(bytes) : dec8.decode(bytes);
          p += bytes.length; cch -= can;
        }
        return out;
      },
    };
  }
  const xlString = r => {
    const cch = r.u16(), flags = r.u8();
    const runs = flags & 8 ? r.u16() : 0, ext = flags & 4 ? r.u32() : 0;
    const s = r.str(cch, flags);
    r.skip(runs * 4 + ext);
    return s;
  };

  const sst = [], formats = {}, xfFmt = [], sheets = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === 0x00FC) {                                 // SST（含後續 CONTINUE）
      const segs = [r];
      while (recs[i + 1] && recs[i + 1].type === 0x003C) segs.push(recs[++i]);
      const rd = makeReader(segs);
      rd.u32(); const n = rd.u32();
      for (let k = 0; k < n; k++) sst.push(xlString(rd));
    } else if (r.type === 0x041E) {                          // FORMAT
      const rd = makeReader([r]); const id = rd.u16(); formats[id] = xlString(rd);
    } else if (r.type === 0x00E0) {                          // XF
      xfFmt.push(u16(r.pos + 2));
    } else if (r.type === 0x0085) {                          // BOUNDSHEET
      const rd = makeReader([r]); const at = rd.u32(); rd.u8(); const kind = rd.u8();
      const cch = rd.u8(), flags = rd.u8();
      sheets.push({ at, kind, name: rd.str(cch, flags) });
    }
  }
  const sheet = sheets.find(s => s.kind === 0) || sheets[0];
  if (!sheet) throw new Error("活頁簿中沒有工作表");
  const isDateXf = xf => xlIsDateFormat(xfFmt[xf], formats[xfFmt[xf]]);
  const rkVal = rk => { let v = rk & 2 ? (rk >> 2) : new DataView(new Uint32Array([0, rk & 0xFFFFFFFC]).buffer).getFloat64(0, true); if (rk & 1) v /= 100; return v; };
  const numText = (n, xf) => (isDateXf(xf) ? (xlSerialToIso(n) || xlNum(n)) : xlNum(n));

  const rows = [];
  const put = (r, c, v) => { (rows[r] ||= [])[c] = v; };
  let i = recs.findIndex(r => r.pos - 4 === sheet.at);
  if (i < 0) throw new Error("找不到工作表內容");
  let pendingFormula = null;
  for (i++; i < recs.length; i++) {
    const r = recs[i], p = r.pos;
    if (r.type === 0x000A) break;                            // EOF
    if (r.type === 0x00FD) put(u16(p), u16(p + 2), sst[u32(p + 6)] ?? "");                       // LABELSST
    else if (r.type === 0x0203) put(u16(p), u16(p + 2), numText(dv.getFloat64(p + 6, true), u16(p + 4)));  // NUMBER
    else if (r.type === 0x027E) put(u16(p), u16(p + 2), numText(rkVal(u32(p + 6)), u16(p + 4)));           // RK
    else if (r.type === 0x00BD) {                           // MULRK
      const row = u16(p), first = u16(p + 2), n = (r.len - 6) / 6;
      for (let k = 0; k < n; k++) put(row, first + k, numText(rkVal(u32(p + 4 + k * 6 + 2)), u16(p + 4 + k * 6)));
    } else if (r.type === 0x0204) {                         // LABEL
      const rd = makeReader([{ pos: p + 6, len: r.len - 6 }]); put(u16(p), u16(p + 2), xlString(rd));
    } else if (r.type === 0x0006) {                         // FORMULA（取快取結果）
      if (u16(p + 12) === 0xFFFF) { if (wb[p + 6] === 0) pendingFormula = [u16(p), u16(p + 2)]; }
      else put(u16(p), u16(p + 2), numText(dv.getFloat64(p + 6, true), u16(p + 4)));
    } else if (r.type === 0x0207 && pendingFormula) {       // STRING（公式的字串結果）
      const rd = makeReader([r]); put(pendingFormula[0], pendingFormula[1], xlString(rd)); pendingFormula = null;
    }
  }
  return { rows: Array.from(rows, x => Array.from(x || [], v => v ?? "")), sheet: sheet.name, format: "xls" };
}

/* ---------- HTML 表格偽裝的 .xls ---------- */
function htmlTableRows(bytes) {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/charset=["']?big5/i.test(text.slice(0, 2048))) text = new TextDecoder("big5").decode(bytes);
  const strip = s => xlEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  const rows = [];
  for (const tr of text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = [];
    for (const td of tr[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      row.push(strip(td[3]));
      const span = +((td[2].match(/colspan\s*=\s*["']?(\d+)/i) || [])[1] || 1);
      for (let k = 1; k < span; k++) row.push("");
    }
    rows.push(row);
  }
  if (!rows.length) throw new Error("檔案中沒有表格資料");
  return { rows, sheet: "", format: "html" };
}

async function excelReadRows(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const kind = xlKind(bytes);
  if (kind === "xlsx") return xlsxRows(bytes);
  if (kind === "xls") return xlsRows(bytes);
  if (kind === "html") return htmlTableRows(bytes);
  throw new Error("無法辨識的 Excel 檔案格式");
}

if (typeof module !== "undefined") module.exports = { excelReadRows, xlKind, xlSerialToIso, xlIsDateFormat };
