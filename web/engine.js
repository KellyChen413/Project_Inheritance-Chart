/* ============================================================
 * 民法繼承規則引擎（JavaScript 版，與 Python 版 engine.py 邏輯一致）
 * 第1138、1139、1140、1144、1176條，第11條同時死亡推定，再轉繼承
 * 純運算，不讀寫檔案、不連網。
 * ============================================================ */
"use strict";

/* ---------- 分數 ---------- */
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }
class Frac {
  constructor(n, d = 1) {
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g; this.d = d / g;
  }
  add(o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Frac(this.n * o.n, this.d * o.d); }
  div(k) { return new Frac(this.n, this.d * k); }
  eq(o) { return this.n === o.n && this.d === o.d; }
  toString() { return this.d === 1 ? String(this.n) : `${this.n}/${this.d}`; }
}
const ONE = new Frac(1), ZERO = new Frac(0);

/* ---------- 日期 ---------- */
// 接受西元 2025-03-10 / 2025/3/10，或民國 114/3/10、114.3.10、114-3-10
function parseDate(s) {
  if (s === null || s === undefined) return null;
  s = String(s).trim();
  if (!s) return null;
  // 純數字：戶政系統常見的民國 7 碼（0370512、1140310），或西元 8 碼（19480512）
  const digits = s.match(/^(\d{5,8})$/);
  if (digits) {
    const v = digits[1];
    s = v.length === 8 && /^(18|19|20)/.test(v) ? `${v.slice(0, 4)}/${v.slice(4, 6)}/${v.slice(6)}`
      : v.length <= 7 ? `${v.slice(0, -4)}/${v.slice(-4, -2)}/${v.slice(-2)}` : s;
  }
  const m = s.match(/^(?:民國)?\s*(\d{1,4})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})\s*日?$/);
  if (!m) return undefined;                          // undefined = 格式錯誤
  let y = +m[1]; const mo = +m[2], d = +m[3];
  if (y < 1000) y += 1911;                           // 民國年
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;   // ISO 字串可直接比大小
}
function roc(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return y > 1911 ? `民國${y - 1911}年${m}月${d}日` : `民國前${1912 - y}年${m}月${d}日`;
}

/* ---------- 家族 ---------- */
class Family {
  constructor(persons) {
    this.p = {};
    for (const x of persons) {
      this.p[x.id] = Object.assign({ title: "", gender: "", birth: null, death: null, father: null,
        mother: null, spouse: null, renounced: [], lost_right: [] }, x);
    }
    for (const x of Object.values(this.p)) {          // 配偶雙向補齊
      if (x.spouse && this.p[x.spouse] && !this.p[x.spouse].spouse) this.p[x.spouse].spouse = x.id;
    }
  }
  byBirth(list) { return list.slice().sort((a, b) => (a.birth || "").localeCompare(b.birth || "")); }
  children(id) { return this.byBirth(Object.values(this.p).filter(x => x.father === id || x.mother === id)); }
  parents(id) { const me = this.p[id]; return [me.father, me.mother].filter(i => i && this.p[i]).map(i => this.p[i]); }
  siblings(id) {
    const mine = [this.p[id].father, this.p[id].mother].filter(Boolean);
    return this.byBirth(Object.values(this.p).filter(x => x.id !== id &&
      [x.father, x.mother].some(v => v && mine.includes(v))));
  }
  grandparents(id) { return this.parents(id).flatMap(par => this.parents(par.id)); }
}

/* ---------- 規則引擎 ---------- */
class InheritanceEngine {
  constructor(family) { this.f = family; }

