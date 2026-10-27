// 執行：node web/test_hhr.js　（模擬實務流程：依序匯入三份虛構戶籍資料）
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Family, InheritanceEngine, finalShares, parseDate, validate } = require("./engine.js");
const { decodeBytes } = require("./csv.js");
const { hhrReadTable, hhrGuessKind, hhrGuessMapping, hhrParse, hhrMerge, hhrLink } = require("./hhr.js");
const { autoTitles, followUps, renounceItems } = require("./casework.js");

const DATA = path.join(__dirname, "../data");
function newCase() { return { persons: [], files: [], queried: new Set(), decedent: "", seq: 1 }; }
function importFile(c, file) {
  const { text } = decodeBytes(fs.readFileSync(path.join(DATA, file)));
  const table = hhrReadTable(text);
  const kind = hhrGuessKind(table.headers);
  const parsed = hhrParse(table, hhrGuessMapping(table.headers), kind);
  assert.deepStrictEqual(parsed.errors, [], file);
  const merge = hhrMerge(c.persons, parsed, file, () => `N${c.seq++}`);
  c.files.push({ name: file, kind, anchor: parsed.anchorUid, rels: parsed.records.map(r => ({ uid: r.uid, relation: r.relation })) });
  if (kind === "kin") {
    const a = c.persons.find(p => p.uid === parsed.anchorUid);
    c.queried.add(a.id);
    if (!c.decedent) c.decedent = a.id;
  }
  const link = hhrLink(c.persons, c.files);
  return { kind, merge, link, parsed };
}
function compute(c) {
  const T = autoTitles(c.persons, c.decedent);
  const persons = c.persons.map(p => ({ ...p, title: T[p.id] || "", birth: parseDate(p.birthRaw) || null, death: parseDate(p.deathRaw) || null,
    renounced: Object.entries(p.renounceChecks).filter(([, v]) => v.status === "yes").map(([k]) => k) }));
  const v = validate(persons, c.decedent);
  assert.deepStrictEqual(v.errors, []);
  const fam = new Family(persons);
  const result = new InheritanceEngine(fam).distribute(c.decedent);
  const shares = Object.fromEntries(Object.entries(finalShares(result)).map(([k, f]) => [fam.p[k].name, f.toString()]));
  return { fam, result, shares, titles: Object.fromEntries(persons.map(p => [p.name, T[p.id]])),
    follow: followUps(fam, result, c.queried), renounce: renounceItems(fam, result) };
}
const byName = (c, n) => c.persons.find(p => p.name === n);

