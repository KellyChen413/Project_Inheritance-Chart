/* ============================================================
 * CSV 匯入／匯出
 * - 自動辨識編碼：UTF-8（含 BOM）或 Big5（Excel 中文版預設）
 * - 自動辨識分隔符號：逗號或 Tab
 * - 父、母、配偶可填「姓名」或「編號」
 * 純運算，不連網。
 * ============================================================ */
"use strict";

const _parseDate = typeof parseDate === "function" ? parseDate : require("./engine.js").parseDate;

const CSV_COLUMNS = {
  id:       ["編號", "代號", "id", "ID"],
  title:    ["稱謂", "關係", "身分", "身份"],
  name:     ["姓名", "名字", "name"],
  gender:   ["性別"],
  birth:    ["出生日期", "出生", "生日", "出生年月日"],
  death:    ["死亡日期", "死亡", "歿", "死亡年月日"],
  father:   ["父", "父親", "父姓名"],
  mother:   ["母", "母親", "母姓名"],
  spouse:   ["配偶", "配偶姓名"],
  renounced:["拋棄", "拋棄繼承"],
  lost:     ["喪失", "喪失繼承權"],
};
const CSV_IGNORED = ["備註", "說明", "附註"];
const YES = new Set(["是", "y", "Y", "yes", "YES", "v", "V", "✓", "✔", "1", "o", "O", "○", "拋棄", "喪失", "TRUE", "true"]);

/* 位元組 → 文字：先試 UTF-8，失敗就用 Big5 */
function decodeBytes(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let text, encoding;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); encoding = "UTF-8"; }
  catch { text = new TextDecoder("big5").decode(bytes); encoding = "Big5"; }
  return { text: text.replace(/^﻿/, ""), encoding };
}