  static aliveAt(p, d) {
    const born = !p.birth || p.birth <= d;
    return born && (!p.death || p.death > d);        // 同日死亡 → 推定同時死亡，不繼承
  }
  eligible(p, did, d) {
    return InheritanceEngine.aliveAt(p, d) && !p.renounced.includes(did) && !p.lost_right.includes(did);
  }
  reason(p, did, d) {
    if (p.renounced.includes(did)) return "拋棄繼承";
    if (!InheritanceEngine.aliveAt(p, d)) return p.death && p.death <= d ? "繼承開始前死亡" : "繼承開始時尚未出生";
    if (p.lost_right.includes(did)) return "喪失繼承權";
    return "";
  }

  distribute(did, openedOn = null, depth = 0) {
    if (depth > 10) throw new Error("再轉繼承層數過深，請檢查資料");
    const f = this.f, dec = f.p[did];
    const d = openedOn || dec.death;
    if (!d) throw new Error(`${dec.name} 沒有死亡日期，無法開始繼承`);
    const notes = {}, log = [], represents = {};
    log.push(`【${dec.name}】繼承開始日：${roc(d)}`);

    // 第一順序（含代位）
    const branch = (pid, represented = null) => {
      const p = f.p[pid];
      if (p.birth && p.birth > d) return [];
      if (p.renounced.includes(did)) {
        notes[pid] = "拋棄繼承";
        log.push(`${p.name}：拋棄繼承（第1176條），不發生代位，其應繼分歸屬其他同順序繼承人`);
        return [];
      }
      if (this.eligible(p, did, d)) {
        return [{ id: pid, w: ONE,
          basis: represented ? `第1140條 代位繼承（代位${represented}）` : "第1138條 第一順序 直系血親卑親屬",
          short: represented ? `代位繼承（代位${represented}）` : "本位繼承" }];
      }
      const why = p.lost_right.includes(did) ? "喪失繼承權" : "繼承開始前死亡";
      notes[pid] = why;
      const subs = f.children(pid).map(k => branch(k.id, p.name)).filter(b => b.length);
      log.push(subs.length
        ? `${p.name}：${why}，由其直系血親卑親屬代位繼承（第1140條）`
        : `${p.name}：${why}，且無可代位之直系血親卑親屬`);
      if (!subs.length) return [];
      represents[pid] = [...new Set(subs.flat().map(h => h.id))];   // 記錄由誰代位
      return subs.flatMap(sub => sub.map(h => ({ ...h, w: h.w.div(subs.length) })));
    };

    let branches = [], level = f.children(did), firstDegree = true;
    while (level.length && !branches.length) {
      branches = level.map(c => branch(c.id)).filter(b => b.length);
      if (branches.length && !firstDegree) {
        log.push("第一順序親等近者均無法繼承，由次親等直系血親卑親屬繼承（第1176條第5項）");
        branches = branches.map(b => b.map(h => ({ ...h,
          basis: "第1176條第5項 次親等直系血親卑親屬繼承", short: "次親等繼承" })));
      }
      if (!branches.length) { level = level.flatMap(c => f.children(c.id)); firstDegree = false; }
    }

    // 配偶
    const sp = dec.spouse ? f.p[dec.spouse] : null;
    const spouseOk = !!(sp && this.eligible(sp, did, d));
    if (sp && !spouseOk) { notes[sp.id] = this.reason(sp, did, d); log.push(`配偶${sp.name}：${notes[sp.id]}`); }

    const shares = [];
    let order;
    if (branches.length) {
      order = "第一順序";
      const units = branches.length + (spouseOk ? 1 : 0);
      log.push(`第一順序共 ${branches.length} 房${spouseOk ? "，與配偶平均" : ""}，每份 1/${units}（第1144條第1款）`);
      for (const b of branches) for (const h of b) shares.push({ id: h.id, share: h.w.div(units), basis: h.basis, short: h.short });
      if (spouseOk) shares.push({ id: sp.id, share: new Frac(1, units), basis: "第1144條第1款 配偶與第一順序平均", short: "第1144條 配偶" });
      for (const x of [...f.parents(did), ...f.siblings(did), ...f.grandparents(did)]) {
        if (!(x.id in notes)) notes[x.id] = InheritanceEngine.aliveAt(x, d) ? "有第一順序繼承人，不繼承" : this.reason(x, did, d);
      }
    } else {
      const groups = [
        ["第二順序", f.parents(did), new Frac(1, 2), "第1138條 第二順序 父母", "第二順序 父母", "第2款"],
        ["第三順序", f.siblings(did), new Frac(1, 2), "第1138條 第三順序 兄弟姊妹", "第三順序 兄弟姊妹", "第2款"],
        ["第四順序", f.grandparents(did), new Frac(2, 3), "第1138條 第四順序 祖父母", "第四順序 祖父母", "第3款"],
      ];
      let chosen = null;
      for (const [name, group, spPart, basis, short, art] of groups) {
        const ok = [];
        for (const x of group) {
          if (this.eligible(x, did, d)) ok.push(x);
          else if (!(x.id in notes)) notes[x.id] = this.reason(x, did, d);
        }
        if (ok.length) { chosen = { name, ok, spPart, basis, short, art }; break; }
        if (group.length) log.push(`${name}無可繼承之人`);
      }
      if (chosen) {
        order = chosen.name;
        const rest = spouseOk ? ONE.sub(chosen.spPart) : ONE;
        for (const x of chosen.ok) shares.push({ id: x.id, share: rest.div(chosen.ok.length), basis: chosen.basis, short: chosen.short });
        if (spouseOk) shares.push({ id: sp.id, share: chosen.spPart, basis: `第1144條${chosen.art} 配偶`, short: "第1144條 配偶" });
        log.push(`由${order}繼承${spouseOk ? `，配偶應繼分 ${chosen.spPart}` : ""}`);
      } else if (spouseOk) {
        order = "僅配偶";
        shares.push({ id: sp.id, share: ONE, basis: "第1144條第4款 無其他順序繼承人", short: "配偶（全部）" });
        log.push("無其他順序繼承人，配偶取得全部（第1144條第4款）");
      } else {
        order = "無人承受（第1177條）";
        log.push("無任何繼承人，屬無人承受之遺產（第1177條）");
      }
    }

    const result = { decedentId: did, openedOn: d, order, shares, notes, log, represents, retransfers: {} };

    // 再轉繼承
    for (const s of shares) {
      const heir = f.p[s.id];
      if (heir.death && heir.death > d) {
        log.push(`${heir.name}：於繼承開始後死亡（${roc(heir.death)}），其應繼分 ${s.share} 由其繼承人再轉繼承`);
        result.retransfers[heir.id] = this.distribute(heir.id, heir.death, depth + 1);
      }
    }

    const total = shares.reduce((a, s) => a.add(s.share), ZERO);
    if (shares.length && !total.eq(ONE)) throw new Error(`內部錯誤：應繼分合計 ${total} ≠ 1`);
    return result;
  }
}

