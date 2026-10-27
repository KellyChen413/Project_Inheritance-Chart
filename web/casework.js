/* ============================================================
 * 承辦作業輔助
 * - autoTitles：依被繼承人換算稱謂（戶籍資料的稱謂是相對於各檔的「本人」）
 * - followUps：判斷還需要往下調閱誰的資料
 * - renounceItems：需查證拋棄繼承的人員清單
 * 純運算，不連網。
 * ============================================================ */
"use strict";

const { parseDate: cwDate } = typeof parseDate === "function" ? { parseDate } : require("./engine.js");

const ORD = ["長", "次", "三", "四", "五", "六", "七", "八", "九", "十"];

/* persons：介面資料（birthRaw）或引擎資料（birth）皆可 */
function autoTitles(persons, decId) {
  const T = {};
  const byId = Object.fromEntries(persons.map(p => [p.id, p]));
  const dec = byId[decId];
  if (!dec) return T;
  const birth = p => p.birth || cwDate(p.birthRaw) || "";
  const kids = id => persons.filter(x => x.father === id || x.mother === id).sort((a, b) => birth(a).localeCompare(birth(b)));
  const set = (p, t) => { if (p && t && !T[p.id]) T[p.id] = t; };

  set(dec, "被繼承人");
  set(byId[dec.spouse], "配偶");
  const fa = byId[dec.father], mo = byId[dec.mother];
  set(fa, "父"); set(mo, "母");
  if (fa) { set(byId[fa.father], "祖父"); set(byId[fa.mother], "祖母"); }
  if (mo) { set(byId[mo.father], "外祖父"); set(byId[mo.mother], "外祖母"); }

  // 子女與孫輩
  const children = kids(dec.id);
  const count = { M: 0, F: 0 };
  for (const c of children) {
    if (c.gender === "M" || c.gender === "F") set(c, `${ORD[count[c.gender]++] || ""}${c.gender === "M" ? "男" : "女"}`);
    else set(c, "子女");
  }
  for (const c of children) {
    const viaSon = c.gender === "M";
    for (const g of kids(c.id)) {
      set(g, g.gender === "M" ? (viaSon ? "孫" : "外孫") : g.gender === "F" ? (viaSon ? "孫女" : "外孫女") : "孫子女");
      for (const gg of kids(g.id)) set(gg, `${viaSon ? "" : "外"}曾孫${gg.gender === "F" ? "女" : ""}`);
    }
  }

  // 兄弟姊妹及其子女
  const parents = [dec.father, dec.mother].filter(Boolean);
  const sibs = persons.filter(x => x.id !== dec.id && [x.father, x.mother].some(v => v && parents.includes(v)));
  for (const s of sibs) {
    const older = birth(s) && birth(dec) ? birth(s) < birth(dec) : null;
    set(s, s.gender === "M" ? (older === null ? "兄弟" : older ? "兄" : "弟")
      : s.gender === "F" ? (older === null ? "姊妹" : older ? "姊" : "妹") : "兄弟姊妹");
    for (const n of kids(s.id)) set(n, s.gender === "F" ? `外甥${n.gender === "F" ? "女" : ""}` : `姪${n.gender === "F" ? "女" : ""}`);
  }

  // 已有稱謂者的配偶
  for (const p of persons) {
    if (T[p.id] || !p.spouse || !T[p.spouse] || p.spouse === decId) continue;
    T[p.id] = `${T[p.spouse]}之配偶`;
  }
  return T;
}

/* 待調閱清單
 * fam：引擎 Family；result：計算結果；queried：已調閱親等資料（或已確認）之人員 id
 * 回傳 [{ level: "必要"|"建議", pid, text }]
 */
function followUps(fam, result, queried) {
  const out = [], seen = new Set();
  const add = (level, pid, text) => { const k = pid + text; if (!seen.has(k)) { seen.add(k); out.push({ level, pid, text }); } };
  const nm = id => fam.p[id]?.name || id;
  const did = result.decedentId;
  const isDesc = (pid, root) => { const p = fam.p[pid]; return !!p && [p.father, p.mother].some(x => x && (x === root || isDesc(x, root))); };

  if (!queried.has(did)) add("必要", did, `尚未匯入被繼承人${nm(did)}本人的親等關聯資料，請先調閱，以確認配偶、子女、父母及兄弟姊妹。`);

  const walk = (res, isSub) => {
    const subName = isSub ? `（${nm(res.decedentId)}之再轉繼承部分）` : "";
    for (const [pid, note] of Object.entries(res.notes)) {
      if (!["繼承開始前死亡", "喪失繼承權"].includes(note) || !isDesc(pid, res.decedentId) || queried.has(pid)) continue;
      const reps = res.represents[pid];
      if (!reps) add("必要", pid, `${nm(pid)}${note === "喪失繼承權" ? "喪失繼承權" : "於繼承開始前死亡"}，資料中查無其直系血親卑親屬${subName}。請調閱${nm(pid)}的二親等資料，確認有無代位繼承人。`);
      else add("建議", pid, `${nm(pid)}${note === "喪失繼承權" ? "喪失繼承權" : "於繼承開始前死亡"}，目前由 ${reps.map(nm).join("、")} 代位繼承${subName}。如需確認子女是否完整，可調閱${nm(pid)}的二親等或個人戶籍資料。`);
    }
    for (const [hid, sub] of Object.entries(res.retransfers)) {
      if (!queried.has(hid)) add("必要", hid, `${nm(hid)}於繼承開始後死亡（再轉繼承）。請調閱${nm(hid)}的二親等資料，確認其配偶、子女等繼承人${sub.shares.length ? `（目前資料中有：${sub.shares.map(s => nm(s.id)).join("、")}）` : ""}。`);
      walk(sub, true);
    }
  };
  walk(result, false);

  // 無第一順序時，父母的存歿必須確認
  const dec = fam.p[did];
  if (result.order !== "第一順序") {
    for (const [rel, label] of [["father", "父"], ["mother", "母"]]) {
      if (!dec[rel] && dec[rel + "Name"]) add("必要", did, `無第一順序繼承人，需確認被繼承人之${label}${dec[rel + "Name"]}的存歿，但此人不在資料中。請調閱其個人戶籍資料。`);
    }
  }
  // 變更註記為「*」：曾變更統號或姓名，但匯出檔未載明舊資料
  for (const p of Object.values(fam.p)) {
    const vague = (p.changeNotes || []).filter(t => t.includes("未載明"));
    if (vague.length) add("建議", p.id, `${p.name}有${vague.map(t => t.split("：")[0]).join("、")}註記（匯出檔未載明舊資料）。若其他資料以舊名或舊統號記載此人，系統無法自動比對，請調閱個人戶籍資料確認，避免同一人被當成兩個人。`);
  }
  return out;
}

/* 需查證拋棄繼承的人：各層繼承人中，繼承開始時生存者
 * 回傳 [{ pid, target }]，target 為該層被繼承人（原被繼承人或再轉被繼承人）
 */
function renounceItems(fam, result) {
  const out = [], seen = new Set();
  const walk = res => {
    for (const s of res.shares) {
      if (res.retransfers[s.id]) continue;            // 繼承開始後死亡者，由其繼承人處理
      const k = `${s.id}|${res.decedentId}`;
      if (!seen.has(k)) { seen.add(k); out.push({ pid: s.id, target: res.decedentId }); }
    }
    Object.values(res.retransfers).forEach(walk);
  };
  walk(result);
  return out;
}

if (typeof module !== "undefined") module.exports = { autoTitles, followUps, renounceItems };
