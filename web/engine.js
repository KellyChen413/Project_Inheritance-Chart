/* ============================================================
 * 民法繼承規則引擎（JavaScript 版）
 * 第1138、1139、1140、1144、1174～1176條，第6、7、11、1166條，再轉繼承
 * 胎兒權利保留、同日死亡先後、婚姻終止、待確認事項彙整
 * 純運算，不讀寫檔案、不連網。
 * ============================================================ */
"use strict";

/* ---------- 分數（含安全檢查） ---------- */
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }
class Frac {
  constructor(n, d = 1) {
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d === 0) {
      throw new Error("應繼分計算超出可精確表示的範圍，或分母為零，請檢查資料");
    }
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g; this.d = d / g;
  }
  add(o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Frac(this.n * o.n, this.d * o.d); }
  div(k) {
    if (!Number.isInteger(k) || k === 0) throw new Error("分數除數必須為非零整數");
    return new Frac(this.n, this.d * k);
  }
  eq(o) { return this.n === o.n && this.d === o.d; }
  toString() { return this.d === 1 ? String(this.n) : `${this.n}/${this.d}`; }
}
const ONE = new Frac(1), ZERO = new Frac(0);

/* 規則版本：離線工具長期使用時，用來確認適用的規則是否需要更新 */
const RULE_VERSION = "現行民法繼承編（規則版本 2026.10.27）";

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
      const id = x && x.id !== undefined && x.id !== null ? String(x.id).trim() : "";
      if (!id) throw new Error("有人員缺少識別碼，無法建立家族資料");
      if (this.p[id]) throw new Error(`人員 ID 重複：${id}（${this.p[id].name || ""}／${x.name || ""}），請先修正`);
      this.p[id] = Object.assign({ title: "", gender: "", birth: null, death: null, deathTime: "", fetus: "",
        father: null, mother: null, spouse: null, marriageEnd: null, renounced: [], lost_right: [] }, x, { id });
    }
    for (const x of Object.values(this.p)) {          // 配偶雙向補齊
      if (x.spouse && this.p[x.spouse] && !this.p[x.spouse].spouse) this.p[x.spouse].spouse = x.id;
    }
  }
  byBirth(list) { return list.slice().sort((a, b) => (a.birth || "").localeCompare(b.birth || "")); }
  uniq(list) { return [...new Map(list.map(x => [x.id, x])).values()]; }
  children(id) { return this.byBirth(Object.values(this.p).filter(x => x.father === id || x.mother === id)); }
  parents(id) { const me = this.p[id]; return this.uniq([me.father, me.mother].filter(i => i && this.p[i]).map(i => this.p[i])); }
  siblings(id) {
    const mine = [this.p[id].father, this.p[id].mother].filter(Boolean);
    return this.byBirth(Object.values(this.p).filter(x => x.id !== id &&
      [x.father, x.mother].some(v => v && mine.includes(v))));
  }
  // 以 ID 去重：同一位祖父母可能經由父、母兩個分支被找到
  grandparents(id) { return this.uniq(this.parents(id).flatMap(par => this.parents(par.id))); }
}

/* ---------- 規則引擎 ----------
 * 三層分離：
 *   事實層  state()：依出生、死亡（含時間）、胎兒、拋棄、喪失繼承權，判定每個人在某次繼承開始時的「狀態」
 *   規則層  distribute()：依狀態套用第1138～1144、1140、1176條，產生繼承人、應繼分與推導紀錄
 *   輸出層  由介面呈現；所有「待確認」事項彙整於 result.pendingAll，有待確認時不得視為確定結果
 */
const STATE = {
  ELIGIBLE: "eligible",          // 本位可繼承
  PREDECEASED: "predeceased",    // 繼承開始前死亡
  SIMULTANEOUS: "simultaneous",  // 同日死亡、先後不明（推定同時死亡，待確認）
  UNBORN: "unborn",              // 繼承開始時尚未出生（且未標示為胎兒）
  STILLBIRTH: "stillbirth",      // 胎兒死產
  RENOUNCED: "renounced",        // 拋棄繼承
  DISQUALIFIED: "disqualified",  // 喪失繼承權
};
const STATE_TEXT = {
  predeceased: "繼承開始前死亡", simultaneous: "同日死亡、先後不明", unborn: "繼承開始時尚未出生",
  stillbirth: "胎兒死產", renounced: "拋棄繼承", disqualified: "喪失繼承權",
};

