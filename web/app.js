/* ============================================================
 * 介面：資料輸入、戶籍資料匯入、檢查、產生系統表、拋棄查證、列印
 * 所有資料（含欄位對應設定）只存在記憶體，不使用 localStorage、sessionStorage、IndexedDB 或 Cookie。
 * ============================================================ */
"use strict";

const state = { persons: [], decedent: "", seq: 1, queried: new Set(), files: [], demoStep: 0, view: "tree", showFullUid: false };
const $ = sel => document.querySelector(sel);
const KIND_LABEL = { kin: "親等關聯資料", personal: "個人戶籍資料", simple: "本系統 CSV 格式" };
const STATUS_LABEL = { "": "未查證", none: "查無拋棄", claimed: "已聲明拋棄（待核實）", yes: "已拋棄（已核實）" };
const FETUS_LABEL = { "": "（非胎兒）", pending: "胎兒・待出生", live: "胎兒・已活產", stillbirth: "胎兒・死產" };
// 拋棄繼承：已核實與已聲明都納入計算；已聲明者標示待核實
const isRenounceStatus = v => v === "yes" || v === "claimed";
const isUnverified = v => !v || v === "claimed";

function isoToRoc(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return y > 1911 ? `${y - 1911}/${m}/${d}` : iso;
}
function todayRoc() { const d = new Date(); return `${d.getFullYear() - 1911}/${d.getMonth() + 1}/${d.getDate()}`; }
function newId() {
  const ids = new Set(state.persons.map(p => p.id));
  while (ids.has(`P${String(state.seq).padStart(2, "0")}`)) state.seq++;
  return `P${String(state.seq++).padStart(2, "0")}`;
}
function blankPerson() {
  return { id: newId(), uid: "", name: "", title: "", titleAuto: true, gender: "", birthRaw: "", deathRaw: "",
    deathTime: "", fetus: "", marriageEndRaw: "",
    father: "", mother: "", spouse: "", fatherName: "", motherName: "", spouseName: "",
    fatherUid: "", motherUid: "", spouseUid: "", renounceChecks: {}, lost_right: [], sources: [] };
}
const byId = id => state.persons.find(p => p.id === id);
const uidShow = u => (state.showFullUid ? (u || "") : maskUid(u || ""));
const renouncedOf = p => Object.entries(p.renounceChecks || {}).filter(([, v]) => isRenounceStatus(v.status)).map(([k]) => k);
function hasData() { return state.persons.length > 0; }

/* 頁內確認視窗（取代瀏覽器的 confirm，線上檢視器也能使用） */
function askConfirm(text, okLabel = "確定") {
  return new Promise(resolve => {
    const dlg = $("#confirm-dialog");
    $("#confirm-text").textContent = text;
    const yes = $("#confirm-yes"), no = $("#confirm-no");
    yes.textContent = okLabel;
    const done = v => { yes.onclick = no.onclick = null; dlg.oncancel = null; dlg.close(); resolve(v); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    dlg.oncancel = e => { e.preventDefault(); done(false); };
    dlg.showModal();
    no.focus();
  });
}
function resetCase() { state.persons = []; state.decedent = ""; state.seq = 1; state.queried = new Set(); state.files = []; state.demoStep = 0; }

/* ---------- 載入（取代）/ 匯出 ---------- */
function loadData(raw) {
  if (!raw || !Array.isArray(raw.persons)) throw new Error("檔案格式不正確：找不到 persons 清單");
  resetCase();
  state.persons = raw.persons.map(r => {
    const p = Object.assign(blankPerson(), {
      id: String(r.id), uid: r.uid || "", name: r.name || "", title: r.title || "",
      titleAuto: r.titleAuto !== undefined ? !!r.titleAuto : !r.title, gender: r.gender || "",
      birthRaw: parseDate(r.birth) ? isoToRoc(parseDate(r.birth)) : (r.birth || ""),
      deathRaw: parseDate(r.death) ? isoToRoc(parseDate(r.death)) : (r.death || ""),
      deathTime: r.deathTime || "", fetus: ["pending", "live", "stillbirth"].includes(r.fetus) ? r.fetus : "",
      marriageEndRaw: parseDate(r.marriageEnd) ? isoToRoc(parseDate(r.marriageEnd)) : (r.marriageEnd || r.marriageEndRaw || ""),
      father: r.father || "", mother: r.mother || "", spouse: r.spouse || "",
      fatherName: r.fatherName || "", motherName: r.motherName || "", spouseName: r.spouseName || "",
      renounceChecks: r.renounceChecks && typeof r.renounceChecks === "object" ? r.renounceChecks : {},
      lost_right: Array.isArray(r.lost_right) ? r.lost_right.map(String) : [],
      sources: Array.isArray(r.sources) ? r.sources : [],
    });
    for (const t of Array.isArray(r.renounced) ? r.renounced : []) p.renounceChecks[String(t)] ||= { status: "yes" };
    return p;
  });
  for (const p of state.persons) {                       // 配偶雙向補齊
    const s = byId(p.spouse);
    if (s && !s.spouse) s.spouse = p.id;
  }
  state.decedent = raw.decedent ? String(raw.decedent) : "";
  state.queried = new Set(Array.isArray(raw.queried) ? raw.queried : []);
  state.files = Array.isArray(raw.files) ? raw.files : [];
}
function exportData() {
  const out = {
    _說明: "繼承系統表案件檔。含個人資料，請依單位規定保管。",
    decedent: state.decedent, queried: [...state.queried], files: state.files,
    persons: state.persons.map(p => ({ ...p, birth: parseDate(p.birthRaw) || p.birthRaw || null,
      death: parseDate(p.deathRaw) || p.deathRaw || null, marriageEnd: parseDate(p.marriageEndRaw) || p.marriageEndRaw || null,
      birthRaw: undefined, deathRaw: undefined, marriageEndRaw: undefined })),
  };
  const dec = byId(state.decedent);
  download(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), safeName("繼承案件", "json"));
}
function exportCsvFile() {
  const persons = state.persons.map(p => ({ ...p, birth: parseDate(p.birthRaw) || p.birthRaw, death: parseDate(p.deathRaw) || p.deathRaw, renounced: renouncedOf(p) }));
  const dec = byId(state.decedent);
  download(new Blob([exportCsv(persons, state.decedent)], { type: "text/csv;charset=utf-8" }), safeName("繼承資料", "csv"));
}
function downloadTemplate() {
  const raw = JSON.parse($("#sample-data").textContent);
  download(new Blob([exportCsv(raw.persons, raw.decedent)], { type: "text/csv;charset=utf-8" }), "繼承資料範本.csv");
}
/* 下載檔名只含日期，不含姓名，避免下載資料夾的檔案列表洩漏個資 */
function safeName(prefix, ext) {
  const d = new Date();
  return `${prefix}_${d.getFullYear() - 1911}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.${ext}`;
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 訊息 ---------- */
function showMessages(blocks) {
  const box = $("#import-messages");
  box.replaceChildren();
  for (const b of blocks.filter(Boolean)) {
    const d = document.createElement("div"); d.className = `notice ${b.cls}`;
    const h = document.createElement("strong"); h.textContent = b.title; d.appendChild(h);
    if (b.items && b.items.length) {
      const ul = document.createElement("ul");
      for (const t of b.items) { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); }
      d.appendChild(ul);
    }
    const x = document.createElement("button"); x.type = "button"; x.className = "icon-btn notice-close"; x.textContent = "✕"; x.title = "關閉";
    x.addEventListener("click", () => d.remove());
    d.appendChild(x);
    box.appendChild(d);
  }
}