/* 解析 CSV 文字成二維陣列（支援引號、欄位內換行、CRLF） */
function parseCsvText(text) {
  const lines = text.split(/\r?\n/, 30);
  const firstLine = lines.find(l => CSV_COLUMNS.name.some(n => l.includes(n))) || lines[0] || "";   // 以標題列判斷
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"' && field === "") inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}

/* CSV 文字 → 系統資料格式；回傳 { data, errors, warnings } */
function importCsv(text) {
  const errors = [], warnings = [];
  const rows = parseCsvText(text);
  if (!rows.length) return { data: null, errors: ["檔案是空的"], warnings };

  // 找標題列（允許前面有幾列說明文字）
  let headerIdx = rows.findIndex(r => r.some(v => CSV_COLUMNS.name.includes(v.trim())));
  if (headerIdx < 0) return { data: null, errors: ["找不到「姓名」欄位。第一列應為欄位名稱，例如：稱謂、姓名、性別、出生日期……"], warnings };
  const header = rows[headerIdx].map(v => v.trim());
  const col = {};
  header.forEach((h, i) => {
    const key = Object.keys(CSV_COLUMNS).find(k => CSV_COLUMNS[k].includes(h));
    if (key && !(key in col)) col[key] = i;
    else if (h && !key && !CSV_IGNORED.includes(h)) warnings.push(`欄位「${h}」無法辨識，已略過`);
  });

  const get = (r, key) => (key in col ? (r[col[key]] || "").trim() : "");
  const lineNo = i => i + headerIdx + 2;            // 對應 Excel 的列號
  const body = rows.slice(headerIdx + 1);

  // 第一輪：建立人員與編號
  const persons = [], usedIds = new Set();
  body.forEach(r => { const id = get(r, "id"); if (id) usedIds.add(id); });
  let seq = 1;
  const nextId = () => { while (usedIds.has(`P${String(seq).padStart(2, "0")}`)) seq++; const id = `P${String(seq++).padStart(2, "0")}`; usedIds.add(id); return id; };
  const seenIds = new Set();
  body.forEach((r, i) => {
    const name = get(r, "name");
    if (!name) { warnings.push(`第 ${lineNo(i)} 列沒有姓名，已略過`); return; }
    let id = get(r, "id");
    if (id && seenIds.has(id)) { errors.push(`第 ${lineNo(i)} 列：編號「${id}」重複`); return; }
    if (!id) id = nextId();
    seenIds.add(id);
    const g = get(r, "gender");
    const gender = /^(男|M|m|1)$/.test(g) ? "M" : /^(女|F|f|2)$/.test(g) ? "F" : "";
    if (g && !gender) warnings.push(`第 ${lineNo(i)} 列：性別「${g}」無法辨識，請填男或女`);
    persons.push({ _row: lineNo(i), _r: r, id, name, title: get(r, "title"), gender,
      birth: get(r, "birth"), death: get(r, "death") });
  });

  // 姓名 → 人員（偵測同名）
  const byName = {}, byId = {};
  for (const p of persons) { (byName[p.name] ||= []).push(p); byId[p.id] = p; }
  for (const [n, list] of Object.entries(byName)) {
    if (list.length > 1) warnings.push(`有 ${list.length} 人同名「${n}」（第 ${list.map(p => p._row).join("、")} 列），參照此人時請改填編號`);
  }
  const resolve = (value, p, label) => {
    if (!value) return null;
    if (byId[value]) return byId[value].id;
    const list = byName[value];
    if (!list) { errors.push(`第 ${p._row} 列（${p.name}）：${label}「${value}」不在名單中，請先將此人加入名單`); return null; }
    if (list.length > 1) { errors.push(`第 ${p._row} 列（${p.name}）：${label}「${value}」有同名者，請改填編號`); return null; }
    if (list[0] === p) { errors.push(`第 ${p._row} 列（${p.name}）：${label}不能填自己`); return null; }
    return list[0].id;
  };

  // 被繼承人：稱謂為「被繼承人」者
  const decs = persons.filter(p => p.title.replace(/\s/g, "") === "被繼承人");
  if (decs.length > 1) warnings.push(`有 ${decs.length} 列稱謂為「被繼承人」，已選第一位，請確認`);
  if (!decs.length) warnings.push("沒有稱謂為「被繼承人」的列，請匯入後在上方選擇被繼承人");
  const decedent = decs[0] ? decs[0].id : "";

  // 第二輪：關係與拋棄
  const listOf = (value, p, label) => {
    if (!value) return [];
    return value.split(/[、,，;；\/\s]+/).filter(Boolean).flatMap(v => {
      if (YES.has(v)) {
        if (!decedent) { warnings.push(`第 ${p._row} 列（${p.name}）：${label}填「${v}」，但尚未指定被繼承人`); return []; }
        return [decedent];
      }
      const id = resolve(v, p, `${label}之對象`);
      return id ? [id] : [];
    });
  };
  for (const p of persons) {
    const r = p._r;
    p.father = resolve(get(r, "father"), p, "父");
    p.mother = resolve(get(r, "mother"), p, "母");
    p.spouse = resolve(get(r, "spouse"), p, "配偶");
    p.renounced = listOf(get(r, "renounced"), p, "拋棄");
    // 喪失欄：「是」或款別（如「第1款」「第3款，經宥恕」）；第2～4款經宥恕者繼承權不喪失（民法第1145條第2項）
    const lostRaw = get(r, "lost");
    const cm = lostRaw.match(/第?\s*([1-5一二三四五])\s*款/);
    if (cm && decedent) {
      const clause = String("一二三四五".indexOf(cm[1]) + 1 || cm[1]);
      const forgiven = /宥恕/.test(lostRaw) && ["2", "3", "4"].includes(clause);
      if (/宥恕/.test(lostRaw) && !forgiven) warnings.push(`第 ${p._row} 列（${p.name}）：第${clause}款不適用宥恕（民法第1145條第2項限第2至4款），仍喪失繼承權`);
      p.lostChecks = { [decedent]: { clause, forgiven } };
      p.lost_right = forgiven ? [] : [decedent];
    } else p.lost_right = listOf(lostRaw, p, "喪失");
    for (const [k, label] of [["birth", "出生日期"], ["death", "死亡日期"]]) {
      if (p[k] && _parseDate(p[k]) === undefined) warnings.push(`第 ${p._row} 列（${p.name}）：${label}「${p[k]}」格式無法辨識，匯入後請修正`);
    }
  }
  // 配偶互填不一致
  for (const p of persons) {
    const s = p.spouse && byId[p.spouse];
    if (s && s.spouse && s.spouse !== p.id) warnings.push(`${p.name} 與 ${s.name} 的配偶欄互相不一致，請確認`);
  }

  const data = { decedent, persons: persons.map(({ _row, _r, ...rest }) => rest) };
  return { data: errors.length ? null : data, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/* 系統資料 → CSV 文字（UTF-8 BOM，Excel 可直接開啟） */
function exportCsv(persons, decedent) {
  const count = {};
  persons.forEach(p => (count[p.name] = (count[p.name] || 0) + 1));
  const byId = Object.fromEntries(persons.map(p => [p.id, p]));
  const ref = id => (!id || !byId[id] ? "" : count[byId[id].name] > 1 ? id : byId[id].name);   // 同名才用編號
  const rocText = iso => {
    const d = _parseDate(iso);
    if (!d) return iso || "";
    const [y, m, dd] = d.split("-").map(Number);
    return y > 1911 ? `民國${y - 1911}年${m}月${dd}日` : `${y}/${m}/${dd}`;   // 用中文日期，避免 Excel 誤判兩位數民國年
  };
  const marks = list => list.map(t => (t === decedent ? "是" : ref(t))).filter(Boolean).join("、");
  const lostMark = p => {
    const info = (p.lostChecks || {})[decedent];
    const main = info ? (info.clause ? `第${info.clause}款${info.forgiven ? "（經宥恕）" : ""}` : "是") : "";
    return [main, marks((p.lost_right || []).filter(t => t !== decedent))].filter(Boolean).join("、");
  };
  const esc = v => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [["編號", "稱謂", "姓名", "性別", "出生日期", "死亡日期", "父", "母", "配偶", "拋棄", "喪失"]];
  for (const p of persons) {
    lines.push([p.id, p.title || "", p.name || "", p.gender === "M" ? "男" : p.gender === "F" ? "女" : "",
      rocText(p.birth), rocText(p.death), ref(p.father), ref(p.mother), ref(p.spouse),
      marks(p.renounced || []), lostMark(p)]);
  }
  return "﻿" + lines.map(r => r.map(v => esc(String(v))).join(",")).join("\r\n") + "\r\n";
}

if (typeof module !== "undefined") module.exports = { decodeBytes, parseCsvText, importCsv, exportCsv };
