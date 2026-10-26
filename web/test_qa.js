// 執行：node web/test_qa.js
// 依外部審查報告第九節 QA-01～QA-15 建立的表格驅動測試，另加婚姻終止、ID 重複等案例。
// 每個案例核對：繼承人名單、各人持分，以及必要的待確認事項。
const assert = require("assert");
const { Family, InheritanceEngine, finalShares, validate, Frac } = require("./engine.js");

const D = "2025-01-01";                       // 被繼承人 X 的死亡日（繼承開始日）
const P = (id, extra = {}) => ({ id, name: id, renounced: [], lost_right: [], ...extra });
const X = (extra = {}) => P("X", { death: D, ...extra });
function run(persons, did = "X") {
  const r = new InheritanceEngine(new Family(persons)).distribute(did);
  const shares = Object.fromEntries(Object.entries(finalShares(r)).map(([k, v]) => [k, v.toString()]));
  return { r, shares, pending: r.pendingAll.map(p => p.kind) };
}

const cases = {
  "QA-01 配偶＋2 名子女：各 1/3": () => {
    const { shares } = run([X({ spouse: "S" }), P("S"), P("C1", { father: "X" }), P("C2", { father: "X" })]);
    assert.deepStrictEqual(shares, { C1: "1/3", C2: "1/3", S: "1/3" });
  },
  "QA-02 配偶＋父母：配偶 1/2、父母各 1/4": () => {
    const { shares } = run([X({ spouse: "S", father: "F", mother: "M" }), P("S"), P("F"), P("M")]);
    assert.deepStrictEqual(shares, { F: "1/4", M: "1/4", S: "1/2" });
  },
  "QA-03 配偶＋兄弟姊妹 3 人：配偶 1/2、各 1/6": () => {
    const { shares } = run([X({ spouse: "S", father: "F" }), P("S"), P("F", { death: "2000-01-01" }),
      P("B1", { father: "F" }), P("B2", { father: "F" }), P("B3", { father: "F" })]);
    assert.deepStrictEqual(shares, { B1: "1/6", B2: "1/6", B3: "1/6", S: "1/2" });
  },
  "QA-04 配偶＋祖父母 2 人：配偶 2/3、各 1/6": () => {
    const { shares } = run([X({ spouse: "S", father: "F" }), P("S"), P("F", { death: "2000-01-01", father: "GF", mother: "GM" }), P("GF"), P("GM")]);
    assert.deepStrictEqual(shares, { GF: "1/6", GM: "1/6", S: "2/3" });
  },
  "QA-04b 無配偶、無子女，父母 2 人：各 1/2": () => {
    const { shares } = run([X({ father: "F", mother: "M" }), P("F"), P("M")]);
    assert.deepStrictEqual(shares, { F: "1/2", M: "1/2" });
  },
  "QA-04c 僅有配偶：配偶全部": () => {
    const { shares } = run([X({ spouse: "S" }), P("S")]);
    assert.deepStrictEqual(shares, { S: "1" });
  },
  "QA-05 子女先死亡留 2 名子女：代位者平分該房": () => {
    const { shares } = run([X({ spouse: "S" }), P("S"), P("C1", { father: "X", death: "2020-01-01" }), P("C2", { father: "X" }),
      P("G1", { father: "C1" }), P("G2", { father: "C1" })]);
    assert.deepStrictEqual(shares, { G1: "1/6", G2: "1/6", C2: "1/3", S: "1/3" });
  },
  "QA-06 子女喪失繼承權：其子女代位": () => {
    const { shares } = run([X(), P("C1", { father: "X", lost_right: ["X"] }), P("G", { father: "C1" }), P("C2", { father: "X" })]);
    assert.deepStrictEqual(shares, { G: "1/2", C2: "1/2" });
  },
  "QA-07 子女拋棄：其子女不代位，應繼分歸其他同順序繼承人": () => {
    const { shares } = run([X({ spouse: "S" }), P("S"), P("C1", { father: "X", renounced: ["X"] }), P("G", { father: "C1" }), P("C2", { father: "X" })]);
    assert.deepStrictEqual(shares, { C2: "1/2", S: "1/2" });
  },
  "QA-08 第一順位親等近者全體拋棄：次親等按人數與配偶平均（第1176條第5項）": () => {
    const { shares, r } = run([X({ spouse: "S" }), P("S"),
      P("C1", { father: "X", renounced: ["X"] }), P("C2", { father: "X", renounced: ["X"] }),
      P("G1", { father: "C1" }), P("G2", { father: "C1" }), P("G3", { father: "C2" })]);
    assert.deepStrictEqual(shares, { G1: "1/4", G2: "1/4", G3: "1/4", S: "1/4" });
    assert.ok(r.log.some(l => l.includes("第1176條第5項")));
  },
  "QA-09 一人拋棄、一人先死亡且無後代：先死亡者非繼承人，不影響「均拋棄」": () => {
    const { shares, r } = run([X({ spouse: "S" }), P("S"),
      P("C1", { father: "X", renounced: ["X"] }), P("G1", { father: "C1" }),
      P("C2", { father: "X", death: "2020-01-01" })]);
    assert.deepStrictEqual(shares, { G1: "1/2", S: "1/2" });
    assert.ok(r.log.some(l => l.includes("C2") && l.includes("不列入")));
  },
  "QA-09b 一人拋棄、一人先死亡但有後代代位：拋棄者子女不遞補": () => {
    const { shares } = run([X({ spouse: "S" }), P("S"),
      P("C1", { father: "X", renounced: ["X"] }), P("G1", { father: "C1" }),
      P("C2", { father: "X", death: "2020-01-01" }), P("G2", { father: "C2" })]);
    assert.deepStrictEqual(shares, { G2: "1/2", S: "1/2" });
  },
  "QA-09c 子女均先死亡且無後代、無人拋棄：由第二順序繼承，不往下遞補": () => {
    const { shares } = run([X({ spouse: "S", father: "F" }), P("S"), P("F"), P("C1", { father: "X", death: "2020-01-01" })]);
    assert.deepStrictEqual(shares, { F: "1/2", S: "1/2" });
  },
  "QA-10 胎兒待出生：保留應繼分並標示待確認": () => {
    const { shares, pending } = run([X({ spouse: "S" }), P("S"), P("FT", { father: "X", fetus: "pending" })]);
    assert.deepStrictEqual(shares, { FT: "1/2", S: "1/2" });
    assert.ok(pending.includes("fetus"));
  },
  "QA-10b 胎兒於繼承開始後活產（出生日晚於繼承開始日）：仍為繼承人": () => {
    const { shares, pending } = run([X({ spouse: "S" }), P("S"), P("FT", { father: "X", fetus: "live", birth: "2025-05-01" })]);
    assert.deepStrictEqual(shares, { FT: "1/2", S: "1/2" });
    assert.ok(!pending.includes("fetus"));
  },
  "QA-10c 胎兒死產：不具繼承資格（民法第7條）": () => {
    const { shares } = run([X({ spouse: "S", father: "F" }), P("S"), P("F"), P("FT", { father: "X", fetus: "stillbirth" })]);
    assert.deepStrictEqual(shares, { F: "1/2", S: "1/2" });
  },
  "QA-11 同日死亡、時間可證明配偶較晚死亡：配偶為繼承人並再轉繼承": () => {
    const { shares, pending, r } = run([X({ spouse: "S", father: "F", deathTime: "08:00" }),
      P("S", { death: D, deathTime: "10:00", father: "SF" }), P("SF", { death: "2000-01-01" }), P("SB", { father: "SF" }), P("F")]);
    assert.deepStrictEqual(shares, { F: "1/2", SB: "1/2" });
    assert.ok(r.retransfers.S);
    assert.ok(!pending.includes("same-day"));
  },
  "QA-11b 同日死亡、時間可證明配偶較早死亡：配偶不繼承": () => {
    const { shares } = run([X({ spouse: "S", father: "F", deathTime: "10:00" }), P("S", { death: D, deathTime: "08:00" }), P("F")]);
    assert.deepStrictEqual(shares, { F: "1" });
  },
  "QA-12 同日死亡、先後不明：依第11條推定同時死亡，並標示待確認": () => {
    const { shares, pending } = run([X({ spouse: "S", father: "F" }), P("S", { death: D }), P("F")]);
    assert.deepStrictEqual(shares, { F: "1" });
    assert.ok(pending.includes("same-day"));
  },
  "QA-12b 子女與被繼承人同時死亡：其子女仍得代位（通說）並標示待確認": () => {
    const { shares, pending } = run([X(), P("C1", { father: "X", death: D }), P("G", { father: "C1" }), P("C2", { father: "X" })]);
    assert.deepStrictEqual(shares, { G: "1/2", C2: "1/2" });
    assert.ok(pending.includes("same-day"));
  },
  "QA-13 重複 ID：建立家族時阻擋": () => {
    assert.throws(() => new Family([P("X"), P("X")]), /ID 重複/);
    const v = validate([{ ...X(), _deathRaw: "x" }, { ...P("X") }], "X");
    assert.ok(v.errors.some(e => e.includes("重複")));
  },
  "QA-13b 祖父母經兩個父母分支重複出現：只計一次": () => {
    const { shares } = run([X({ father: "F", mother: "M" }), P("F", { death: "2000-01-01", father: "G" }), P("M", { death: "2000-01-01", father: "G" }), P("G")]);
    assert.deepStrictEqual(shares, { G: "1" });
  },
  "QA-13c 親子迴圈：阻擋": () => {
    const v = validate([P("A", { father: "B", death: D }), P("B", { father: "A" })], "A");
    assert.ok(v.errors.some(e => e.includes("迴圈")));
  },
  "QA-14 查無繼承人：不輸出確定無人承受": () => {
    const { r, shares } = run([X()]);
    assert.deepStrictEqual(shares, {});
    assert.strictEqual(r.caseStatus, "no_known_heirs");
    assert.ok(!r.order.includes("無人承受（第1177條）") && r.order.includes("查無"));
  },
  "QA-15 再轉繼承跨多層：持分守恆且可追溯": () => {
    const { shares, r } = run([X(), P("A", { father: "X", death: "2025-03-01" }), P("B", { father: "A", death: "2025-06-01", spouse: "W" }), P("W")]);
    assert.deepStrictEqual(shares, { W: "1" });
    assert.ok(r.retransfers.A && r.retransfers.A.retransfers.B);
  },
  "婚姻於繼承開始前終止（離婚）：前配偶不繼承": () => {
    const { shares, r } = run([X({ spouse: "S", father: "F", marriageEnd: "2010-01-01" }), P("S"), P("F")]);
    assert.deepStrictEqual(shares, { F: "1" });
    assert.ok(Object.values(r.notes).some(n => n.includes("婚姻")));
  },
  "分數安全：分母為零與非整數除數皆拋出錯誤": () => {
    assert.throws(() => new Frac(1, 0));
    assert.throws(() => new Frac(1, 2).div(0));
    assert.throws(() => new Frac(1, 2).div(1.5));
  },
};

let fail = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); console.log("通過", name); } catch (e) { fail++; console.log("失敗", name, "\n ", e.message.split("\n").slice(0, 6).join("\n  ")); }
}
console.log(`\n${Object.keys(cases).length - fail}/${Object.keys(cases).length} 通過`);
process.exit(fail ? 1 : 0);