/* ---------- 匯入 ---------- */
const MAP_KEY = headers => "inh-map:" + headers.map(h => h.trim()).join("|");
// 欄位對應設定只記在記憶體（本次開啟期間有效），不使用任何瀏覽器儲存空間
const mappingMemory = new Map();
function loadRemembered(headers) { return mappingMemory.get(MAP_KEY(headers)) || null; }
function remember(headers, v) { mappingMemory.set(MAP_KEY(headers), v); }

function readBytes(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
}
async function importFiles(fileList) {
  const blocks = [];
  for (const f of fileList) {
    try {
      const buf = await readBytes(f);
      const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
      if (/\.pdf$/i.test(f.name) || head === "%PDF-") { blocks.push(await importPdf(f.name, buf, false)); continue; }
      const { text, encoding } = decodeBytes(buf);
      blocks.push(await importOne(f.name, text, encoding, false));
    } catch (err) { blocks.push({ cls: "error", title: `${f.name}：無法讀取`, items: [err.message] }); }
  }
  showMessages(blocks);
  renderTable(); schedule();
}

async function importOne(name, text, encoding, auto) {
  if (/\.json$/i.test(name) || /^\s*\{/.test(text)) {
    if (hasData() && !auto && !await askConfirm(`「${name}」是案件檔，載入後會取代目前全部資料，確定嗎？`)) return { cls: "warn", title: `${name}：已取消` };
    loadData(JSON.parse(text));
    return { cls: "ok", title: `${name}：已載入案件檔，共 ${state.persons.length} 人` };
  }
  return importTable(name, hhrReadTable(text), `${encoding} 編碼`, auto, [], text);
}

/* PDF：先還原成表格，再走同一套對應與匯入流程 */
async function importPdf(name, buf, auto) {
  let table;
  try { table = await pdfReadTable(buf); }
  catch (e) { return { cls: "error", title: `${name}：無法讀取 PDF`, items: [e.message, "PDF 若有密碼保護或已損毀，請重新匯出。"] }; }
  if (table.meta.scanned) return { cls: "error", title: `${name}：這是掃描影像 PDF，沒有可讀取的文字`,
    items: ["請改用戶政系統匯出的 CSV，或文字型 PDF（可用滑鼠選取文字的 PDF）。掃描檔需經 OCR 辨識，目前尚未支援。"] };
  if (!table.body.length) return { cls: "error", title: `${name}：PDF 中讀不到人員資料`, items: table.meta.notes };
  const how = table.meta.mode === "form" ? "表單格式" : "表格格式";
  return importTable(name, table, `PDF ${table.meta.pages} 頁・${how}`, auto, table.meta.notes, null);
}

async function importTable(name, table, sourceLabel, auto, extraNotes, text) {
  const isPdf = text === null;
  let kind = hhrGuessKind(table.headers), mapping = hhrGuessMapping(table.headers);
  const mem = loadRemembered(table.headers);
  if (mem) ({ kind, mapping } = mem);
  if (isPdf && kind === "simple") kind = "personal";
  if (!auto) {
    const r = await openMapDialog(name, sourceLabel, table, kind, mapping, !isPdf);
    if (!r) return { cls: "warn", title: `${name}：已取消匯入` };
    ({ kind, mapping } = r);
    remember(table.headers, { kind, mapping });
  }

  if (kind === "simple") {
    if (hasData() && !auto && !await askConfirm("本系統 CSV 格式會取代目前全部資料，確定嗎？")) return { cls: "warn", title: `${name}：已取消` };
    const { data, errors, warnings } = importCsv(text);
    if (errors.length) return { cls: "error", title: `${name}：無法匯入，有 ${errors.length} 項問題需先修正`, items: [...errors, ...warnings] };
    loadData(data);
    return { cls: warnings.length ? "warn" : "ok", title: `${name}：已匯入 ${data.persons.length} 人（${sourceLabel}）`, items: warnings };
  }

  const parsed = hhrParse(table, mapping, kind);
  if (parsed.errors.length) return { cls: "error", title: `${name}：無法匯入`, items: [...parsed.errors, ...parsed.warnings] };
  const m = hhrMerge(state.persons, parsed, name, newId);
  state.files.push({ name, kind, anchor: parsed.anchorUid, count: parsed.records.length, at: todayRoc(),
    rels: parsed.records.map(r => ({ uid: r.uid, relation: r.relation })) });
  let anchorName = "";
  if (kind === "kin") {
    const a = state.persons.find(p => normUid(p.uid) === parsed.anchorUid);
    state.queried.add(a.id);
    anchorName = a.name;
    if (!state.decedent) state.decedent = a.id;
  }
  const link = hhrLink(state.persons, state.files);
  const items = [...extraNotes, ...parsed.warnings, ...m.conflicts, ...link.warnings];
  return { cls: m.conflicts.length || link.warnings.length ? "warn" : "ok", items,
    title: `${name}：${KIND_LABEL[kind]}${anchorName ? `（本人：${anchorName}）` : ""}，${parsed.records.length} 筆，新增 ${m.added} 人、補充 ${m.updated} 人（${sourceLabel}）` };
}

/* 欄位對應視窗 */
function openMapDialog(name, sourceLabel, table, kind0, mapping0, allowSimple = true) {
  return new Promise(resolve => {
    const dlg = $("#map-dialog");
    dlg.replaceChildren();
    let kind = kind0, mapping = { ...mapping0 };
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

    dlg.appendChild(mk("h3", "", `匯入：${name}`));
    dlg.appendChild(mk("p", "muted", `${sourceLabel}・${table.body.length} 列資料・偵測到 ${table.headers.length} 個欄位。請確認檔案種類與欄位對應${allowSimple ? "" : "，並核對預覽內容與 PDF 是否一致"}。`));

    const kindRow = mk("div", "kind-row");
    for (const k of allowSimple ? ["kin", "personal", "simple"] : ["kin", "personal"]) {
      const lab = mk("label");
      const r = mk("input"); r.type = "radio"; r.name = "kind"; r.value = k; r.checked = k === kind;
      r.addEventListener("change", () => { kind = k; render(); });
      lab.append(r, document.createTextNode(" " + { kin: "親等關聯資料（二、三親等）", personal: "個人戶籍資料", simple: "本系統 CSV 格式（取代目前資料）" }[k]));
      kindRow.appendChild(lab);
    }
    dlg.appendChild(kindRow);
    const body = mk("div", "map-body");
    dlg.appendChild(body);
    const err = mk("div", "map-error");
    dlg.appendChild(err);
    const actions = mk("div", "map-actions");
    const cancel = mk("button", "", "取消"); cancel.type = "button";
    const ok = mk("button", "primary", "匯入此檔"); ok.type = "button";
    actions.append(cancel, ok);
    dlg.appendChild(actions);

    const sample = table.body.slice(0, 3);
    function render() {
      body.replaceChildren();
      if (kind === "simple") {
        body.appendChild(mk("p", "muted", "本系統的 CSV 範本格式（父、母、配偶填姓名）。匯入後會取代目前全部資料。"));
        err.textContent = ""; ok.disabled = false; return;
      }
      const fields = HHR_FIELDS.filter(f => f.kinds.includes(kind));
      const t = mk("table", "map-table");
      const hr = t.createTHead().insertRow();
      ["系統欄位", "對應到檔案中的欄位", "第一筆資料"].forEach(x => hr.appendChild(mk("th", "", x)));
      const tb = t.createTBody();
      for (const f of fields) {
        const r = tb.insertRow();
        const req = (f.required || []).includes(kind);
        const c0 = r.insertCell(); c0.textContent = f.label + (req ? "（必要）" : "");
        if (req) c0.className = "req";
        const sel = mk("select");
        const o0 = mk("option", "", "（無此欄位）"); o0.value = ""; sel.appendChild(o0);
        table.headers.forEach((h, i) => { const o = mk("option", "", h || `第 ${i + 1} 欄`); o.value = String(i); if (mapping[f.key] === i) o.selected = true; sel.appendChild(o); });
        sel.addEventListener("change", () => {
          if (sel.value === "") delete mapping[f.key]; else mapping[f.key] = +sel.value;
          render();
        });
        r.insertCell().appendChild(sel);
        const v = f.key in mapping && sample[0] ? String(sample[0][mapping[f.key]] ?? "") : "";
        r.insertCell().textContent = f.key === "uid" ? maskUid(v) : v;
      }
      body.appendChild(t);

      // 預覽
      const prevFields = fields.filter(f => f.key in mapping && ["relation", "name", "uid", "birth", "death", "fatherName", "motherName"].includes(f.key));
      if (prevFields.length && sample.length) {
        body.appendChild(mk("h4", "", "預覽（前 3 筆）"));
        const pv = mk("table", "map-table preview");
        const ph = pv.createTHead().insertRow();
        prevFields.forEach(f => ph.appendChild(mk("th", "", f.label.replace("（相對於本人）", ""))));
        const pb = pv.createTBody();
        for (const row of sample) {
          const r = pb.insertRow();
          for (const f of prevFields) {
            let v = String(row[mapping[f.key]] ?? "").trim();
            if (f.key === "uid") v = maskUid(v);
            if ((f.key === "birth" || f.key === "death") && parseDate(v)) v = roc(parseDate(v));
            r.insertCell().textContent = v;
          }
        }
        body.appendChild(pv);
      }
      const missing = fields.filter(f => (f.required || []).includes(kind) && !(f.key in mapping)).map(f => f.label);
      const dup = Object.values(mapping).filter((v, i, a) => a.indexOf(v) !== i).length;
      err.textContent = missing.length ? `尚未對應必要欄位：${missing.join("、")}` : dup ? "有兩個系統欄位對應到同一個檔案欄位，請確認" : "";
      ok.disabled = missing.length > 0;
    }
    render();
    const done = v => { dlg.close(); resolve(v); };
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done({ kind, mapping }));
    dlg.addEventListener("cancel", e => { e.preventDefault(); done(null); }, { once: true });
    dlg.showModal();
  });
}