/* 展開再轉繼承後的最終應繼分 */
function finalShares(result) {
  const out = {};
  for (const s of result.shares) {
    if (result.retransfers[s.id]) {
      for (const [pid, fr] of Object.entries(finalShares(result.retransfers[s.id]))) {
        out[pid] = (out[pid] || ZERO).add(fr.mul(s.share));
      }
    } else {
      out[s.id] = (out[s.id] || ZERO).add(s.share);
    }
  }
  return out;
}

/* ============================================================
 * 備註：說明每個未直接繼承者的狀況與條文依據
 * 回傳 { pid: { tag: 方塊上的短標示, text: 完整備註, kind: "renounced"|"lost"|"predeceased"|"retrans"|"other" } }
 * ============================================================ */
function buildRemarks(fam, result) {
  const R = {};
  const final = finalShares(result);
  const names = ids => ids.map(i => fam.p[i].name).join("、");
  const isDescendant = (pid, root) => {
    const p = fam.p[pid];
    return [p.father, p.mother].some(x => x && (x === root || isDescendant(x, root)));
  };

  const walk = (res, isSub) => {
    const did = res.decedentId, dname = fam.p[did].name;

    // 再轉繼承：繼承開始後死亡的繼承人
    for (const s of res.shares) {
      const sub = res.retransfers[s.id];
      if (!sub || R[s.id]) continue;
      const p = fam.p[s.id], heirs = sub.shares.map(x => x.id);
      R[s.id] = { kind: "retrans", tag: "繼承開始後死亡・再轉繼承",
        text: `於繼承開始後、遺產分割前死亡（${roc(p.death)}），其已取得之應繼分 ${s.share} 成為其遺產，` +
          (heirs.length ? `由其繼承人${names(heirs)}依其死亡時之繼承順序再轉繼承。` : "其本身無繼承人。") };
    }

    for (const [pid, note] of Object.entries(res.notes)) {
      if (R[pid]) continue;
      const p = fam.p[pid], rep = res.represents[pid];
      if (isSub) {                                     // 再轉那一層只標示有意義的狀況
        if (note === "拋棄繼承") R[pid] = { kind: "renounced", tag: `拋棄${dname}之再轉部分`,
          text: `對${dname}之遺產拋棄繼承，不參與該部分之再轉繼承（民法第1174條）` +
            (final[pid] ? "；但仍保有其本身對原被繼承人之應繼分。" : "。") };
        else if (note === "喪失繼承權") R[pid] = { kind: "lost", tag: `喪失${dname}之繼承權`,
          text: `對${dname}喪失繼承權（民法第1145條），不參與該部分之再轉繼承。` };
        continue;
      }
      switch (note) {
        case "拋棄繼承":
          R[pid] = { kind: "renounced", tag: "拋棄繼承・無繼承權",
            text: "拋棄繼承，溯及於繼承開始時即無繼承權（民法第1174條、第1175條）；其應繼分歸屬其他同為繼承之人（第1176條第1項），" +
              "其直系血親卑親屬不得代位繼承。" };
          break;
        case "喪失繼承權":
          R[pid] = { kind: "lost", tag: rep ? "喪失繼承權・由子女代位" : "喪失繼承權・無繼承權",
            text: "依民法第1145條喪失繼承權，" + (rep ? `由其直系血親卑親屬${names(rep)}代位繼承其應繼分（第1140條）。` : "且無直系血親卑親屬可代位繼承。") };
          break;
        case "繼承開始前死亡":
          if (rep) R[pid] = { kind: "predeceased", tag: "繼承開始前死亡・由子女代位",
            text: `於繼承開始前死亡（${roc(p.death)}），由其直系血親卑親屬${names(rep)}代位繼承其應繼分（民法第1140條）；` +
              "代位繼承人按被代位人之應繼分平均分受。" };
          else if (isDescendant(pid, did)) R[pid] = { kind: "predeceased", tag: "繼承開始前死亡",
            text: `於繼承開始前死亡（${roc(p.death)}），且無直系血親卑親屬可代位繼承。` };
          else R[pid] = { kind: "predeceased", tag: "繼承開始前死亡",
            text: `於繼承開始前死亡（${roc(p.death)}），依同時存在原則不具繼承資格。` };
          break;
        case "繼承開始時尚未出生":
          R[pid] = { kind: "other", tag: "繼承開始時尚未出生", text: "繼承開始時尚未出生（亦非胎兒），不具繼承資格。" };
          break;
        case "有第一順序繼承人，不繼承":
          R[pid] = { kind: "other", tag: "後順序・不繼承", text: "因有第一順序繼承人，依民法第1138條不得繼承。" };
          break;
        default:
          R[pid] = { kind: "other", tag: note, text: note };
      }
    }
    for (const sub of Object.values(res.retransfers)) walk(sub, true);
  };
  walk(result, false);

  // 其餘非繼承人：說明為何沒有繼承權
  const represented = new Set(Object.keys(result.represents));
  for (const p of Object.values(fam.p)) {
    if (p.id === result.decedentId || R[p.id] || final[p.id]) continue;
    const parentRenounced = [p.father, p.mother].map(x => fam.p[x]).find(x => x && x.renounced.includes(result.decedentId));
    if (p.spouse && represented.has(p.spouse)) {
      R[p.id] = { kind: "other", tag: "被代位人之配偶・無繼承權",
        text: `為被代位人${fam.p[p.spouse].name}之配偶；代位繼承以直系血親卑親屬為限（民法第1140條），配偶不得代位，無繼承權。` };
    } else if (parentRenounced) {
      R[p.id] = { kind: "other", tag: "親拋棄・不得代位",
        text: `其${parentRenounced.gender === "M" ? "父" : parentRenounced.gender === "F" ? "母" : "直系尊親屬"}${parentRenounced.name}拋棄繼承，拋棄不發生代位繼承，無繼承權。` };
    } else {
      R[p.id] = { kind: "other", tag: "非繼承人", text: "非民法第1138條所定之法定繼承人。" };
    }
  }
  return R;
}

