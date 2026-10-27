/* ============================================================
 * 戶籍資料匯入與串聯
 * - 親等關聯資料（二親等、三親等）：每份以一位「本人」為中心，稱謂相對於本人
 * - 個人戶籍資料：一人一列，無稱謂
 * - 以統一編號合併同一人，再依「稱謂」與「父、母、配偶姓名」建立親屬關係
 * - 只補空白的關係，不覆蓋使用者手動設定的資料
 * 純運算，不連網。
 * ============================================================ */
"use strict";

const { parseDate: hhrDate } = typeof parseDate === "function" ? { parseDate } : require("./engine.js");
const { parseCsvText: hhrCsv } = typeof parseCsvText === "function" ? { parseCsvText } : require("./csv.js");

const HHR_FIELDS = [
  { key: "relation",   label: "稱謂（相對於本人／戶長）", kinds: ["kin", "household"], required: ["kin", "household"],
    syn: ["稱謂", "關係", "親屬關係", "與本人關係", "親等關係", "稱謂關係", "與查詢人關係", "與戶長關係", "稱謂(與戶長關係)"] },
  { key: "name",       label: "姓名", kinds: ["kin", "personal", "household"], required: ["kin", "personal", "household"],
    syn: ["姓名", "名字", "本人姓名", "親屬姓名"] },
  { key: "uid",        label: "統一編號", kinds: ["kin", "personal", "household"], required: ["kin", "personal"],
    syn: ["統一編號", "身分證統一編號", "國民身分證統一編號", "身分證字號", "身分證號", "身分證號碼", "統號", "身分證統號", "本人統一編號", "本人統號", "親屬統一編號"] },
  { key: "gender",     label: "性別", kinds: ["kin", "personal", "household"], syn: ["性別"] },
  { key: "birth",      label: "出生日期", kinds: ["kin", "personal", "household"], syn: ["出生日期", "出生年月日", "生日", "出生", "出生日"] },
  { key: "death",      label: "死亡日期", kinds: ["kin", "personal", "household"], syn: ["死亡日期", "死亡年月日", "死亡", "死亡日", "死亡(宣告)日期"] },
  { key: "fatherName", label: "父姓名", kinds: ["kin", "personal", "household"], syn: ["父姓名", "父親姓名", "父", "父親"] },
  { key: "motherName", label: "母姓名", kinds: ["kin", "personal", "household"], syn: ["母姓名", "母親姓名", "母", "母親"] },
  { key: "spouseName", label: "配偶姓名", kinds: ["kin", "personal", "household"], syn: ["配偶姓名", "配偶", "配偶名"] },
  { key: "fatherUid",  label: "父統一編號", kinds: ["kin", "personal", "household"], syn: ["父統一編號", "父親統一編號", "父統號", "父親統號", "父身分證統一編號", "父身分證字號"] },
  { key: "motherUid",  label: "母統一編號", kinds: ["kin", "personal", "household"], syn: ["母統一編號", "母親統一編號", "母統號", "母親統號", "母身分證統一編號", "母身分證字號"] },
  { key: "spouseUid",  label: "配偶統一編號", kinds: ["kin", "personal", "household"], syn: ["配偶統一編號", "配偶統號", "配偶身分證統一編號", "配偶身分證字號"] },
  { key: "marriageDate", label: "結婚日期", kinds: ["kin", "personal", "household"], syn: ["結婚日期", "結婚年月日", "結婚日"] },
  { key: "uidNote",    label: "統號變更註記", kinds: ["kin", "personal", "household"], syn: ["統號變更註記", "統一編號變更註記", "統號變更", "統一編號變更"] },
  { key: "nameNote",   label: "姓名變更註記", kinds: ["kin", "personal", "household"], syn: ["姓名變更註記", "姓名變更", "更名註記"] },
  { key: "marriageEnd", label: "離婚／婚姻終止日期", kinds: ["household"], syn: ["離婚日期", "婚姻終止日期", "離婚年月日"] },
  { key: "memo",       label: "記事", kinds: ["household"], syn: ["記事", "戶籍記事", "記事欄", "個人記事"] },
];