const cases = {
  "第 1 步：只有被繼承人的二親等資料": () => {
    const c = newCase();
    const r = importFile(c, "範例1_王大明_二親等資料.csv");
    assert.strictEqual(r.kind, "kin");
    assert.strictEqual(r.merge.added, 12);
    assert.strictEqual(byName(c, "王小安").father, byName(c, "王志偉").id);     // 孫：依父姓名連結
    assert.strictEqual(byName(c, "王大華").father, byName(c, "王福來").id);     // 弟：依父姓名連結
    assert.strictEqual(byName(c, "王大明").spouse, byName(c, "林美華").id);
    const out = compute(c);
    assert.strictEqual(out.titles["王志偉"], "次男");
    assert.strictEqual(out.titles["張小宇"], "外孫");
    // 王小平遺漏 → 王小安代位取得全部 1/5；王淑娟的配偶尚無資料
    assert.strictEqual(out.shares["王小安"], "1/5");
    const must = out.follow.filter(f => f.level === "必要").map(f => f.text).join("\n");
    assert.ok(must.includes("王淑娟於繼承開始後死亡（再轉繼承）"), must);
    assert.ok(out.follow.some(f => f.level === "建議" && f.text.includes("王志偉")));
  },
  "第 2 步：加入王淑娟的二親等資料（再轉繼承）": () => {
    const c = newCase();
    importFile(c, "範例1_王大明_二親等資料.csv");
    const r = importFile(c, "範例2_王淑娟_二親等資料.csv");
    assert.strictEqual(r.merge.added, 1);                                       // 只有張建國是新的，其餘以統一編號合併
    assert.deepStrictEqual(r.merge.conflicts, []);
    assert.strictEqual(byName(c, "張建國").spouse, byName(c, "王淑娟").id);
    const out = compute(c);
    assert.strictEqual(out.titles["王志強"], "長男");                           // 稱謂以被繼承人為準，不是「兄」
    assert.strictEqual(out.titles["張建國"], "次女之配偶");
    assert.ok(!out.follow.some(f => f.level === "必要" && f.text.includes("王淑娟")));
    assert.strictEqual(out.shares["張建國"], "1/10");
  },
  "第 3 步：用個人戶籍資料補上遺漏的王小平": () => {
    const c = newCase();
    importFile(c, "範例1_王大明_二親等資料.csv");
    importFile(c, "範例2_王淑娟_二親等資料.csv");
    const r = importFile(c, "範例3_王小平_個人戶籍資料.csv");
    assert.strictEqual(r.kind, "personal");
    assert.strictEqual(byName(c, "王小平").birthRaw, "93/12/1");               // 7 碼民國日期
    assert.strictEqual(byName(c, "王小平").father, byName(c, "王志偉").id);
    const out = compute(c);
    assert.strictEqual(out.titles["王小平"], "孫女");
    assert.deepStrictEqual(out.shares, { 王志強: "1/5", 王小安: "1/10", 王小平: "1/10", 王淑芬: "1/5",
      張小宇: "1/10", 張建國: "1/10", 林美華: "1/5" });
    // 拋棄查證：各層生存的繼承人
    const names = out.renounce.map(x => `${out.fam.p[x.pid].name}→${out.fam.p[x.target].name}`);
    assert.ok(names.includes("王淑芬→王大明") && names.includes("張建國→王淑娟") && names.includes("張小宇→王淑娟") && !names.includes("林美華→王淑娟"));
  },
  "第 4 步：查到王淑芬拋棄繼承 → 結果與原範例一致": () => {
    const c = newCase();
    ["範例1_王大明_二親等資料.csv", "範例2_王淑娟_二親等資料.csv", "範例3_王小平_個人戶籍資料.csv"].forEach(f => importFile(c, f));
    byName(c, "王淑芬").renounceChecks[c.decedent] = { status: "yes", court: "臺灣臺北地方法院", caseNo: "114年度司繼字第1號" };
    assert.deepStrictEqual(compute(c).shares, { 王志強: "1/4", 王小安: "1/8", 王小平: "1/8", 張小宇: "1/8", 張建國: "1/8", 林美華: "1/4" });
  },
  "資料不一致時提示，不默默覆蓋": () => {
    const c = newCase();
    importFile(c, "範例1_王大明_二親等資料.csv");
    const text = fs.readFileSync(path.join(DATA, "範例2_王淑娟_二親等資料.csv"), "utf8").replace("064/06/30,109/06/01", "064/06/30,109/06/02");
    const table = hhrReadTable(text.replace(/^﻿/, ""));
    const parsed = hhrParse(table, hhrGuessMapping(table.headers), "kin");
    const m = hhrMerge(c.persons, parsed, "B.csv", () => "X");
    assert.ok(m.conflicts.some(x => x.includes("王志偉") && x.includes("死亡日期")));
    assert.strictEqual(byName(c, "王志偉").deathRaw, "109/6/1");
  },
  "戶役政實際欄位：統號、變更註記自動對應，項目／查看略過": () => {
    const { text } = decodeBytes(fs.readFileSync(path.join(DATA, "範例1_王大明_二親等資料.csv")));
    const t = hhrReadTable(text);
    const m = hhrGuessMapping(t.headers);
    assert.deepStrictEqual(Object.keys(m).sort(), ["birth", "death", "fatherName", "fatherUid", "marriageDate", "motherName", "motherUid",
      "name", "nameNote", "relation", "spouseName", "spouseUid", "uid", "uidNote"].sort());
    assert.ok(!Object.values(m).includes(t.headers.indexOf("項目")) && !Object.values(m).includes(t.headers.indexOf("查看")));
    assert.strictEqual(hhrGuessKind(t.headers), "kin");
  },
  "無統號者以姓名＋出生日期跨檔合併": () => {
    const c = newCase();
    importFile(c, "範例1_王大明_二親等資料.csv");
    importFile(c, "範例2_王淑娟_二親等資料.csv");
    const fu = c.persons.filter(p => p.name === "王福來");
    assert.strictEqual(fu.length, 1);
    assert.strictEqual(fu[0].uid, "");
    assert.strictEqual(byName(c, "王大明").father, fu[0].id);
  },
  "姓名變更：父母姓名記為舊名，仍能連到改名後的人": () => {
    const c = newCase();
    const r = importFile(c, "範例1_王大明_二親等資料.csv");
    assert.deepStrictEqual(byName(c, "王淑芬").nameAliases, ["王淑華"]);
    assert.strictEqual(byName(c, "陳小美").mother, byName(c, "王淑芬").id);
    assert.ok(r.parsed.warnings.some(w => w.includes("姓名變更註記")));
    assert.ok(!r.link.warnings.some(w => w.includes("陳小美") && w.includes("王淑華")));
  },
  "性別由父母連結推得（匯出檔無性別欄）": () => {
    const c = newCase();
    importFile(c, "範例1_王大明_二親等資料.csv");
    assert.strictEqual(byName(c, "王大明").gender, "M");
    assert.strictEqual(byName(c, "林美華").gender, "F");
  },
  "欄位名稱不同也能對應": () => {
    const t = hhrReadTable("與本人關係,親屬姓名,身分證統一編號,出生年月日\n本人,甲,A000000001,0500101");
    const m = hhrGuessMapping(t.headers);
    assert.deepStrictEqual(Object.keys(m).sort(), ["birth", "name", "relation", "uid"]);
    assert.strictEqual(hhrGuessKind(t.headers), "kin");
  },
  "缺少本人列 → 擋下": () => {
    const t = hhrReadTable("稱謂,姓名,統一編號\n父,甲,A000000001");
    assert.ok(hhrParse(t, hhrGuessMapping(t.headers), "kin").errors.some(e => e.includes("本人")));
  },
};
let fail = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); console.log("通過", name); } catch (e) { fail++; console.log("失敗", name, "\n ", e.message); }
}
process.exit(fail ? 1 : 0);