/* 本案實際適用的規定（只列出有用到的） */
function applicableRules(fam, result) {
  const rules = [];
  const all = [];
  const collect = r => { all.push(r); Object.values(r.retransfers).forEach(collect); };
  collect(result);
  const anyNote = n => all.some(r => Object.values(r.notes).includes(n));
  const dec = fam.p[result.decedentId];

  rules.push({ title: "繼承順序（民法第1138條、第1139條）",
    text: `遺產繼承人，除配偶外，依直系血親卑親屬、父母、兄弟姊妹、祖父母之順序定之；第一順序以親等近者為先。本案由${result.order}繼承。` });
  if (dec.spouse && result.shares.some(s => s.id === dec.spouse)) rules.push({ title: "配偶應繼分（民法第1144條）",
    text: "配偶與第一順序繼承人同為繼承時，應繼分與他繼承人平均；與第二、三順序同為繼承時為二分之一；與第四順序同為繼承時為三分之二；無其他順序繼承人時為全部。" });
  if (all.some(r => Object.keys(r.represents).length)) rules.push({ title: "代位繼承（民法第1140條）",
    text: "第一順序繼承人有於繼承開始前死亡或喪失繼承權者，由其直系血親卑親屬代位繼承其應繼分。" +
      "代位繼承人限於直系血親卑親屬，被代位人之配偶不得代位；代位人須於繼承開始時生存；拋棄繼承者不發生代位繼承。" });
  if (Object.keys(result.retransfers).length) rules.push({ title: "再轉繼承",
    text: "繼承人於繼承開始後、遺產分割前死亡，其已取得之應繼分成為其遺產，由其繼承人依其死亡時之繼承順序及應繼分再行繼承。" +
      "與代位繼承不同，再轉繼承人不限於直系血親卑親屬，配偶亦得再轉繼承；再轉繼承人得僅就再轉部分拋棄繼承。" });
  if (anyNote("拋棄繼承")) rules.push({ title: "拋棄繼承（民法第1174條至第1176條）",
    text: "繼承人得於知悉其得繼承之時起三個月內拋棄繼承權，拋棄之效力溯及於繼承開始時。拋棄者之應繼分歸屬其他同為繼承之人；" +
      "第一順序繼承人中親等近者均拋棄時，由次親等之直系血親卑親屬繼承。" });
  if (anyNote("喪失繼承權")) rules.push({ title: "喪失繼承權（民法第1145條）",
    text: "繼承人有民法第1145條第1項各款情事者喪失其繼承權；其直系血親卑親屬得代位繼承。" });
  rules.push({ title: "同時存在原則（民法第6條、第11條）",
    text: "繼承人須於繼承開始時生存；二人以上同時遇難而不能證明其死亡之先後時，推定其為同時死亡，相互間不發生繼承。" });
  return rules;
}