class InheritanceEngine {
  constructor(family) { this.f = family; }

  /* 某人於 d（時間 t）時是否已死亡：回傳 "before" | "after" | "same-unknown" | "alive" */
  static deathRelation(p, d, t) {
    if (!p.death) return "alive";
    if (p.death < d) return "before";
    if (p.death > d) return "after";
    if (p.deathTime && t && p.deathTime !== t) return p.deathTime < t ? "before" : "after";
    return "same-unknown";
  }
  /* 相容舊介面：繼承開始時是否生存（同日先後不明者視為非生存） */
  static aliveAt(p, d, t = "") {
    if (p.fetus === "stillbirth") return false;
    const born = p.fetus === "pending" || p.fetus === "live" || !p.birth || p.birth <= d;
    const rel = InheritanceEngine.deathRelation(p, d, t);
    return born && (rel === "alive" || rel === "after");
  }

  /* 事實層：某人對被繼承人 did（繼承開始 d、時間 t）的狀態 */
  state(p, did, d, t) {
    if (p.fetus === "stillbirth") return STATE.STILLBIRTH;
    const isFetus = p.fetus === "pending" || p.fetus === "live";
    if (!isFetus && p.birth && p.birth > d) return STATE.UNBORN;
    const rel = InheritanceEngine.deathRelation(p, d, t);
    if (rel === "before") return STATE.PREDECEASED;
    if (rel === "same-unknown") return STATE.SIMULTANEOUS;
    if (p.lost_right.includes(did)) return STATE.DISQUALIFIED;
    if (p.renounced.includes(did)) return STATE.RENOUNCED;
    return STATE.ELIGIBLE;
  }
  eligible(p, did, d, t) { return this.state(p, did, d, t) === STATE.ELIGIBLE; }
  reason(p, did, d, t) { const st = this.state(p, did, d, t); return st === STATE.ELIGIBLE ? "" : STATE_TEXT[st]; }

  /* 配偶：婚姻須於繼承開始時存續 */
  spouseOf(dec, d) {
    const sp = dec.spouse ? this.f.p[dec.spouse] : null;
    if (!sp) return { sp: null };
    const ended = [dec.marriageEnd, sp.marriageEnd].filter(Boolean).sort()[0];
    if (ended && ended <= d) return { sp, ended };
    return { sp };
  }

