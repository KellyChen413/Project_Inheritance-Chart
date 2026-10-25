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
  { key: "relation",   label: "稱謂（相對於本人）", kinds: ["kin"], required: ["kin"],
    syn: ["稱謂", "關係", "親屬關係", "與本人關係", "親等關係", "稱謂關係", "與查詢人關係"] },
  { key: "name",       label: "姓名", kinds: ["kin", "personal"], required: ["kin", "personal"],
    syn: ["姓名", "名字", "本人姓名", "親屬姓名"] },
  { key: "uid",        label: "統一編號", kinds: ["kin", "personal"], required: ["kin", "personal"],
    syn: ["統一編號", "身分證統一編號", "國民身分證統一編號", "身分證字號", "身分證號", "身分證號碼", "統號", "本人統一編號", "親屬統一編號"] },
  { key: "gender",     label: "性別", kinds: ["kin", "personal"], syn: ["性別"] },
  { key: "birth",      label: "出生日期", kinds: ["kin", "personal"], syn: ["出生日期", "出生年月日", "生日", "出生", "出生日"] },
  { key: "death",      label: "死亡日期", kinds: ["kin", "personal"], syn: ["死亡日期", "死亡年月日", "死亡", "死亡日", "死亡(宣告)日期"] },
  { key: "fatherName", label: "父姓名", kinds: ["kin", "personal"], syn: ["父姓名", "父親姓名", "父", "父親"] },
  { key: "motherName", label: "母姓名", kinds: ["kin", "personal"], syn: ["母姓名", "母親姓名", "母", "母親"] },
  { key: "spouseName", label: "配偶姓名", kinds: ["kin", "personal"], syn: ["配偶姓名", "配偶", "配偶名"] },
  { key: "fatherUid",  label: "父統一編號", kinds: ["kin", "personal"], syn: ["父統一編號", "父親統一編號", "父身分證統一編號", "父身分證字號"] },
  { key: "motherUid",  label: "母統一編號", kinds: ["kin", "personal"], syn: ["母統一編號", "母親統一編號", "母身分證統一編號", "母身分證字號"] },
  { key: "spouseUid",  label: "配偶統一編號", kinds: ["kin", "personal"], syn: ["配偶統一編號", "配偶身分證統一編號", "配偶身分證字號"] },
];

const normHeader = h => String(h || "").replace(/[\s　]/g, "").replace(/（/g, "(").replace(/）/g, ")");
const normUid = u => String(u || "").replace(/[\s　]/g, "").toUpperCase();