/* 輸入檢查：回傳 { errors:[], warnings:[] } */
function validate(persons, decedentId) {
  const errors = [], warnings = [];
  const ids = new Set(persons.map(p => p.id));
  const byId = Object.fromEntries(persons.map(p => [p.id, p]));
  const label = p => p.name || `（未命名 ${p.id}）`;

  if (!persons.length) errors.push("尚未輸入任何人員");
  if (!decedentId || !ids.has(decedentId)) errors.push("請選擇被繼承人");
  else if (!byId[decedentId].death && !byId[decedentId]._deathRaw) errors.push(`被繼承人 ${label(byId[decedentId])} 必須填寫死亡日期`);

  for (const p of persons) {
    if (!p.name || !p.name.trim()) errors.push(`第 ${persons.indexOf(p) + 1} 列：姓名未填寫`);
    if (p._birthRaw && p.birth === undefined) errors.push(`${label(p)}：出生日期格式錯誤（例：114/3/10 或 2025-03-10）`);
    if (p._deathRaw && p.death === undefined) errors.push(`${label(p)}：死亡日期格式錯誤`);
    if (p.birth && p.death && p.death < p.birth) errors.push(`${label(p)}：死亡日期早於出生日期`);
    for (const rel of ["father", "mother", "spouse"]) {
      if (p[rel] === p.id) errors.push(`${label(p)}：不能把自己設為自己的${{ father: "父", mother: "母", spouse: "配偶" }[rel]}`);
      if (p[rel] && !ids.has(p[rel])) errors.push(`${label(p)}：關聯的人員不存在`);
    }
    if (p.father && p.father === p.mother) errors.push(`${label(p)}：父與母不能是同一人`);
    for (const rel of ["father", "mother"]) {
      const par = byId[p[rel]];
      if (par && par.birth && p.birth && par.birth >= p.birth) errors.push(`${label(p)}：${rel === "father" ? "父" : "母"}的出生日期晚於本人`);
      if (par && p.spouse === par.id) errors.push(`${label(p)}：配偶與父母重複`);
    }
    if (p.spouse && byId[p.spouse] && byId[p.spouse].spouse && byId[p.spouse].spouse !== p.id) {
      warnings.push(`${label(p)} 與 ${label(byId[p.spouse])} 的配偶設定不一致，請確認`);
    }
    if (p.father && byId[p.father] && byId[p.father].gender === "F") warnings.push(`${label(p)}：父的性別填為女，請確認`);
    if (p.mother && byId[p.mother] && byId[p.mother].gender === "M") warnings.push(`${label(p)}：母的性別填為男，請確認`);
  }

  // 統一編號重複
  const uidSeen = {};
  for (const p of persons) {
    const u = (p.uid || "").trim().toUpperCase();
    if (!u) continue;
    if (uidSeen[u]) errors.push(`${label(uidSeen[u])} 與 ${label(p)} 的統一編號相同（${u.slice(0, 3)}…），請確認是否為同一人`);
    else uidSeen[u] = p;
  }

  // 親子關係迴圈（例如 A 是 B 的父、B 又是 A 的父）
  const state = {};
  const visit = (id, path) => {
    if (state[id] === 2) return false;
    if (state[id] === 1) { errors.push(`親屬關係形成迴圈：${path.map(i => label(byId[i])).join(" → ")}`); return true; }
    state[id] = 1;
    const p = byId[id];
    for (const par of [p.father, p.mother]) if (par && byId[par] && visit(par, [...path, par])) return true;
    state[id] = 2;
    return false;
  };
  for (const p of persons) if (visit(p.id, [p.id])) break;

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

if (typeof module !== "undefined") module.exports = { Frac, parseDate, roc, Family, InheritanceEngine, finalShares, validate, buildRemarks, applicableRules };