/* 戶籍匯入範例：每按一次匯入下一份，模擬實務流程 */
async function demoStep() {
  const samples = JSON.parse($("#hhr-samples").textContent);
  if (state.demoStep === 0 || state.demoStep >= samples.length) {
    if (hasData() && !await askConfirm("戶籍匯入範例會從頭開始，並取代目前的資料，確定嗎？")) return;
    resetCase();
  }
  const s = samples[state.demoStep];
  const step = state.demoStep;
  const msg = await importOne(s.name, s.text, "UTF-8", true);
  state.demoStep = step + 1;
  const hint = ["範例第 1 步：匯入被繼承人的二親等資料。請看下方「待調閱清單」，系統提示需調閱王淑娟的資料。再按一次「戶籍匯入範例」繼續。",
    "範例第 2 步：匯入王淑娟的二親等資料，系統以統一編號合併重複的人，並補上她的配偶。範例中被繼承人的二親等資料漏了孫女王小平，再按一次補上。",
    "範例第 3 步：以個人戶籍資料補上王小平，依父姓名自動連到王志偉。最後請在「拋棄繼承查證」把王淑芬設為「已拋棄」，看結果如何變化。"][step];
  showMessages([msg, { cls: "info", title: hint }]);
  $("#btn-demo").textContent = state.demoStep >= samples.length ? "重新播放範例" : `匯入範例 ${state.demoStep + 1}/${samples.length}`;
  renderTable(); schedule();
}

/* ---------- 人員表格 ---------- */
function option(sel, value, text, current) {
  const o = document.createElement("option");
  o.value = value; o.textContent = text; if (value === current) o.selected = true;
  sel.appendChild(o);
}
function personLabel(p) { return `${p.name || "（未命名）"}${p.title ? "・" + p.title : ""}`; }
function applyAutoTitles() {
  const T = autoTitles(state.persons, state.decedent);
  for (const p of state.persons) if (p.titleAuto) p.title = T[p.id] || "";
}

