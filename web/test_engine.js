// 執行：node web/test_engine.js　（與 Python 版 tests/test_engine.py 相同情境）
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Family, InheritanceEngine, finalShares, validate, parseDate, buildRemarks } = require("./engine.js");

const D = "2025-01-01";
const P = (id, extra = {}) => ({ id, name: id, ...extra });
const run = (persons, did = "X") => {
  const r = finalShares(new InheritanceEngine(new Family(persons)).distribute(did));
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toString()]));
};

const cases = {
  "範例案件（與 Python 版比對）": () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/sample_family.json"), "utf8"));
    assert.deepStrictEqual(run(raw.persons, raw.decedent),
      { P10: "1/4", P20: "1/8", P21: "1/8", P31: "1/8", P23: "1/8", P02: "1/4" });
  },
  "再轉繼承人僅拋棄再轉部分": () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/sample_family.json"), "utf8"));
    raw.persons.find(p => p.id === "P23").renounced = ["P13"];   // 張小宇拋棄王淑娟之遺產
    assert.deepStrictEqual(run(raw.persons, raw.decedent),
      { P10: "1/4", P20: "1/8", P21: "1/8", P31: "1/8", P02: "3/8" });
  },
  "備註：被代位人之配偶、拋棄者子女": () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/sample_family.json"), "utf8"));
    const fam = new Family(raw.persons);
    const R = buildRemarks(fam, new InheritanceEngine(fam).distribute(raw.decedent));
    assert.ok(R.P30.text.includes("配偶不得代位"));
    assert.ok(R.P22.text.includes("拋棄不發生代位"));
    assert.strictEqual(R.P12.kind, "renounced");
    assert.strictEqual(R.P13.kind, "retrans");
    assert.ok(R.P11.text.includes("王小安、王小平代位繼承"));
  },
  "配偶與父母，配偶 1/2": () => assert.deepStrictEqual(
    run([P("X", { death: D, father: "F", mother: "M", spouse: "S" }), P("S"), P("F"), P("M")]),
    { F: "1/4", M: "1/4", S: "1/2" }),
  "配偶與祖父母，配偶 2/3": () => assert.deepStrictEqual(
    run([P("X", { death: D, father: "F", spouse: "S" }), P("S"), P("F", { death: "2000-01-01", father: "GF" }), P("GF")]),
    { GF: "1/3", S: "2/3" }),
  "兄弟姊妹不適用代位": () => assert.deepStrictEqual(
    run([P("X", { death: D, father: "F" }), P("F", { death: "2000-01-01" }), P("B1", { father: "F" }),
      P("B2", { father: "F", death: "2020-01-01" }), P("N", { father: "B2" })]),
    { B1: "1" }),
  "子女全部拋棄，孫輩按人數繼承": () => assert.deepStrictEqual(
    run([P("X", { death: D }), P("C1", { father: "X", renounced: ["X"] }), P("C2", { mother: "X", renounced: ["X"] }),
      P("G1", { father: "C1" }), P("G2", { father: "C1" }), P("G3", { mother: "C2" })]),
    { G1: "1/3", G2: "1/3", G3: "1/3" }),
  "同日死亡推定互不繼承": () => assert.deepStrictEqual(
    run([P("X", { death: D, spouse: "S" }), P("S", { death: D }), P("C", { father: "X" })]),
    { C: "1" }),
  "喪失繼承權觸發代位": () => assert.deepStrictEqual(
    run([P("X", { death: D }), P("C1", { father: "X", lost_right: ["X"] }), P("G", { father: "C1" }), P("C2", { father: "X" })]),
    { G: "1/2", C2: "1/2" }),
  "民國日期解析": () => {
    assert.strictEqual(parseDate("114/3/10"), "2025-03-10");
    assert.strictEqual(parseDate("民國114年3月10日"), "2025-03-10");
    assert.strictEqual(parseDate("2025-03-10"), "2025-03-10");
    assert.strictEqual(parseDate("114/2/30"), undefined);
    assert.strictEqual(parseDate("9/2/1"), "1920-02-01");
  },
  "輸入檢查：親屬迴圈": () => {
    const v = validate([P("A", { father: "B", death: D }), P("B", { father: "A" })], "A");
    assert.ok(v.errors.some(e => e.includes("迴圈")));
  },
};

let fail = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); console.log("通過", name); } catch (e) { fail++; console.log("失敗", name, "\n ", e.message); }
}
process.exit(fail ? 1 : 0);