  distribute(did, openedOn = null, depth = 0, openedTime = null) {
    if (depth > 20) throw new Error("再轉繼承超過 20 層，請檢查資料是否有循環");
    const f = this.f, dec = f.p[did];
    const d = openedOn || dec.death;
    const t = openedTime !== null ? openedTime : (dec.deathTime || "");
    if (!d) throw new Error(`${dec.name} 沒有死亡日期，無法開始繼承`);
    const notes = {}, log = [], represents = {}, pending = [];
    const addPending = (kind, pid, text) => { if (!pending.some(x => x.kind === kind && x.pid === pid)) pending.push({ kind, pid, text, decedentId: did }); };
    log.push(`【${dec.name}】繼承開始日：${roc(d)}${t ? ` ${t}` : ""}`);
    const st = p => this.state(p, did, d, t);
    const noteState = (p, s) => {
      notes[p.id] = STATE_TEXT[s];
      if (s === STATE.SIMULTANEOUS) addPending("same-day", p.id, `${p.name}與${dec.name}同日死亡，死亡先後待確認；目前依民法第11條推定同時死亡計算`);
    };
    const flagFetus = p => {
      if (p.fetus === "pending") addPending("fetus", p.id, `${p.name}為胎兒、尚未出生；依民法第7條、第1166條保留其應繼分，如死產須重新計算`);
    };

    /* 第一順序：每一房的處理結果
     * 回傳 { kind: "heir" | "represented" | "renounced" | "none", heirs: [...] }
     *   heir        本位繼承
     *   represented 本人先死亡（含同時死亡）或喪失繼承權，由其直系血親卑親屬代位（第1140條）
     *   renounced   拋棄繼承：不發生代位，其應繼分歸屬同順序其他繼承人（第1176條第1項）
     *   none        本人非繼承人且無人代位（先死亡無後代、尚未出生、死產…）
     */
    const branch = (pid, represented = null) => {
      const p = f.p[pid], s = st(p);
      if (s === STATE.ELIGIBLE) {
        flagFetus(p);
        return { kind: "heir", heirs: [{ id: pid, w: ONE,
          basis: represented ? `第1140條 代位繼承（代位${represented}）` : "第1138條 第一順序 直系血親卑親屬",
          short: represented ? `代位繼承（代位${represented}）` : "本位繼承" }] };
      }
      noteState(p, s);
      if (s === STATE.RENOUNCED) {
        log.push(`${p.name}：拋棄繼承（第1174條），不發生代位，其應繼分歸屬其他同順序繼承人（第1176條第1項）`);
        return { kind: "renounced", heirs: [] };
      }
      if (s === STATE.UNBORN || s === STATE.STILLBIRTH) {
        log.push(`${p.name}：${STATE_TEXT[s]}，非繼承人`);
        return { kind: "none", heirs: [] };
      }
      // 先死亡、同時死亡、喪失繼承權 → 代位繼承（限直系血親卑親屬）
      const subs = f.children(pid).map(k => branch(k.id, p.name)).filter(b => b.heirs.length);
      log.push(subs.length
        ? `${p.name}：${STATE_TEXT[s]}，由其直系血親卑親屬代位繼承（第1140條）`
        : `${p.name}：${STATE_TEXT[s]}，且無可代位之直系血親卑親屬`);
      if (!subs.length) return { kind: "none", heirs: [] };
      represents[pid] = [...new Set(subs.flatMap(b => b.heirs.map(h => h.id)))];
      return { kind: "represented", heirs: subs.flatMap(b => b.heirs.map(h => ({ ...h, w: h.w.div(subs.length) }))) };
    };

    /* 第1176條第5項：第一順序親等近者「均拋棄」時，由次親等直系血親卑親屬繼承
     * 判斷方式：親等近者中，有人得繼承（含代位）→ 依該親等分配；
     *          無人得繼承且至少一人拋棄 → 往次親等（按人數）；
     *          先死亡且無人代位、未出生、死產者並非繼承人，不列入「均拋棄」的判斷；
     *          無人拋棄（全部非繼承人）→ 第一順序無繼承人，進入第二順序。 */
    let branches = [], level = f.children(did), degree = 1;
    while (level.length) {
      const results = level.map(c => ({ c, b: branch(c.id) }));
      branches = results.filter(x => x.b.heirs.length).map(x => x.b.heirs);
      if (branches.length) {
        if (degree > 1) {
          log.push(`依第1176條第5項，由第 ${degree} 親等直系血親卑親屬按人數繼承`);
          branches = branches.map(b => b.map(h => ({ ...h, basis: "第1176條第5項 次親等直系血親卑親屬繼承", short: "次親等繼承" })));
        }
        break;
      }
      const renouncers = results.filter(x => x.b.kind === "renounced").map(x => x.c);
      const others = results.filter(x => x.b.kind === "none").map(x => x.c);
      if (!renouncers.length) break;
      log.push(`第一順序第 ${degree} 親等中，得繼承者（${renouncers.map(x => x.name).join("、")}）均拋棄繼承` +
        (others.length ? `；${others.map(x => x.name).join("、")}非繼承人（${others.map(x => notes[x.id] || "無繼承資格").join("、")}且無人代位），不列入「均拋棄」的判斷` : "") +
        "，依第1176條第5項由次親等直系血親卑親屬繼承");
      level = renouncers.flatMap(c => f.children(c.id));
      degree++;
    }

    // 配偶：須生存且婚姻於繼承開始時存續
    const { sp, ended } = this.spouseOf(dec, d);
    let spouseOk = false;
    if (sp) {
      if (ended) {
        notes[sp.id] = `婚姻已於${roc(ended)}終止，非配偶`;
        log.push(`${sp.name}：與${dec.name}之婚姻已於${roc(ended)}終止，不具配偶繼承權`);
      } else {
        const s = st(sp);
        spouseOk = s === STATE.ELIGIBLE;
        if (!spouseOk) { noteState(sp, s); log.push(`配偶${sp.name}：${notes[sp.id]}`); }
      }
    }

    const shares = [];
    let order;
    if (branches.length) {
      order = "第一順序";
      const units = branches.length + (spouseOk ? 1 : 0);
      log.push(`第一順序共 ${branches.length} 房${spouseOk ? "，與配偶平均" : ""}，每份 1/${units}（第1144條第1款）`);
      for (const b of branches) for (const h of b) shares.push({ id: h.id, share: h.w.div(units), basis: h.basis, short: h.short });
      if (spouseOk) shares.push({ id: sp.id, share: new Frac(1, units), basis: "第1144條第1款 配偶與第一順序平均", short: "第1144條 配偶" });
      for (const x of [...f.parents(did), ...f.siblings(did), ...f.grandparents(did)]) {
        if (!(x.id in notes)) notes[x.id] = InheritanceEngine.aliveAt(x, d, t) ? "有第一順序繼承人，不繼承" : this.reason(x, did, d, t);
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
          const s = st(x);
          if (s === STATE.ELIGIBLE) ok.push(x);
          else if (!(x.id in notes)) noteState(x, s);
        }
        if (ok.length) { chosen = { name, ok, spPart, basis, short, art }; break; }
        if (group.length) log.push(`${name}無可繼承之人（第二至第四順序不適用代位繼承）`);
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
        order = "目前查無繼承人";
        log.push("目前資料中查無繼承人。確認無人承受（第1177條）前，應先完成親屬資料調查");
      }
    }