function renderTable() {
  applyAutoTitles();
  const ds = $("#decedent");
  ds.replaceChildren();
  option(ds, "", "— 請選擇 —", state.decedent);
  for (const p of state.persons) option(ds, p.id, personLabel(p), state.decedent);

  const tb = $("#people tbody");
  tb.replaceChildren();
  state.persons.forEach((p, idx) => {
    const tr = document.createElement("tr");
    if (p.id === state.decedent) tr.className = "is-decedent";
    const td = (child, cls) => { const c = document.createElement("td"); if (cls) c.className = cls; c.appendChild(child); tr.appendChild(c); return c; };
    const num = document.createElement("span"); num.textContent = idx + 1; td(num, "num");

    const text = (field, ph, cls) => {
      const i = document.createElement("input");
      i.type = "text"; i.autocomplete = "off"; i.spellcheck = false; i.value = p[field] || ""; i.placeholder = ph; if (cls) i.className = cls;
      let hint = null;
      i.addEventListener("input", () => {
        p[field] = i.value;
        if (field === "title") p.titleAuto = i.value.trim() === "";
        if (field.endsWith("Raw")) dateHint(i, hint);
        schedule();
      });
      if (field === "name" || field === "title" || field === "uid") i.addEventListener("change", () => (field === "title" && p.titleAuto ? renderTable() : refreshSelects()));
      const wrap = document.createElement("div");
      wrap.appendChild(i);
      if (field.endsWith("Raw")) { hint = document.createElement("small"); wrap.appendChild(hint); dateHint(i, hint); }
      if (field === "title") {
        if (p.titleAuto && p.title) i.classList.add("auto");
        i.title = p.titleAuto ? "依被繼承人自動換算，可直接修改" : "手動輸入（清空即恢復自動換算）";
      }
      if (field === "name" && p.sources && p.sources.length) {
        const s = document.createElement("small"); s.className = "src"; s.textContent = `來源：${p.sources.length} 份`; s.title = p.sources.join("\n"); wrap.appendChild(s);
      }
      return wrap;
    };
    td(text("title", "稱謂"));
    td(text("name", "姓名"));
    td(text("uid", "統一編號", "uid"));

    const g = document.createElement("select");
    [["", "—"], ["M", "男"], ["F", "女"]].forEach(([v, t]) => option(g, v, t, p.gender));
    g.addEventListener("change", () => { p.gender = g.value; renderTable(); schedule(); });
    td(g);
    const birthCell = td(text("birthRaw", "民國 年/月/日", "date"));
    const fs = document.createElement("select");
    fs.className = "sub"; fs.title = "胎兒狀態（民法第7條）：繼承開始時已受胎、尚未出生者請設定";
    for (const [v, t] of Object.entries(FETUS_LABEL)) option(fs, v, t, p.fetus || "");
    fs.addEventListener("change", () => { p.fetus = fs.value; renderTable(); schedule(); });
    birthCell.appendChild(fs);
    const deathCell = td(text("deathRaw", "（存歿）", "date"));
    const tm = document.createElement("input");
    tm.type = "text"; tm.className = "sub"; tm.placeholder = "死亡時間（選填）"; tm.maxLength = 5; tm.autocomplete = "off";
    tm.title = "與他人同日死亡時，填寫時間（24 小時制，例 08:30）以判斷先後；不填則依民法第11條推定同時死亡";
    tm.value = p.deathTime || "";
    tm.addEventListener("input", () => { p.deathTime = tm.value.trim(); tm.classList.toggle("bad", !!tm.value.trim() && !/^([01]\d|2[0-3]):[0-5]\d$/.test(tm.value.trim())); schedule(); });
    deathCell.appendChild(tm);

    for (const rel of ["father", "mother", "spouse"]) {
      const s = document.createElement("select");
      s.dataset.rel = rel; s.dataset.pid = p.id;
      fillRelSelect(s, p, rel);
      s.addEventListener("change", () => setRelation(p, rel, s.value));
      const cell = td(s);
      if (rel === "spouse") {
        const me = document.createElement("input");
        me.type = "text"; me.className = "sub"; me.placeholder = "婚姻終止日（選填）"; me.autocomplete = "off";
        me.title = "與配偶離婚等婚姻終止日期；於繼承開始前終止者，不具配偶繼承權";
        me.value = p.marriageEndRaw || "";
        me.addEventListener("input", () => { p.marriageEndRaw = me.value; me.classList.toggle("bad", !!me.value.trim() && parseDate(me.value) === undefined); schedule(); });
        cell.appendChild(me);
      }
      const nm = p[rel + "Name"];
      if (nm && !p[rel]) { const h = document.createElement("small"); h.className = "note"; h.textContent = `戶籍記載：${nm}`; h.title = "此人不在名單中；如與繼承有關，請調閱其資料"; cell.appendChild(h); }
    }

    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!state.decedent && p.lost_right.includes(state.decedent);
    c.disabled = !state.decedent || p.id === state.decedent;
    c.title = "對被繼承人喪失繼承權（第1145條）";
    c.addEventListener("change", () => {
      p.lost_right = p.lost_right.filter(x => x !== state.decedent);
      if (c.checked) p.lost_right.push(state.decedent);
      schedule();
    });
    td(c, "center");

    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn"; del.title = "刪除這一列"; del.textContent = "✕";
    del.addEventListener("click", () => removePerson(p.id));
    td(del, "center");
    tb.appendChild(tr);
  });
  $("#empty-hint").hidden = hasData();
  renderFileList();
}
function renderFileList() {
  const box = $("#file-list");
  box.replaceChildren();
  if (!state.files.length) return;
  const h = document.createElement("strong"); h.textContent = `已匯入 ${state.files.length} 份戶籍資料：`; box.appendChild(h);
  const ul = document.createElement("ul");
  for (const f of state.files) {
    const a = state.persons.find(p => f.anchor && normUid(p.uid) === f.anchor);
    const li = document.createElement("li");
    li.textContent = `${f.name}｜${KIND_LABEL[f.kind]}${a ? `（本人：${a.name}）` : ""}｜${f.count} 筆｜${f.at || ""}匯入`;
    ul.appendChild(li);
  }
  box.appendChild(ul);
}
function fillRelSelect(s, p, rel) {
  s.replaceChildren();
  option(s, "", "—", p[rel]);
  for (const x of state.persons) if (x.id !== p.id) option(s, x.id, personLabel(x), p[rel]);
}
function refreshSelects() {
  for (const s of document.querySelectorAll("select[data-rel]")) {
    const p = byId(s.dataset.pid);
    if (p) fillRelSelect(s, p, s.dataset.rel);
  }
  const ds = $("#decedent"), cur = state.decedent;
  ds.replaceChildren(); option(ds, "", "— 請選擇 —", cur);
  for (const p of state.persons) option(ds, p.id, personLabel(p), cur);
  schedule();
}
function setRelation(p, rel, value) {
  if (rel === "spouse") {
    const old = byId(p.spouse);
    if (old && old.spouse === p.id) old.spouse = "";
    p.spouse = value;
    const nw = byId(value);
    if (nw) {
      const nwOld = byId(nw.spouse);
      if (nwOld && nwOld !== p) nwOld.spouse = "";
      nw.spouse = p.id;
    }
  } else p[rel] = value;
  renderTable(); schedule();
}
async function removePerson(id) {
  const p = byId(id);
  if (!await askConfirm(`確定刪除「${p ? personLabel(p) : id}」？與此人相關的親屬關係也會一併清除。`)) return;
  state.persons = state.persons.filter(x => x.id !== id);
  for (const x of state.persons) {
    for (const rel of ["father", "mother", "spouse"]) if (x[rel] === id) x[rel] = "";
    delete x.renounceChecks[id];
  }
  if (state.decedent === id) state.decedent = "";
  state.queried.delete(id);
  renderTable(); schedule();
}
function dateHint(input, hint) {
  const v = input.value.trim(), iso = parseDate(v);
  input.classList.toggle("bad", !!v && iso === undefined);
  hint.textContent = !v ? "" : iso === undefined ? "格式錯誤" : roc(iso);
  hint.className = iso === undefined ? "bad" : "";
}

/* ---------- 計算與輸出 ---------- */
let timer = null;
function schedule() { clearTimeout(timer); timer = setTimeout(compute, 300); }