/* ---------- 戶籍謄本「記事」欄解析 ----------
 * 新式（電腦列印）謄本的記事為「民國○年○月○日＋事件」的文字，例如：
 *   民國109年06月01日死亡　民國109年06月05日申請登記
 *   民國090年03月15日更改姓名　原名：王淑華
 *   民國098年05月20日與張建國結婚
 *   民國105年01月10日與張建國兩願離婚
 * 回傳抽出的事件；看不懂的句子原文保留，由人工判斷
 */
const MEMO_DATE = "(?:民國)?\\s*(\\d{1,3})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日";
function memoNorm(t) {
  return String(t || "").replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\r/g, "");
}
function parseMemo(text) {
  const t = memoNorm(text);
  const out = { death: "", deathDeclared: false, oldNames: [], marriages: [], divorces: [], adoption: false, notes: [] };
  if (!t.trim()) return out;
  const roc = (y, m, d) => `${+y}/${+m}/${+d}`;
  const NAME = "([\\u4e00-\\u9fff]{2,5}?)";
  // 死亡宣告：以判決所定的死亡時間為準
  if (/死亡宣告|宣告死亡/.test(t)) {
    out.deathDeclared = true;
    const pm = t.match(new RegExp(`死亡(?:之)?(?:時間|日期|時)[為：:\\s]*${MEMO_DATE}`));
    if (pm) out.death = roc(pm[1], pm[2], pm[3]);
  }
  // 依「民國○年○月○日」切成一句一事件（申請登記、戶政事務所等附註併在同一句）
  const parts = t.split(/(?<![\d國])(?=(?:民國)?\s*\d{1,3}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/).map(x => x.trim()).filter(Boolean);
  for (const part of parts) {
    const m = part.match(new RegExp(`^${MEMO_DATE}([\\s\\S]*)$`));
    if (!m) continue;
    const date = roc(m[1], m[2], m[3]), rest = m[4].replace(/[\s　]+/g, "");
    if (!rest || /^(申請登記|登記)/.test(rest)) continue;                       // 只是登記日期
    if (/死亡宣告|宣告死亡/.test(rest)) { out.notes.push(`${date} ${rest}`); continue; }
    if (/^推定死亡|^死亡(之)?(時間|日期)/.test(rest)) continue;
    if (/^(?:(?:於|在)[^，,。]{1,20}?)?死亡/.test(rest)) { if (!out.death) out.death = date; continue; }
    let x;
    if ((x = rest.match(new RegExp(`(?:原名|原姓名|舊名)[：:為]?${NAME}(?:[，,。\\s]|$|民國)`))) || (x = rest.match(new RegExp(`(?:原名|原姓名|舊名)[：:為]?([\\u4e00-\\u9fff]{2,5})`)))) { out.oldNames.push(x[1]); continue; }
    if ((x = rest.match(new RegExp(`與${NAME}(?:登記)?結婚`)))) { out.marriages.push({ date, name: x[1] }); continue; }
    if ((x = rest.match(new RegExp(`與${NAME}(?:兩願|判決|調解|和解|協議)?離婚`)))) { out.divorces.push({ date, name: x[1] }); continue; }
    if (/收養/.test(rest)) { out.adoption = true; out.notes.push(`${date} ${rest}`); continue; }
    if (/(遷入|遷出|住址變更|門牌|整編|出生登記|初設戶籍|職業|教育|役別|口卡|換發|補發|戶長變更|出生$|更改姓名$|改名$|更名$)/.test(rest)) continue;
    out.notes.push(`${date} ${rest}`);
  }
  // 沒有日期開頭、但寫了「原名」的情形
  for (const x of t.matchAll(new RegExp(`(?:原名|原姓名|舊名)[：:為\\s]*([\\u4e00-\\u9fff]{2,5})`, "g"))) if (!out.oldNames.some(n => x[1].startsWith(n))) out.oldNames.push(x[1]);
  return out;
}
/* 戶役政匯出檔中不屬於資料的欄位（序號、操作按鈕），自動略過 */
const HHR_IGNORED = ["項目", "查看", "序號", "編號", "操作", "選取"];

/* 變更註記的值：空白、「-」「無」視為沒有變更；「*」表示有變更但匯出檔未載明內容 */
function noteValue(v) {
  const t = String(v || "").replace(/[\s　]/g, "");
  if (!t || /^(-|－|—|無|否|N|n|0)$/.test(t)) return "";
  if (/^[*＊※]+$/.test(t)) return "*";
  return String(v).trim();
}

/* 從變更註記中找出舊統號、舊姓名，供合併與父母姓名比對使用 */
function changeAliases(uidNote, nameNote, uid, name) {
  const uids = [...new Set((String(uidNote || "").toUpperCase().match(/[A-Z][0-9A-Z]\d{8}/g) || []).filter(u => u !== uid))];
  const names = new Set();
  const n = String(nameNote || "");
  for (const m of n.matchAll(/(?:原名|原姓名|舊名|舊姓名|更名前|變更前|原為)[：:\s為]*([\u4e00-\u9fff]{2,6})/g)) names.add(m[1]);
  for (const m of n.matchAll(/([\u4e00-\u9fff]{2,6})\s*(?:→|->|＞|>|改為|更名為|變更為|改名為)\s*([\u4e00-\u9fff]{2,6})/g)) { names.add(m[1]); names.add(m[2]); }
  names.delete(name);
  return { uidAliases: uids, nameAliases: [...names] };
}

const normHeader = h => String(h || "").replace(/[\s　]/g, "").replace(/（/g, "(").replace(/）/g, ")");
const normUid = u => String(u || "").replace(/[\s　]/g, "").toUpperCase();

/* 稱謂分類（相對於本人） */
const REL = {
  self:    /^(本人|自己|查詢人|當事人|戶長)$/,      // 戶役政二親等匯出檔中，被查詢人的稱謂為「自己」
  father:  /^(父|父親|養父)$/,
  mother:  /^(母|母親|養母)$/,
  spouse:  /^(配偶|夫|妻|丈夫|妻子|先生|太太)$/,
  child:   /^((長|次|三|四|五|六|七|八|九|十)?(男|女|子)|兒子|女兒|子女|養子|養女|長孫)$/,
  sibling: /^(兄|弟|姊|姐|妹|兄弟|姊妹|姐妹|兄弟姊妹)$/,
  // 以下依父母姓名串聯即可
  other:   /^(外?祖父|外?祖母|外?祖父母|外?曾祖父|外?曾祖母|外?孫|外?孫子|外?孫女|外?孫子女|外?曾孫|外?曾孫女|姪|姪子|姪女|外?甥|外?甥女|伯父|伯母|叔父|嬸|嬸嬸|姑|姑母|姑丈|舅|舅父|舅媽|姨|姨母|姨丈|媳|媳婦|婿|女婿)$/,
};
function genderFromRelation(rel) {
  if (/^(父|父親|養父|夫|丈夫|先生|兄|弟|祖父|外祖父|曾祖父|伯父|叔父|舅|姪|外甥|孫|外孫|曾孫|姪子|孫子|外孫子|女婿|婿)$/.test(rel) ||
      /^(長|次|三|四|五|六|七|八|九|十)?男$|^(兒子|養子)$/.test(rel)) return "M";
  if (/^(母|母親|養母|妻|妻子|太太|姊|姐|妹|祖母|外祖母|曾祖母|伯母|嬸|姑|姨|舅媽|姪女|外甥女|孫女|外孫女|曾孫女|媳|媳婦)$/.test(rel) ||
      /^(長|次|三|四|五|六|七|八|九|十)?女$|^(女兒|養女)$/.test(rel)) return "F";
  return "";
}
function rocOf(raw) {
  const iso = hhrDate(raw);
  if (!iso) return raw || "";
  const [y, m, d] = iso.split("-").map(Number);
  return y > 1911 ? `${y - 1911}/${m}/${d}` : iso;
}
function maskUid(uid) {
  uid = normUid(uid);
  return uid.length >= 8 ? uid.slice(0, 3) + "*".repeat(uid.length - 6) + uid.slice(-3) : uid;
}

/* ---------- 讀檔 ---------- */
function hhrReadTable(text) { return hhrTableFromRows(hhrCsv(text)); }
/* Excel、PDF 等已拆成儲存格的資料：找出表頭列（含「姓名」的那一列），其上方的標題列略過 */
function hhrTableFromRows(rows) {
  rows = rows.map(r => r.map(v => String(v ?? "")));
  const names = HHR_FIELDS.find(f => f.key === "name").syn;
  const idx = rows.findIndex(r => r.some(v => names.includes(normHeader(v))));
  if (idx < 0) return { headers: rows[0] || [], body: rows.slice(1), headerRow: 1 };
  // 去除完全空白的列（Excel 常有格式殘留的空列）
  const body = rows.slice(idx + 1).filter(r => r.some(v => v.trim()));
  return { headers: rows[idx].map(h => String(h).trim()), body, headerRow: idx + 1 };
}

function hhrGuessMapping(headers) {
  // 「項目」「查看」等為戶役政畫面的序號與操作欄，不對應
  const map = {};
  const norm = headers.map(normHeader);
  const stripped = norm.map(h => h.replace(/\(.*?\)/g, ""));
  for (const f of HHR_FIELDS) {
    let i = norm.findIndex(h => f.syn.includes(h));
    if (i < 0) i = stripped.findIndex(h => f.syn.includes(h));
    if (i >= 0 && !Object.values(map).includes(i)) map[f.key] = i;
  }
  return map;
}

/* 判斷檔案種類：kin 親等關聯、household 戶籍謄本（有記事欄）、personal 個人戶籍、simple 本系統 CSV 格式 */
function hhrGuessKind(headers) {
  const m = hhrGuessMapping(headers);
  if ("memo" in m && "relation" in m) return "household";
  if ("uid" in m && "relation" in m) return "kin";
  if ("uid" in m) return "personal";
  return "simple";
}

/* ---------- 解析 ---------- */
function hhrParse(table, mapping, kind) {
  const errors = [], warnings = [], records = [];
  const fields = HHR_FIELDS.filter(f => f.kinds.includes(kind));
  for (const f of fields) {
    if ((f.required || []).includes(kind) && !(f.key in mapping)) errors.push(`缺少必要欄位：${f.label}`);
  }
  if (errors.length) return { records, anchorUid: null, errors, warnings };

  const seen = new Set();
  table.body.forEach((r, i) => {
    const line = i + table.headerRow + 1;
    const get = k => (k in mapping ? String(r[mapping[k]] ?? "").trim() : "");
    const name = get("name");
    let uid = normUid(get("uid")), noUid = false;
    if (!name && !uid) return;
    if (!name) { warnings.push(`第 ${line} 列（${maskUid(uid)}）沒有姓名，已略過`); return; }
    if (!uid) {
      // 早年死亡者常無統一編號：改以「姓名＋出生日期」識別，跨檔合併時仍可對上
      const b = hhrDate(get("birth")) || get("birth");
      uid = `無統號:${name}:${b || "?"}`; noUid = true;
      warnings.push(`第 ${line} 列（${name}）沒有統一編號，改以姓名與出生日期識別${b ? "" : "（也沒有出生日期，跨檔合併可能不準確）"}`);
    }
    if (seen.has(uid)) { warnings.push(`第 ${line} 列（${name}）統一編號在本檔重複出現，已略過重複列`); return; }
    seen.add(uid);
    const relation = get("relation").replace(/[\s　]/g, "");
    const g = get("gender");
    const gender = /^(男|M|m|1)$/.test(g) ? "M" : /^(女|F|f|2)$/.test(g) ? "F" : genderFromRelation(relation);
    const rec = { line, uid, name, gender, relation, birth: get("birth"), death: get("death"),
      fatherName: get("fatherName"), motherName: get("motherName"), spouseName: get("spouseName"),
      fatherUid: normUid(get("fatherUid")), motherUid: normUid(get("motherUid")), spouseUid: normUid(get("spouseUid")),
      marriageDate: get("marriageDate"), uidNote: noteValue(get("uidNote")), nameNote: noteValue(get("nameNote")), noUid };
    Object.assign(rec, changeAliases(rec.uidNote, rec.nameNote, uid, name));
    if (rec.uidNote === "*") warnings.push(`第 ${line} 列（${name}）統號變更註記為「*」：曾變更統一編號，但匯出檔未載明舊統號；若其他檔案以舊統號記載此人，請人工確認是否為同一人`);
    else if (rec.uidNote) warnings.push(`第 ${line} 列（${name}）有統號變更註記：「${rec.uidNote}」${rec.uidAliases.length ? "，舊統號已列入合併比對" : "，請人工確認"}`);
    if (rec.nameNote === "*") warnings.push(`第 ${line} 列（${name}）姓名變更註記為「*」：曾變更姓名，但匯出檔未載明舊名；子女資料中的父母姓名若對不上，請調閱個人戶籍資料確認舊名`);
    else if (rec.nameNote) warnings.push(`第 ${line} 列（${name}）有姓名變更註記：「${rec.nameNote}」${rec.nameAliases.length ? `，曾用名「${rec.nameAliases.join("、")}」已列入父母姓名比對` : "，請人工確認父母姓名比對"}`);
    // 謄本記事：抽出死亡、更名、結婚、離婚；與欄位已填的資料不同時以欄位為準並提示
    const memo = get("memo");
    rec.memo = memo; rec.marriageEnd = get("marriageEnd");
    if (memo) {
      const ev = parseMemo(memo);
      const at = `第 ${line} 列（${name}）記事`;
      if (ev.death) {
        if (!rec.death) rec.death = ev.death;
        else if (hhrDate(rec.death) !== hhrDate(ev.death)) warnings.push(`${at}的死亡日期（${ev.death}）與死亡日期欄（${rec.death}）不同，以欄位為準，請確認`);
      }
      if (ev.deathDeclared) warnings.push(`${at}有死亡宣告：死亡日期應為判決所定的死亡時間${ev.death ? `（已讀到 ${ev.death}）` : "，記事中未讀到，請人工填寫"}，請確認`);
      for (const n of ev.oldNames) if (n !== name && !rec.nameAliases.includes(n)) rec.nameAliases.push(n);
      if (ev.oldNames.length && !rec.nameNote) rec.nameNote = `原名${ev.oldNames.join("、")}`;
      const lastMar = ev.marriages[ev.marriages.length - 1];
      if (lastMar) {
        if (!rec.spouseName) rec.spouseName = lastMar.name;
        if (!rec.marriageDate && rec.spouseName === lastMar.name) rec.marriageDate = lastMar.date;
      }
      const div = ev.divorces.find(d => !rec.spouseName || d.name === rec.spouseName);
      if (div && !rec.marriageEnd && !ev.marriages.some(m => m.name === div.name && hhrDate(m.date) > hhrDate(div.date))) {
        rec.marriageEnd = div.date;
        warnings.push(`${at}：已與${div.name}離婚（${div.date}），該配偶對離婚後開始的繼承無繼承權`);
      }
      if (ev.marriages.length + ev.divorces.length > 1) warnings.push(`${at}有多次結婚或離婚紀錄，本系統只處理一段婚姻，請確認配偶欄填的是繼承開始時的配偶`);
      if (ev.adoption) warnings.push(`${at}有收養紀錄（${ev.notes.filter(x => /收養/.test(x)).join("；")}），請確認父、母欄填的是養父母或本生父母；被收養者對本生父母無繼承權`);
      const other = ev.notes.filter(x => !/收養|死亡宣告/.test(x));
      if (other.length) warnings.push(`${at}有其他事項，請人工確認是否影響繼承：${other.join("；")}`);
    }
    for (const [k, label] of [["birth", "出生日期"], ["death", "死亡日期"], ["marriageDate", "結婚日期"], ["marriageEnd", "離婚日期"]]) {
      if (rec[k] && hhrDate(rec[k]) === undefined) warnings.push(`第 ${line} 列（${name}）${label}「${rec[k]}」格式無法辨識，匯入後請修正`);
    }
    records.push(rec);
  });

  let anchorUid = null;
  if (kind === "household") {
    const head = records.find(r => /^戶長$/.test(r.relation)) || records.find(r => REL.self.test(r.relation));
    if (!head) errors.push("找不到稱謂為「戶長」的人，無法判斷戶內其他人與戶長的關係");
    else anchorUid = head.uid;
  }
  if (kind === "kin") {
    const selves = records.filter(r => REL.self.test(r.relation));
    if (!selves.length) errors.push("找不到稱謂為「自己」（或「本人」）的列，無法判斷其他人與被查詢人的關係");
    else {
      anchorUid = selves[0].uid;
      if (selves.length > 1) warnings.push(`有 ${selves.length} 列稱謂為「自己」／「本人」，以第一列（${selves[0].name}）為本人`);
    }
    const unknown = [...new Set(records.map(r => r.relation).filter(r => r && !Object.values(REL).some(re => re.test(r))))];
    if (unknown.length) warnings.push(`以下稱謂改依父母姓名判斷關係：${unknown.join("、")}`);
  }
  if (!records.length) errors.push("檔案中沒有可匯入的資料列");
  return { records, anchorUid, errors, warnings };
}

/* ---------- 合併（以統一編號為準） ---------- */
function hhrMerge(persons, parsed, fileName, makeId) {
  const conflicts = [];
  let added = 0, updated = 0;
  const LABEL = { name: "姓名", gender: "性別", birthRaw: "出生日期", deathRaw: "死亡日期",
    fatherName: "父姓名", motherName: "母姓名", spouseName: "配偶姓名", marriageDateRaw: "結婚日期", marriageEndRaw: "離婚日期" };
  const same = (a, b) => (hhrDate(a) || a) === (hhrDate(b) || b);
  const keysOf = x => [normUid(x.uid), x.mergeKey, ...(x.uidAliases || [])].filter(Boolean);
  for (const rec of parsed.records) {
    const want = [rec.uid, ...rec.uidAliases];
    let p = persons.find(x => keysOf(x).some(k => want.includes(k)));
    const isNew = !p;
    if (!p) {
      const id = rec.noUid ? makeId() : (persons.some(x => x.id === rec.uid) ? makeId() : rec.uid);
      p = { id, uid: rec.noUid ? "" : rec.uid, mergeKey: rec.noUid ? rec.uid : "", name: "", title: "", titleAuto: true,
        gender: "", birthRaw: "", deathRaw: "", father: "", mother: "", spouse: "",
        fatherName: "", motherName: "", spouseName: "", fatherUid: "", motherUid: "", spouseUid: "",
        renounceChecks: {}, lost_right: [], sources: [], uidAliases: [], nameAliases: [], changeNotes: [] };
      persons.push(p); added++;
    }
    for (const u of rec.uidAliases) if (!(p.uidAliases ||= []).includes(u)) p.uidAliases.push(u);
    for (const n of rec.nameAliases) if (!(p.nameAliases ||= []).includes(n)) p.nameAliases.push(n);
    for (const t of [rec.uidNote && `統號變更：${rec.uidNote === "*" ? "有（匯出檔未載明）" : rec.uidNote}`, rec.nameNote && `姓名變更：${rec.nameNote === "*" ? "有（匯出檔未載明）" : rec.nameNote}`].filter(Boolean)) {
      if (!(p.changeNotes ||= []).includes(t)) p.changeNotes.push(t);
    }
    const incoming = { name: rec.name, gender: rec.gender, birthRaw: rocOf(rec.birth), deathRaw: rocOf(rec.death),
      fatherName: rec.fatherName, motherName: rec.motherName, spouseName: rec.spouseName,
      fatherUid: rec.fatherUid, motherUid: rec.motherUid, spouseUid: rec.spouseUid, marriageDateRaw: rocOf(rec.marriageDate),
      marriageEndRaw: rocOf(rec.marriageEnd || "") };
    let changed = false;
    for (const [k, v] of Object.entries(incoming)) {
      if (!v) continue;
      if (!p[k]) { p[k] = v; changed = true; }
      else if (!same(p[k], v) && LABEL[k]) {
        conflicts.push(`${p.name || rec.name}（${maskUid(rec.uid)}）的${LABEL[k]}不一致：原有「${p[k]}」，${fileName} 為「${v}」，暫保留原有資料，請確認`);
      }
    }
    if (!(p.sources ||= []).includes(fileName)) p.sources.push(fileName);
    if (changed && !isNew) updated++;
  }
  return { added, updated, conflicts };
}

/* ---------- 串聯親屬關係 ---------- */
// files：[{ name, kind, anchor, rels: [{uid, relation}] }]
function hhrLink(persons, files) {
  const warnings = [];
  const byUid = {}, byId = {}, byName = {};
  for (const p of persons) {
    byId[p.id] = p;
    for (const k of [normUid(p.uid), p.mergeKey, ...(p.uidAliases || [])].filter(Boolean)) byUid[k] = p;
    for (const n of [p.name, ...(p.nameAliases || [])].filter(Boolean)) if (!(byName[n] ||= []).includes(p)) byName[n].push(p);
  }
  const birthOf = p => hhrDate(p.birthRaw) || "";
  const label = p => `${p.name}（${maskUid(p.uid)}）`;
  const setParent = (child, rel, parent) => {
    if (!child || !parent || child === parent || child[rel] === parent.id) return;
    if (child[rel]) {
      warnings.push(`${label(child)}的${rel === "father" ? "父" : "母"}已設為 ${byId[child[rel]]?.name || "其他人"}，與資料中的 ${parent.name} 不同，請確認`);
      return;
    }
    child[rel] = parent.id;
  };
  const setSpouse = (a, b) => {
    if (!a || !b || a === b) return;
    if (a.spouse && a.spouse !== b.id) { warnings.push(`${label(a)}的配偶已設為 ${byId[a.spouse]?.name}，與資料中的 ${b.name} 不同，請確認`); return; }
    if (b.spouse && b.spouse !== a.id) { warnings.push(`${label(b)}的配偶已設為 ${byId[b.spouse]?.name}，與資料中的 ${a.name} 不同，請確認`); return; }
    a.spouse = b.id; b.spouse = a.id;
  };

  // 補性別：被指為父者為男、為母者為女（戶役政匯出檔常無性別欄）
  const inferGender = () => {
    for (const p of persons) {
      const f = byId[p.father], m = byId[p.mother];
      if (f && !f.gender) f.gender = "M";
      if (m && !m.gender) m.gender = "F";
    }
  };

  // 1. 統一編號直接指定
  for (const p of persons) {
    if (p.fatherUid && byUid[p.fatherUid]) setParent(p, "father", byUid[p.fatherUid]);
    if (p.motherUid && byUid[p.motherUid]) setParent(p, "mother", byUid[p.motherUid]);
    if (p.spouseUid && byUid[p.spouseUid]) setSpouse(p, byUid[p.spouseUid]);
  }

  inferGender();

  // 2. 親等關聯資料：依稱謂與本人的關係
  for (const f of files.filter(f => f.kind === "kin" || f.kind === "household")) {
    const A = byUid[f.anchor];
    if (!A) continue;
    for (const { uid, relation } of f.rels) {
      const R = byUid[uid];
      if (!R || R === A) continue;
      if (REL.father.test(relation)) setParent(A, "father", R);
      else if (REL.mother.test(relation)) setParent(A, "mother", R);
      else if (REL.spouse.test(relation)) setSpouse(A, R);
      else if (REL.child.test(relation)) {
        const rel = R.fatherName && R.fatherName === A.name ? "father"
          : R.motherName && R.motherName === A.name ? "mother"
          : A.gender === "M" ? "father" : A.gender === "F" ? "mother" : null;
        if (rel) setParent(R, rel, A);
        else warnings.push(`無法判斷 ${A.name} 是 ${R.name} 的父或母（缺少性別），請手動設定`);
      }
    }
  }

  // 3. 依姓名配對其餘關係（優先同一份檔案中的人）
  const shareFile = (a, b) => (a.sources || []).some(s => (b.sources || []).includes(s));
  const pick = (p, cands) => {
    if (cands.length <= 1) return cands;
    const near = cands.filter(c => shareFile(p, c));
    return near.length ? near : cands;
  };
  for (const p of persons) {
    for (const rel of ["father", "mother"]) {
      const nm = p[rel + "Name"];
      if (p[rel] || !nm) continue;
      let cands = (byName[nm] || []).filter(c => c !== p &&
        (rel === "father" ? c.gender !== "F" : c.gender !== "M") &&
        !(birthOf(c) && birthOf(p) && birthOf(c) >= birthOf(p)));
      cands = pick(p, cands);
      if (cands.length === 1) setParent(p, rel, cands[0]);
      else if (cands.length > 1) warnings.push(`${label(p)}的${rel === "father" ? "父" : "母"}「${nm}」有 ${cands.length} 位同名者，請手動指定`);
    }
    if (!p.spouse && p.spouseName) {
      let cands = (byName[p.spouseName] || []).filter(c => c !== p && (!c.spouse || c.spouse === p.id) &&
        (!c.spouseName || c.spouseName === p.name));
      cands = pick(p, cands);
      if (cands.length === 1) setSpouse(p, cands[0]);
      else if (cands.length > 1) warnings.push(`${label(p)}的配偶「${p.spouseName}」有 ${cands.length} 位同名者，請手動指定`);
    }
  }

  // 4. 一致性檢查：已連結的父母姓名與資料記載不同
  for (const p of persons) {
    for (const rel of ["father", "mother"]) {
      const q = byId[p[rel]], nm = p[rel + "Name"];
      if (q && nm && q.name !== nm && !(q.nameAliases || []).includes(nm)) warnings.push(`${label(p)}的${rel === "father" ? "父" : "母"}連結為 ${q.name}，但戶籍記載為「${nm}」${(q.changeNotes || []).some(t => t.startsWith("姓名變更")) ? `（${q.name}有姓名變更註記，「${nm}」可能是改名前的舊名）` : ""}，請確認`);
    }
  }
  inferGender();
  return { warnings: [...new Set(warnings)] };
}

if (typeof module !== "undefined") module.exports = { HHR_IGNORED, changeAliases, noteValue, parseMemo, HHR_FIELDS, hhrReadTable, hhrTableFromRows, hhrGuessMapping, hhrGuessKind, hhrParse, hhrMerge, hhrLink, maskUid, normUid };