    // 分配驗證：同一層不得重複、每人皆有依據、合計為 1
    const seen = new Set();
    for (const s of shares) {
      if (seen.has(s.id)) throw new Error(`內部錯誤：${f.p[s.id].name} 在同一層重複出現，請檢查親屬關係是否重複連結`);
      if (!s.basis) throw new Error(`內部錯誤：${f.p[s.id].name} 缺少繼承依據`);
      seen.add(s.id);
    }
    const total = shares.reduce((a, s) => a.add(s.share), ZERO);
    if (shares.length && !total.eq(ONE)) throw new Error(`內部錯誤：應繼分合計 ${total} ≠ 1`);

    const result = { decedentId: did, openedOn: d, openedTime: t, order, shares, notes, log, represents, pending, retransfers: {} };

    // 再轉繼承：繼承人於繼承開始後（含同日較晚）死亡
    for (const s of shares) {
      const heir = f.p[s.id];
      if (InheritanceEngine.deathRelation(heir, d, t) === "after") {
        log.push(`${heir.name}：於繼承開始後死亡（${roc(heir.death)}${heir.death === d ? ` ${heir.deathTime}` : ""}），其應繼分 ${s.share} 由其繼承人再轉繼承`);
        result.retransfers[heir.id] = this.distribute(heir.id, heir.death, depth + 1, heir.deathTime || "");
      }
    }

    // 彙整各層待確認事項與案件狀態
    const all = [...pending];
    for (const sub of Object.values(result.retransfers)) all.push(...sub.pendingAll);
    result.pendingAll = all;
    result.caseStatus = !shares.length ? "no_known_heirs" : all.length ? "pending_verification" : "computed";
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
          R[pid] = { kind: "other", tag: "繼承開始時尚未出生", text: "繼承開始時尚未出生，且未標示為胎兒，不具繼承資格；如繼承開始時已受胎，請將胎兒狀態設為「已活產」（民法第7條）。" };
          break;
        case "胎兒死產":
          R[pid] = { kind: "other", tag: "胎兒死產・無繼承權", text: "胎兒以將來非死產者為限，始視為既已出生（民法第7條）；死產者不具繼承資格。" };
          break;
        case "同日死亡、先後不明":
          R[pid] = { kind: "predeceased", tag: rep ? "同日死亡・由子女代位（待確認）" : "同日死亡・先後待確認",
            text: `與${dname}同日死亡（${roc(p.death)}），死亡先後尚待確認；目前依民法第11條推定同時死亡，相互間不發生繼承` +
              (rep ? `，由其直系血親卑親屬${names(rep)}代位繼承（通說認同時死亡者亦得代位）。` : "。") + "如能確認死亡先後，請填寫雙方死亡時間。" };
          break;
        case "有第一順序繼承人，不繼承":
          R[pid] = { kind: "other", tag: "後順序・不繼承", text: "因有第一順序繼承人，依民法第1138條不得繼承。" };
          break;
        default:
          if (note.startsWith("婚姻已於")) { R[pid] = { kind: "other", tag: "婚姻已終止・非配偶", text: `${note.replace("，非配偶", "")}，於繼承開始時已非配偶，不具配偶繼承權（民法第1144條）。` }; break; }
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
  if (anyNote("拋棄繼承") && all.some(r => r.log.some(l => l.includes("第1176條第5項")))) rules.push({ title: "次親等遞補（民法第1176條第5項）",
    text: "第一順序之繼承人，其親等近者均拋棄繼承權時，由次親等之直系血親卑親屬繼承，按人數平均。繼承開始前死亡且無人代位、尚未出生或死產者，本非繼承人，不列入「均拋棄」的判斷。" });
  if (Object.values(fam.p).some(p => p.fetus)) rules.push({ title: "胎兒之權利（民法第7條、第1166條）",
    text: "胎兒以將來非死產者為限，關於其個人利益之保護，視為既已出生。胎兒為繼承人時，非保留其應繼分，他繼承人不得分割遺產；胎兒出生前，應以其母為法定代理人。" });
  if (Object.values(fam.p).some(p => p.marriageEnd)) rules.push({ title: "配偶身分（民法第1144條）",
    text: "配偶須於繼承開始時與被繼承人有合法婚姻關係，始有配偶繼承權；婚姻於繼承開始前因離婚等原因終止者，不具配偶繼承權。" });
  rules.push({ title: "同時存在原則（民法第6條、第7條、第11條）",
    text: "繼承人須於繼承開始時生存（胎兒以將來非死產者為限，視為既已出生）；二人以上同時遇難而不能證明其死亡之先後時，推定其為同時死亡，相互間不發生繼承。同日死亡而能確認先後者，依實際先後判斷。" });
  return rules;
}