function enginePersons() {
  return state.persons.map(p => ({
    id: p.id, uid: (p.uid || "").trim(), name: (p.name || "").trim(), title: (p.title || "").trim(), gender: p.gender,
    birth: parseDate(p.birthRaw), death: parseDate(p.deathRaw), _birthRaw: (p.birthRaw || "").trim(), _deathRaw: (p.deathRaw || "").trim(),
    deathTime: (p.deathTime || "").trim(), fetus: p.fetus || "",
    marriageEnd: parseDate(p.marriageEndRaw), _marriageEndRaw: (p.marriageEndRaw || "").trim(),
    father: p.father || null, mother: p.mother || null, spouse: p.spouse || null,
    fatherName: p.fatherName || "", motherName: p.motherName || "",
    renounced: renouncedOf(p), lost_right: p.lost_right,
  }));
}
function mkEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function compute() {
  const msg = $("#messages"), out = $("#report-body");
  msg.replaceChildren();
  $("#followups").replaceChildren();
  const persons = enginePersons();
  const { errors, warnings } = validate(persons, state.decedent);
  const box = (cls, title, items) => {
    if (!items.length) return;
    const d = mkEl("div", `notice ${cls}`); d.appendChild(mkEl("strong", "", title));
    const ul = mkEl("ul"); for (const t of items) ul.appendChild(mkEl("li", "", t));
    d.appendChild(ul); msg.appendChild(d);
  };
  box("error", `有 ${errors.length} 項資料需要修正，修正後才會產生系統表`, errors);
  box("warn", "請確認", warnings);
  $("#btn-print").disabled = $("#btn-svg").disabled = $("#btn-xlsx").disabled = true;
  if (errors.length) { out.replaceChildren(mkEl("p", "placeholder", "資料修正完成後，系統表會自動顯示在這裡。")); return; }

  const fam = new Family(persons.map(p => ({ ...p, birth: p.birth || null, death: p.death || null, marriageEnd: p.marriageEnd || null })));
  let result;
  try { result = new InheritanceEngine(fam).distribute(state.decedent); }
  catch (e) { box("error", "計算時發生問題", [e.message]); return; }

  const items = renounceItemsWithRecords(fam, result);
  const pending = items.filter(x => isUnverified(checkOf(x).status)).length;
  const follow = followUps(fam, result, state.queried);
  renderFollowups(follow, result);
  if (result.caseStatus === "no_known_heirs") box("warn", "目前資料中查無繼承人", ["這不等於法律上無人承受。確認無人承受（民法第1177條）前，應先完成親屬資料調查，並確認是否有待調閱或待確認事項。"]);

  out.replaceChildren();
  state.last = { fam, result, items };
  const notes = caseNotes(fam, result, items);
  const wrap = eventCharts(fam, result, items, notes);
  const treeView = mkEl("div", "view-tree"), formView = mkEl("div", "view-form");
  treeView.append(wrap, renouncePanel(fam, result, items, pending), shareTable(fam, result, items), rulesSection(fam, result), stepLog(fam, result));
  const fd = formData(fam, result, items, notes);
  const rp2 = renouncePanel(fam, result, items, pending); rp2.classList.add("no-print");
  formView.append(formSheet(fd), rp2);
  const tabs = mkEl("div", "view-tabs no-print");
  const views = { tree: treeView, form: formView };
  const setView = v => {
    state.view = v;
    for (const [k, node] of Object.entries(views)) node.hidden = k !== v;
    for (const b of tabs.children) b.classList.toggle("active", b.dataset.v === v);
  };
  for (const [v, label] of [["tree", "樹狀圖與明細"], ["form", "表格式（單張）"]]) {
    const b = mkEl("button", "", label); b.type = "button"; b.dataset.v = v;
    b.addEventListener("click", () => setView(v));
    tabs.appendChild(b);
  }
  out.append(tabs, treeView, formView);
  setView(state.view);
  $("#btn-print").disabled = $("#btn-svg").disabled = $("#btn-xlsx").disabled = false;
}

/* ---------- 分次繼承系統表：每一次死亡（原繼承＋各層再轉繼承）各一張 ---------- */
function inheritanceEvents(result) {
  const out = [];
  const walk = (res, scale, from) => {
    out.push({ res, scale, from });
    for (const s of res.shares) {
      if (res.retransfers[s.id]) walk(res.retransfers[s.id], scale.mul(s.share), { parent: res.decedentId, share: s.share });
    }
  };
  walk(result, new Frac(1), null);
  return out;
}
function eventCharts(fam, result, items, notes) {
  const events = inheritanceEvents(result);
  const root = fam.p[result.decedentId];
  const note = notes.length ? `※ ${notes.join("、")}，本表尚非最終結果` : "";
  const box = mkEl("div", "event-box");
  const tabs = mkEl("div", "event-tabs no-print");
  if (events.length > 1) {
    tabs.appendChild(mkEl("span", "event-label", `本案共 ${events.length} 次繼承：`));
    box.appendChild(tabs);
  }
  const charts = events.map((ev, i) => {
    const did = ev.res.decedentId, dec = fam.p[did];
    const extra = {};
    for (const it of items.filter(x => x.target === did)) {
      const c = checkOf(it);
      if (c.status === "yes" && (c.court || c.caseNo)) extra[it.pid] = `（${[c.court, c.caseNo].filter(Boolean).join(" ")}）`;
      if (c.status === "claimed") extra[it.pid] = "（已聲明拋棄，待核實法院文件）";
    }
    let chartFam = fam, opts = { note, remarkExtra: extra };
    if (ev.from) {
      // 再轉繼承：稱謂改以該次的被繼承人為準
      const T = autoTitles(Object.values(fam.p), did);
      chartFam = new Family(Object.values(fam.p).map(p => ({ ...p, title: T[p.id] || "" })));
      const parent = fam.p[ev.from.parent];
      opts = { ...opts, title: "繼承系統表（再轉繼承）", scale: ev.scale, scaleName: root.name,
        scope: `第 ${i + 1} 次繼承：${dec.name}於${roc(dec.death)}死亡，就其自${parent.name}遺產取得之應繼分 ${ev.from.share}` +
          (ev.from.parent !== root.id ? `（占${root.name}遺產 ${ev.scale}）` : "") + `，由其繼承人再轉繼承。方塊中藍字為占${root.name}遺產之比例。` };
    } else if (events.length > 1) {
      opts = { ...opts, scope: `第 1 次繼承：${root.name}於${roc(root.death)}死亡。其後有 ${events.length - 1} 位繼承人於遺產分割前死亡，另見後續各張再轉繼承系統表。` };
    }
    const wrap = mkEl("div", "chart-wrap event-chart");
    wrap.dataset.ev = String(i);
    wrap.appendChild(drawChart(chartFam, ev.res, opts));
    if (events.length > 1) {
      const b = mkEl("button", "", `${"①②③④⑤⑥⑦⑧⑨⑩"[i] || i + 1} ${dec.name}（${isoToRoc(dec.death)}歿）${ev.from ? "・再轉繼承" : "・原繼承"}`);
      b.type = "button"; b.dataset.ev = String(i);
      b.addEventListener("click", () => showEvent(i));
      tabs.appendChild(b);
    }
    return wrap;
  });
  const showEvent = i => {
    state.eventIdx = i;
    charts.forEach((c, k) => c.classList.toggle("inactive", k !== i));
    for (const b of tabs.querySelectorAll("button")) b.classList.toggle("active", b.dataset.ev === String(i));
  };
  box.append(...charts);
  showEvent(Math.min(state.eventIdx || 0, charts.length - 1));
  return box;
}

/* 案件尚未確定的原因（樹狀圖、表格式、Excel 共用） */
function caseNotes(fam, result, items) {
  const notes = [];
  const must = followUps(fam, result, state.queried).filter(f => f.level === "必要").length;
  const unchecked = items.filter(x => !checkOf(x).status).length;
  const claimed = items.filter(x => checkOf(x).status === "claimed").length;
  const kinds = new Set(result.pendingAll.map(p => p.kind));
  if (must) notes.push(`尚有 ${must} 項資料待調閱`);
  if (unchecked) notes.push(`${unchecked} 人未查證拋棄繼承`);
  if (claimed) notes.push(`${claimed} 人拋棄繼承待核實文件`);
  if (kinds.has("fetus")) notes.push("有胎兒尚未出生（應保留其應繼分）");
  if (kinds.has("same-day")) notes.push("有同日死亡、先後待確認者");
  if (result.caseStatus === "no_known_heirs") notes.push("目前查無繼承人");
  return notes;
}

