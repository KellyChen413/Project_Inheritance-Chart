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
    const text = fs.readFileSync(path.join(DATA, "範例2_王淑娟_二親等資料.csv"), "utf8").replace("0640630,1090601", "0640630,1090602");
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
  "稱謂「自己」視為被查詢人；日期 0370512 正確轉換": () => {
    const c = newCase();
    const r = importFile(c, "範例1_王大明_二親等資料.csv");
    assert.strictEqual(c.persons.find(p => p.uid === r.parsed.anchorUid).name, "王大明");
    assert.strictEqual(byName(c, "王大明").birthRaw, "37/5/12");
    assert.strictEqual(byName(c, "王福來").birthRaw, "9/2/1");
  },
  "姓名變更註記「*」：提示人工確認，母親姓名為舊名仍依母親統號連結": () => {
    const c = newCase();
    const r = importFile(c, "範例1_王大明_二親等資料.csv");
    assert.deepStrictEqual(byName(c, "王淑芬").nameAliases, []);
    assert.deepStrictEqual(byName(c, "王淑芬").changeNotes, ["姓名變更：有（匯出檔未載明）"]);
    assert.ok(r.parsed.warnings.some(w => w.includes("王淑芬") && w.includes("「*」")));
    assert.strictEqual(byName(c, "陳小美").mother, byName(c, "王淑芬").id);
    assert.strictEqual(r.parsed.warnings.filter(w => w.includes("變更註記")).length, 1);   // 空白不提示
  },
  "變更註記若載明舊名，仍會解析為曾用名": () => {
    const t = hhrReadTable("稱謂,姓名,統號,母親姓名,姓名變更註記\n自己,陳小美,A000000022,王淑華,\n母,王淑芬,A000000012,,原名王淑華");
    const parsed = hhrParse(t, hhrGuessMapping(t.headers), "kin");
    const persons = [];
    hhrMerge(persons, parsed, "x.csv", () => "N1");
    hhrLink(persons, [{ name: "x.csv", kind: "kin", anchor: parsed.anchorUid, rels: parsed.records.map(r => ({ uid: r.uid, relation: r.relation })) }]);
    assert.deepStrictEqual(persons.find(p => p.name === "王淑芬").nameAliases, ["王淑華"]);
    assert.strictEqual(persons.find(p => p.name === "陳小美").mother, "A000000012");
  },
  "noteValue：空白、-、無 視為無變更；* ＊ 視為有變更未載明": () => {
    const { noteValue } = require("./hhr.js");
    assert.deepStrictEqual(["", " ", "-", "無", "*", "＊", "**", "原名甲乙"].map(noteValue), ["", "", "", "", "*", "*", "*", "原名甲乙"]);
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
  "記事解析：死亡、更名、結婚、離婚、死亡宣告、收養": () => {
    const { parseMemo } = require("./hhr.js");
    const a = parseMemo("民國109年06月01日死亡　民國109年06月05日申請登記");
    assert.strictEqual(a.death, "109/6/1");
    assert.deepStrictEqual(parseMemo("民國090年03月15日更改姓名　原名：王淑華").oldNames, ["王淑華"]);
    const b = parseMemo("民國098年05月20日與張建國結婚 民國105年01月10日與張建國兩願離婚");
    assert.deepStrictEqual([b.marriages[0].name, b.divorces[0].name, b.divorces[0].date], ["張建國", "張建國", "105/1/10"]);
    const c = parseMemo("民國085年02月02日死亡宣告 推定死亡日期民國084年12月31日");
    assert.ok(c.deathDeclared); assert.strictEqual(c.death, "84/12/31");
    assert.strictEqual(parseMemo("民國060年5月1日父王福來死亡").death, "");     // 不是本人死亡
    assert.strictEqual(parseMemo("民國１００年２月３日於臺北市死亡").death, "100/2/3");  // 全形數字
    assert.ok(parseMemo("民國100年1月1日被王大明收養").adoption);
  },
  "謄本匯入：稱謂相對戶長、記事補死亡與離婚、與二親等資料合併": () => {
    const c = newCase();
    importFile(c, "範例1_王大明_二親等資料.csv");
    const t = hhrReadTable(["稱謂,姓名,統一編號,出生日期,父姓名,母姓名,配偶姓名,記事",
      "戶長,王志偉,A000000011,0640630,王大明,林美華,黃雅婷,民國109年06月01日死亡　民國109年06月05日申請登記",
      "妻,黃雅婷,A000000030,0660101,黃一,陳二,王志偉,民國088年03月01日與王志偉結婚",
      "長男,王小安,A000000020,0900808,王志偉,黃雅婷,,",
      "長女,王小平,A000000021,0931201,王志偉,黃雅婷,,"].join("\n"));
    assert.strictEqual(hhrGuessKind(t.headers), "household");
    const parsed = hhrParse(t, hhrGuessMapping(t.headers), "household");
    assert.deepStrictEqual(parsed.errors, []);
    assert.strictEqual(parsed.anchorUid, "A000000011");
    const m = hhrMerge(c.persons, parsed, "謄本", () => `N${c.seq++}`);
    assert.deepStrictEqual(m.conflicts, []);                                  // 王志偉死亡日期與二親等一致
    c.files.push({ name: "謄本", kind: "household", anchor: parsed.anchorUid, rels: parsed.records.map(r => ({ uid: r.uid, relation: r.relation })) });
    hhrLink(c.persons, c.files);
    assert.strictEqual(byName(c, "王小平").father, byName(c, "王志偉").id);
    assert.strictEqual(byName(c, "黃雅婷").spouse, byName(c, "王志偉").id);
    assert.ok(!c.queried.has(byName(c, "王志偉").id));                       // 謄本不算已調閱二親等
    assert.strictEqual(compute(c).shares["王小平"], "1/10");
  },
  "謄本記事離婚 → 前配偶不繼承": () => {
    const t = hhrReadTable(["稱謂,姓名,統一編號,出生日期,配偶姓名,記事",
      "戶長,李甲男,A000000101,0500101,陳乙女,民國070年1月1日與陳乙女結婚 民國100年1月1日與陳乙女兩願離婚 民國110年1月1日死亡",
      "長男,李丙男,A000000103,0720101,,"].join("\n"));
    const parsed = hhrParse(t, hhrGuessMapping(t.headers), "household");
    const rec = parsed.records[0];
    assert.deepStrictEqual([rec.death, rec.marriageEnd, rec.spouseName], ["110/1/1", "100/1/1", "陳乙女"]);
    assert.ok(parsed.warnings.some(w => w.includes("離婚")));
  },
  "適用法律時點：日據時期不計算、74年修法前提醒": () => {
    const { legalRegime } = require("./engine.js");
    assert.strictEqual(legalRegime("1945-10-24").code, "japanese");
    assert.ok(legalRegime("1945-10-24").block);
    assert.strictEqual(legalRegime("1945-10-25").code, "pre1985");
    assert.strictEqual(legalRegime("1985-06-04").code, "pre1985");
    assert.strictEqual(legalRegime("1985-06-05").code, "current");
  },
  "自動辨識：戶役政實際欄位不需手動對應": () => {
    const { hhrAutoCheck } = require("./hhr.js");
    for (const f of ["範例1_王大明_二親等資料.csv", "範例2_王淑娟_二親等資料.csv", "範例3_王小平_個人戶籍資料.csv"]) {
      const t = hhrReadTable(decodeBytes(fs.readFileSync(path.join(DATA, f))).text);
      const kind = hhrGuessKind(t.headers);
      const c = hhrAutoCheck(t.headers, hhrGuessMapping(t.headers), kind);
      assert.ok(c.confident, f);
      if (kind === "kin") assert.deepStrictEqual(c.unused, [], f);               // 16 欄全部用上（項目、查看略過）
    }
    const bad = hhrReadTable("名字欄,代碼\n甲,1");
    assert.ok(!hhrAutoCheck(bad.headers, hhrGuessMapping(bad.headers), "kin").confident);
  },
  "缺少自己／本人列 → 擋下": () => {
    const t = hhrReadTable("稱謂,姓名,統一編號\n父,甲,A000000001");
    assert.ok(hhrParse(t, hhrGuessMapping(t.headers), "kin").errors.some(e => e.includes("自己")));
  },
};
let fail = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); console.log("通過", name); } catch (e) { fail++; console.log("失敗", name, "\n ", e.message); }
}
process.exit(fail ? 1 : 0);