/* 輸入檢查：回傳 { errors:[], warnings:[] } */
function validate(persons, decedentId) {
  const errors = [], warnings = [];
  const ids = new Set(persons.map(p => p.id));
  const byId = Object.fromEntries(persons.map(p => [p.id, p]));
  const label = p => p.name || `（未命名 ${p.id}）`;

  if (!persons.length) errors.push("尚未輸入任何人員");
  // 人員 ID 必須唯一，否則後一筆會覆蓋前一筆
  const idSeen = new Map();
  for (const p of persons) {
    const id = p.id === undefined || p.id === null ? "" : String(p.id).trim();
    if (!id) { errors.push(`${label(p)}：缺少人員識別碼`); continue; }
    if (idSeen.has(id)) errors.push(`人員 ID 重複：${id}（${label(idSeen.get(id))}、${label(p)}），請先修正`);
    else idSeen.set(id, p);
  }
  if (!decedentId || !ids.has(decedentId)) errors.push("請選擇被繼承人");
  else if (!byId[decedentId].death && !byId[decedentId]._deathRaw) errors.push(`被繼承人 ${label(byId[decedentId])} 必須填寫死亡日期`);
  const dec = byId[decedentId];
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  for (const p of persons) {
    if (p.deathTime && !TIME.test(p.deathTime)) errors.push(`${label(p)}：死亡時間格式錯誤（例：08:30，24 小時制）`);
    if (p.deathTime && !p.death) warnings.push(`${label(p)}：填了死亡時間但沒有死亡日期`);
    if (p._marriageEndRaw && p.marriageEnd === undefined) errors.push(`${label(p)}：婚姻終止日期格式錯誤`);
    if (p.marriageEnd && !p.spouse) warnings.push(`${label(p)}：填了婚姻終止日期，但沒有設定配偶`);
    if (p.fetus === "pending" && p.birth) errors.push(`${label(p)}：胎兒狀態為「待出生」，但已填出生日期；已出生請改為「已活產」`);
    if (p.fetus === "live" && !p.birth) warnings.push(`${label(p)}：胎兒已活產，請補上出生日期`);
    if (p.fetus && dec && dec.death && p.birth && p.birth <= dec.death) warnings.push(`${label(p)}：出生於繼承開始前，不需標示為胎兒`);
    if (!p.fetus && dec && dec.death && p.birth && p.birth > dec.death && [p.father, p.mother].includes(dec.id)) {
      warnings.push(`${label(p)}：出生日期晚於被繼承人死亡日；如繼承開始時已受胎，請將胎兒狀態設為「已活產」（民法第7條）`);
    }
    if (dec && dec.death && p.id !== dec.id && p.death === dec.death && !(p.deathTime && dec.deathTime)) {
      warnings.push(`${label(p)}與被繼承人同日死亡；如能確認先後，請填寫雙方死亡時間，否則依民法第11條推定同時死亡`);
    }
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

if (typeof module !== "undefined") module.exports = { Frac, parseDate, roc, Family, InheritanceEngine, finalShares, validate, buildRemarks, applicableRules, RULE_VERSION, STATE };