/* 待調閱清單（含引擎判斷的待確認事實） */
function renderFollowups(list, result) {
  list = [...list, ...((result && result.pendingAll) || []).map(p => ({ level: "待確認", pid: p.pid, text: p.text, fact: true }))];
  const box = $("#followups");
  box.replaceChildren();
  if (!state.decedent) return;
  const sec = mkEl("section", "followups");
  const must = list.filter(f => f.level !== "建議");
  sec.appendChild(mkEl("h3", "", must.length ? `待調閱與待確認事項（${must.length} 項）` : "待調閱與待確認事項"));
  if (!list.length) { sec.appendChild(mkEl("p", "ok-line", "✓ 依目前資料，沒有需要再往下調閱的對象。")); box.appendChild(sec); return; }
  const ul = mkEl("ul");
  for (const f of list) {
    const li = mkEl("li", f.level === "建議" ? "maybe" : "must");
    li.appendChild(mkEl("span", "chip", f.level));
    li.appendChild(mkEl("span", "txt", f.text));
    if (f.fact) { ul.appendChild(li); continue; }       // 事實待確認：需修改資料（胎兒狀態、死亡時間）才會消失
    const b = mkEl("button", "", "已調閱／已確認"); b.type = "button";
    b.title = "已調閱但查無資料，或已人工確認時按下，此項即不再提示";
    b.addEventListener("click", () => { state.queried.add(f.pid); schedule(); });
    li.appendChild(b);
    ul.appendChild(li);
  }
  sec.appendChild(ul);
  box.appendChild(sec);
}

/* 拋棄繼承查證 */
function checkOf({ pid, target }) { return (byId(pid)?.renounceChecks || {})[target] || {}; }
function renounceItemsWithRecords(fam, result) {
  const list = renounceItems(fam, result);
  const keys = new Set(list.map(x => `${x.pid}|${x.target}`));
  for (const p of state.persons) {
    for (const [t, v] of Object.entries(p.renounceChecks || {})) {
      if (v.status && fam.p[t] && !keys.has(`${p.id}|${t}`)) { list.push({ pid: p.id, target: t }); keys.add(`${p.id}|${t}`); }
    }
  }
  const order = id => (id === result.decedentId ? 0 : 1);
  return list.sort((a, b) => order(a.target) - order(b.target));
}
function renouncePanel(fam, result, items, pending) {
  const sec = mkEl("section", "renounce-panel");
  sec.appendChild(mkEl("h3", "", `拋棄繼承查證（共 ${items.length} 人，${pending ? `${pending} 人未完成查證或核實` : "均已查證"}）`));
  sec.appendChild(mkEl("p", "muted no-print", "請至法院家事事件公告查詢是否有拋棄繼承，再於此登錄結果。有人拋棄後，系統會重新計算，並把遞補的繼承人加入清單。再轉繼承人可僅就再轉部分拋棄。"));
  const t = mkEl("table");
  const hr = t.createTHead().insertRow();
  ["姓名", "出生日期", "統一編號", "查證對象", "查證結果", "法院", "案號／文號", "查詢日期"].forEach(x => hr.appendChild(mkEl("th", "", x)));
  const tb = t.createTBody();
  for (const it of items) {
    const p = byId(it.pid), fp = fam.p[it.pid];
    const rec = (p.renounceChecks[it.target] ||= {});
    if (!rec.status) rec.status = "";
    const r = tb.insertRow();
    r.className = rec.status === "yes" ? "row-renounced" : isUnverified(rec.status) ? "row-pending" : "";
    r.insertCell().textContent = `${fp.name}${p.title ? `（${p.title}）` : ""}`;
    r.insertCell().textContent = fp.birth ? roc(fp.birth) : "";
    r.insertCell().textContent = uidShow(p.uid);
    r.insertCell().textContent = it.target === result.decedentId ? `被繼承人 ${fam.p[it.target].name}` : `再轉：${fam.p[it.target].name}之遺產`;
    const sel = mkEl("select");
    for (const [v, l] of Object.entries(STATUS_LABEL)) { const o = mkEl("option", "", l); o.value = v; if (v === rec.status) o.selected = true; sel.appendChild(o); }
    sel.addEventListener("change", () => {
      rec.status = sel.value;
      if (rec.status && !rec.checkedOn) rec.checkedOn = todayRoc();
      schedule();
    });
    r.insertCell().appendChild(sel);
    for (const [k, ph] of [["court", "例：臺灣臺北地方法院"], ["caseNo", "例：114年度司繼字第123號"], ["checkedOn", "民國 年/月/日"]]) {
      const i = mkEl("input"); i.type = "text"; i.autocomplete = "off"; i.spellcheck = false; i.value = rec[k] || ""; i.placeholder = ph;
      if (k !== "checkedOn" && !isRenounceStatus(rec.status)) { i.disabled = true; i.placeholder = ""; }
      i.addEventListener("input", () => { rec[k] = i.value; });
      i.addEventListener("change", schedule);
      r.insertCell().appendChild(i);
    }
  }
  sec.appendChild(t);
  return sec;
}
function renounceText(it) {
  const c = checkOf(it), p = byId(it.pid);
  const on = it.target === state.decedent ? "" : `（對${byId(it.target)?.name}之再轉部分）`;
  if (c.status === "yes") return `已拋棄繼承${on}：${[c.court, c.caseNo].filter(Boolean).join(" ") || "法院資料待補"}`;
  if (c.status === "claimed") return `已聲明拋棄繼承${on}，待核實法院文件`;
  if (c.status === "none") return `查無拋棄繼承${on}（${c.checkedOn || ""}查詢）`;
  return `拋棄繼承尚未查證${on}`;
}