/* 稱謂分類（相對於本人） */
const REL = {
  self:    /^本人$/,
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
function hhrReadTable(text) {
  const rows = hhrCsv(text);
  const names = HHR_FIELDS.find(f => f.key === "name").syn;
  const idx = rows.findIndex(r => r.some(v => names.includes(normHeader(v))));
  if (idx < 0) return { headers: rows[0] || [], body: rows.slice(1), headerRow: 1 };
  return { headers: rows[idx].map(h => String(h).trim()), body: rows.slice(idx + 1), headerRow: idx + 1 };
}

function hhrGuessMapping(headers) {
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

/* 判斷檔案種類：kin 親等關聯、personal 個人戶籍、simple 本系統 CSV 格式 */
function hhrGuessKind(headers) {
  const m = hhrGuessMapping(headers);
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
    const name = get("name"), uid = normUid(get("uid"));
    if (!name && !uid) return;
    if (!uid) { warnings.push(`第 ${line} 列（${name}）沒有統一編號，已略過`); return; }
    if (!name) { warnings.push(`第 ${line} 列（${maskUid(uid)}）沒有姓名，已略過`); return; }
    if (seen.has(uid)) { warnings.push(`第 ${line} 列（${name}）統一編號在本檔重複出現，已略過重複列`); return; }
    seen.add(uid);
    const relation = get("relation").replace(/[\s　]/g, "");
    const g = get("gender");
    const gender = /^(男|M|m|1)$/.test(g) ? "M" : /^(女|F|f|2)$/.test(g) ? "F" : genderFromRelation(relation);
    const rec = { line, uid, name, gender, relation, birth: get("birth"), death: get("death"),
      fatherName: get("fatherName"), motherName: get("motherName"), spouseName: get("spouseName"),
      fatherUid: normUid(get("fatherUid")), motherUid: normUid(get("motherUid")), spouseUid: normUid(get("spouseUid")) };
    for (const [k, label] of [["birth", "出生日期"], ["death", "死亡日期"]]) {
      if (rec[k] && hhrDate(rec[k]) === undefined) warnings.push(`第 ${line} 列（${name}）${label}「${rec[k]}」格式無法辨識，匯入後請修正`);
    }
    records.push(rec);
  });

  let anchorUid = null;
  if (kind === "kin") {
    const selves = records.filter(r => REL.self.test(r.relation));
    if (!selves.length) errors.push("找不到稱謂為「本人」的列，無法判斷其他人與本人的關係");
    else {
      anchorUid = selves[0].uid;
      if (selves.length > 1) warnings.push(`有 ${selves.length} 列稱謂為「本人」，以第一列（${selves[0].name}）為本人`);
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
    fatherName: "父姓名", motherName: "母姓名", spouseName: "配偶姓名" };
  const same = (a, b) => (hhrDate(a) || a) === (hhrDate(b) || b);
  for (const rec of parsed.records) {
    let p = persons.find(x => normUid(x.uid) === rec.uid);
    if (!p) {
      p = { id: persons.some(x => x.id === rec.uid) ? makeId() : rec.uid, uid: rec.uid, name: "", title: "", titleAuto: true,
        gender: "", birthRaw: "", deathRaw: "", father: "", mother: "", spouse: "",
        fatherName: "", motherName: "", spouseName: "", fatherUid: "", motherUid: "", spouseUid: "",
        renounceChecks: {}, lost_right: [], sources: [] };
      persons.push(p); added++;
    }
    const incoming = { name: rec.name, gender: rec.gender, birthRaw: rocOf(rec.birth), deathRaw: rocOf(rec.death),
      fatherName: rec.fatherName, motherName: rec.motherName, spouseName: rec.spouseName,
      fatherUid: rec.fatherUid, motherUid: rec.motherUid, spouseUid: rec.spouseUid };
    let changed = false;
    for (const [k, v] of Object.entries(incoming)) {
      if (!v) continue;
      if (!p[k]) { p[k] = v; changed = true; }
      else if (!same(p[k], v) && LABEL[k]) {
        conflicts.push(`${p.name || rec.name}（${maskUid(rec.uid)}）的${LABEL[k]}不一致：原有「${p[k]}」，${fileName} 為「${v}」，暫保留原有資料，請確認`);
      }
    }
    if (!(p.sources ||= []).includes(fileName)) p.sources.push(fileName);
    if (changed && added === 0) updated++;
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
    if (p.uid) byUid[normUid(p.uid)] = p;
    if (p.name) (byName[p.name] ||= []).push(p);
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

  // 1. 統一編號直接指定
  for (const p of persons) {
    if (p.fatherUid && byUid[p.fatherUid]) setParent(p, "father", byUid[p.fatherUid]);
    if (p.motherUid && byUid[p.motherUid]) setParent(p, "mother", byUid[p.motherUid]);
    if (p.spouseUid && byUid[p.spouseUid]) setSpouse(p, byUid[p.spouseUid]);
  }

  // 2. 親等關聯資料：依稱謂與本人的關係
  for (const f of files.filter(f => f.kind === "kin")) {
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
      if (q && nm && q.name !== nm) warnings.push(`${label(p)}的${rel === "father" ? "父" : "母"}連結為 ${q.name}，但戶籍記載為「${nm}」，請確認`);
    }
  }
  return { warnings: [...new Set(warnings)] };
}

if (typeof module !== "undefined") module.exports = { HHR_FIELDS, hhrReadTable, hhrGuessMapping, hhrGuessKind, hhrParse, hhrMerge, hhrLink, maskUid, normUid };