function shareTable(fam, result, items) {
  const final = finalShares(result);
  const remarks = buildRemarks(fam, result);
  const parts = {}, original = {};
  const walk = (res, from, mult) => {
    for (const s of res.shares) {
      original[s.id] ??= s.share;
      if (!res.retransfers[s.id]) (parts[s.id] ||= []).push(from ? `再轉繼承（自${from}）：${s.basis}　${s.share.mul(mult)}` : `${s.basis}　${s.share.mul(mult)}`);
    }
    for (const s of res.shares) if (res.retransfers[s.id]) walk(res.retransfers[s.id], fam.p[s.id].name, s.share.mul(mult));
  };
  walk(result, null, new Frac(1));
  const basisOf = Object.fromEntries(Object.entries(parts).map(([pid, list]) =>
    [pid, list.length === 1 ? list[0].replace(/　\S+$/, "") : list.join("\n＋ ")]));
  const rnOf = pid => items.filter(x => x.pid === pid).map(renounceText);

  const sec = mkEl("section", "result-table");
  sec.appendChild(mkEl("h3", "", "繼承系統表明細"));
  const t = mkEl("table");
  const head = t.createTHead().insertRow();
  ["姓名", "統一編號", "稱謂", "存歿", "繼承依據", "應繼分", "比例", "備註"].forEach(x => head.appendChild(mkEl("th", "", x)));
  const body = t.createTBody();
  const pct = fr => `${(fr.n / fr.d * 100).toFixed(2)}%`;
  const alive = p => (p.death ? `歿（${roc(p.death)}）` : "存");
  const row = (p, cells, cls) => {
    const r = body.insertRow(); if (cls) r.className = cls;
    [p.name, uidShow(p.uid), p.title, alive(p), ...cells].forEach((v, i) => {
      const c = r.insertCell(); c.textContent = v;
      if (i === 5 || i === 6) c.className = "num";
      if (i === 7) c.className = "remark";
    });
  };
  row(fam.p[result.decedentId], ["被繼承人", "—", "", ""], "row-decedent");
  let total = new Frac(0);
  for (const [pid, fr] of Object.entries(final)) {
    total = total.add(fr);
    const rm = [remarks[pid] ? remarks[pid].text : "", ...rnOf(pid)].filter(Boolean).join("\n");
    row(fam.p[pid], [basisOf[pid] || "", fr.toString(), pct(fr), rm], rnOf(pid).some(x => x.includes("尚未查證")) ? "row-pending" : "");
  }
  const rank = { retrans: 0, predeceased: 1, renounced: 2, lost: 3, other: 4 };
  Object.entries(remarks).filter(([pid]) => !final[pid]).sort((a, b) => rank[a[1].kind] - rank[b[1].kind]).forEach(([pid, r]) => {
    const p = fam.p[pid];
    const rm = [r.text, ...rnOf(pid).filter(x => x.startsWith("已拋棄"))].join("\n");
    if (r.kind === "retrans") row(p, ["繼承開始後死亡，由其繼承人再轉繼承", `（原 ${original[pid]}）`, "—", rm], "row-retrans");
    else row(p, [r.tag.replace("・", "，"), "—", "—", rm], r.kind === "renounced" || r.kind === "lost" ? "row-renounced" : "row-excluded");
  });
  const foot = t.createTFoot().insertRow();
  ["合計", "", "", "", "", total.toString(), pct(total), ""].forEach((v, i) => { const c = foot.insertCell(); c.textContent = v; if (i === 5 || i === 6) c.className = "num"; });
  if (!Object.keys(final).length) { const r = body.insertRow(), c = r.insertCell(); c.colSpan = 8; c.textContent = "目前資料中查無繼承人；確認無人承受（民法第1177條）前，應先完成親屬資料調查"; }
  sec.appendChild(t);
  return sec;
}

/* ---------- 表格式（單張）繼承系統表 ---------- */
function familyOrder(fam, did) {
  const seen = new Set([did]), order = [];
  const push = id => { if (id && fam.p[id] && !seen.has(id)) { seen.add(id); order.push(id); } };
  const visit = id => { push(id); const p = fam.p[id]; if (p.spouse) push(p.spouse); for (const c of fam.children(id)) visit(c.id); };
  push(fam.p[did].spouse);
  for (const c of fam.children(did)) visit(c.id);
  for (const par of fam.parents(did)) push(par.id);
  for (const sb of fam.siblings(did)) visit(sb.id);
  for (const g of fam.grandparents(did)) push(g.id);
  for (const id of Object.keys(fam.p)) push(id);
  return order;
}
function formData(fam, result, items, pendingNotes) {
  const did = result.decedentId, dec = fam.p[did];
  const final = finalShares(result), remarks = buildRemarks(fam, result);
  const how = {}, original = {};
  const walk = (res, from) => {
    for (const s of res.shares) {
      original[s.id] ??= s.share;
      if (!res.retransfers[s.id]) (how[s.id] ||= []).push(from ? `再轉繼承（自${from}）` : (s.short === "第1144條 配偶" ? "配偶" : s.short));
    }
    for (const s of res.shares) if (res.retransfers[s.id]) walk(res.retransfers[s.id], fam.p[s.id].name);
  };
  walk(result, null);
  let total = new Frac(0);
  const rows = familyOrder(fam, did).map((id, i) => {
    const p = fam.p[id], r = remarks[id];
    let status, share, kind;
    if (final[id]) { status = how[id].join("＋"); share = final[id].toString(); kind = "heir"; total = total.add(final[id]); }
    else if (r && r.kind === "retrans") { status = "繼承開始後死亡，再轉繼承"; share = `原 ${original[id]}`; kind = "retrans"; }
    else { status = r ? r.tag.replace(/・/g, "，") : "非繼承人"; share = "—"; kind = r ? r.kind : "other"; }
    const note = items.filter(x => x.pid === id).map(it => {
      const c = checkOf(it), on = it.target === did ? "" : `（${fam.p[it.target].name}部分）`;
      return c.status === "yes" ? `拋棄繼承${on}：${[c.court, c.caseNo].filter(Boolean).join(" ") || "法院資料待補"}`
        : c.status === "claimed" ? `已聲明拋棄${on}，待核實`
        : c.status === "" || !c.status ? `拋棄繼承未查證${on}` : "";
    }).filter(Boolean).join("；");
    return { no: i + 1, title: p.title, name: p.name, uid: uidShow(p.uid), birth: isoToRoc(p.birth), death: isoToRoc(p.death), status, share, note, kind };
  });
  const rules = applicableRules(fam, result).map(r => r.title.replace(/（.*?）/, m => m)).join("、");
  return {
    head: { name: dec.name, uid: uidShow(dec.uid), birth: dec.birth ? roc(dec.birth) : "", death: roc(result.openedOn), order: result.order,
      heirs: Object.keys(final).length },
    rows, total: total.toString(),
    notes: [
      ...(pendingNotes.length ? [`※ ${pendingNotes.join("、")}，本表尚非最終結果。`] : []),
      `應繼分合計：${total}。`,
      `適用規定：${rules}。`,
      ...result.pendingAll.map(p => `※ 待確認：${p.text}。`),
      `本表由離線系統依${RULE_VERSION}自動產生，應與戶籍資料逐一核對後使用。`,
    ],
  };
}
function formSheet(d) {
  const sec = mkEl("section", "form-sheet");
  sec.appendChild(mkEl("h2", "fs-title", "繼承系統表"));
  const hd = mkEl("table", "fs-head");
  const hr = (a, b, c, e) => { const r = hd.insertRow(); [a, b, c, e].forEach((v, i) => { const x = r.insertCell(); x.textContent = v; if (i % 2 === 0) x.className = "k"; }); };
  hr("被繼承人", d.head.name, "統一編號", d.head.uid);
  hr("出生日期", d.head.birth, "死亡日期（繼承開始）", d.head.death);
  hr("繼承順序", d.head.order, "繼承人數", `${d.head.heirs} 人`);
  const sc1 = mkEl("div", "fs-scroll"); sc1.appendChild(hd); sec.appendChild(sc1);
  const t = mkEl("table", "fs-table");
  const th = t.createTHead().insertRow();
  ["編號", "稱謂", "姓名", "統一編號", "出生日期", "死亡日期", "繼承情形", "應繼分", "備註"].forEach(x => th.appendChild(mkEl("th", "", x)));
  const tb = t.createTBody();
  for (const r of d.rows) {
    const tr = tb.insertRow();
    tr.className = `k-${r.kind}`;
    [r.no, r.title, r.name, r.uid, r.birth, r.death, r.status, r.share, r.note].forEach((v, i) => {
      const c = tr.insertCell(); c.textContent = v;
      if (i === 0 || i === 7) c.className = "c";
    });
  }
  const tf = t.createTFoot().insertRow();
  [["合計", 7], [d.total, 1], ["", 1]].forEach(([v, span]) => { const c = tf.insertCell(); c.textContent = v; c.colSpan = span; if (span === 7) c.className = "r"; else c.className = "c"; });
  const sc2 = mkEl("div", "fs-scroll"); sc2.appendChild(t); sec.appendChild(sc2);
  const ft = mkEl("div", "fs-foot");
  for (const n of d.notes) ft.appendChild(mkEl("p", n.startsWith("※") ? "warn" : "", n));
  const sign = mkEl("div", "fs-sign");
  [`製表日期：民國${todayRoc().replace(/\//, "年").replace(/\//, "月")}日`, "承辦人：", "覆核："].forEach(x => sign.appendChild(mkEl("span", "", x)));
  ft.appendChild(sign);
  sec.appendChild(ft);
  return sec;
}
function exportXlsx() {
  if (!state.last) return;
  const { fam, result, items } = state.last;
  const d = formData(fam, result, items, caseNotes(fam, result, items));
  const S = (v, s) => ({ v: v === undefined || v === null ? "" : String(v), s });
  const rows = [
    [S("繼承系統表", 1)],
    [S(`被繼承人：${d.head.name}　　統一編號：${d.head.uid}　　出生日期：${d.head.birth}`, 5)],
    [S(`死亡日期（繼承開始）：${d.head.death}　　繼承順序：${d.head.order}　　繼承人數：${d.head.heirs} 人`, 5)],
    [],
    ["編號", "稱謂", "姓名", "統一編號", "出生日期", "死亡日期", "繼承情形", "應繼分", "備註"].map(h => S(h, 2)),
    ...d.rows.map(r => [S(r.no, 7), S(r.title, 3), S(r.name, 3), S(r.uid, 3), S(r.birth, 3), S(r.death, 3), S(r.status, 3), S(r.share, 7), S(r.note, 3)]),
    [S("合計", 4), S("", 3), S("", 3), S("", 3), S("", 3), S("", 3), S("", 3), S(d.total, 7), S("", 3)],
    [],
    ...d.notes.map(n => [S(n, 6)]),
    [],
    [S(`製表日期：民國${todayRoc().replace(/\//, "年").replace(/\//, "月")}日　　　承辦人：＿＿＿＿＿＿　　　覆核：＿＿＿＿＿＿`, 0)],
  ];
  const totalRow = 5 + d.rows.length + 1;
  const merges = ["A1:I1", "A2:I2", "A3:I3", `A${totalRow}:G${totalRow}`];
  d.notes.forEach((_, i) => merges.push(`A${totalRow + 2 + i}:I${totalRow + 2 + i}`));
  merges.push(`A${rows.length}:I${rows.length}`);
  download(buildXlsx(rows, { widths: [6, 12, 10, 13, 11, 11, 26, 9, 34], merges }), safeName("繼承系統表", "xlsx"));
}

function rulesSection(fam, result) {
  const sec = mkEl("section", "result-rules");
  sec.appendChild(mkEl("h3", "", "本案適用規定"));
  const dl = mkEl("dl");
  for (const r of applicableRules(fam, result)) dl.append(mkEl("dt", "", r.title), mkEl("dd", "", r.text));
  sec.appendChild(dl);
  return sec;
}
function stepLog(fam, result) {
  const sec = mkEl("section", "result-log");
  sec.appendChild(mkEl("h3", "", "判斷過程"));
  const ol = mkEl("ol");
  const walk = res => { for (const line of res.log) ol.appendChild(mkEl("li", "", line)); Object.values(res.retransfers).forEach(walk); };
  walk(result);
  sec.appendChild(ol);
  return sec;
}

/* ---------- 按鈕 ---------- */
function init() {
  $("#decedent").addEventListener("change", e => { state.decedent = e.target.value; renderTable(); schedule(); });
  $("#btn-add").addEventListener("click", () => {
    state.persons.push(blankPerson()); renderTable(); schedule();
    const rows = document.querySelectorAll("#people tbody tr");
    rows[rows.length - 1]?.querySelectorAll("input")[1]?.focus();
  });
  $("#btn-sample").addEventListener("click", async () => {
    if (hasData() && !await askConfirm("載入範例會取代目前的資料，確定嗎？")) return;
    loadData(JSON.parse($("#sample-data").textContent));
    showMessages([]); renderTable(); schedule();
  });
  $("#btn-demo").addEventListener("click", demoStep);
  $("#btn-sample3").addEventListener("click", async () => {
    if (hasData() && !await askConfirm("載入三代綜合案例會取代目前的資料，確定嗎？")) return;
    loadData(JSON.parse($("#sample-3gen").textContent));
    state.eventIdx = 0; state.view = "tree";
    showMessages([{ cls: "info", title: "三代綜合案例（虛構）：陳國華死亡後，長女陳美玲已先死亡（由其子女代位）、次女陳美珍拋棄繼承（其子女不代位）、次男陳志豪於遺產分割前死亡（再轉繼承，其女陳思妤僅拋棄再轉部分）。請在下方「繼承系統表」切換第 1、第 2 次繼承。" }]);
    renderTable(); schedule();
  });
  $("#btn-clear").addEventListener("click", async () => {
    if (!hasData() || !await askConfirm("確定清除全部資料？此動作無法復原。")) return;
    resetCase(); showMessages([]); $("#btn-demo").textContent = "戶籍匯入範例"; renderTable(); schedule();
  });
  $("#btn-import").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", e => {
    const files = [...e.target.files]; e.target.value = "";
    if (files.length) importFiles(files);
  });
  $("#btn-export").addEventListener("click", exportData);
  $("#btn-export-csv").addEventListener("click", exportCsvFile);
  $("#btn-template").addEventListener("click", downloadTemplate);
  $("#btn-print").addEventListener("click", () => window.print());
  $("#btn-xlsx").addEventListener("click", exportXlsx);
  $("#chk-uid").addEventListener("change", e => { state.showFullUid = e.target.checked; compute(); });
  $("#btn-svg").addEventListener("click", () => {
    const svg = document.querySelector(".view-tree .event-chart:not(.inactive) svg") || document.querySelector(".chart-wrap svg"); if (!svg) return;
    const dec = byId(state.decedent);
    download(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), safeName("繼承系統表", "svg"));
  });
  const ft = document.querySelector("footer.note");
  if (ft) ft.textContent = `${RULE_VERSION}。本工具依民法自動判斷，結果僅供參考，正式文件請以承辦人核對為準。`;
  window.addEventListener("beforeunload", e => { if (hasData()) { e.preventDefault(); e.returnValue = ""; } });
  // 離開或重新整理頁面時主動清空記憶體中的資料（含瀏覽器「上一頁」快取）
  const wipe = () => { resetCase(); state.last = null; showMessages([]); renderTable(); $("#report-body").replaceChildren(); };
  window.addEventListener("pagehide", wipe);
  window.addEventListener("pageshow", e => { if (e.persisted) { wipe(); compute(); } });
  renderTable(); compute();
}
document.addEventListener("DOMContentLoaded", init);
