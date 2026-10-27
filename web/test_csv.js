// 執行：node web/test_csv.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Family, InheritanceEngine, finalShares, parseDate } = require("./engine.js");
const { decodeBytes, importCsv, exportCsv } = require("./csv.js");

const shares = data => {
  const persons = data.persons.map(p => ({ ...p, birth: parseDate(p.birth) || null, death: parseDate(p.death) || null }));
  const r = finalShares(new InheritanceEngine(new Family(persons)).distribute(data.decedent));
  const byName = Object.fromEntries(data.persons.map(p => [p.id, p.name]));
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [byName[k], v.toString()]));
};
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/sample_family.json"), "utf8"));
const expected = { 王志強: "1/4", 王小安: "1/8", 王小平: "1/8", 張小宇: "1/8", 張建國: "1/8", 林美華: "1/4" };

const cases = {
  "喪失繼承權第1145條：款別、宥恕、代位、備註": () => {
    const csv = ["稱謂,姓名,性別,出生日期,死亡日期,父,母,配偶,喪失",
      "被繼承人,甲父,男,0400101,1140101,,,,",
      "長男,乙子,男,0650101,,甲父,,,第1款",
      "長男之子,乙孫,男,0900101,,乙子,,,",
      "次男,丙子,男,0670101,,甲父,,,第3款，經宥恕",
      "長女,丁女,女,0690101,,甲父,,,第5款，經宥恕"].join("\n");
    const { data, warnings } = importCsv(csv);
    assert.ok(warnings.some(w => w.includes("第5款不適用宥恕")));
    // 乙子喪失 → 乙孫代位；丙子第3款經宥恕 → 仍繼承；丁女第5款不適用宥恕 → 喪失且無子女
    assert.deepStrictEqual(shares(data), { 乙孫: "1/2", 丙子: "1/2" });
    const { buildRemarks, applicableRules } = require("./engine.js");
    const persons = data.persons.map(p => ({ ...p, birth: parseDate(p.birth) || null, death: parseDate(p.death) || null, lostDetail: p.lostChecks || {} }));
    const fam = new Family(persons);
    const res = new InheritanceEngine(fam).distribute(data.decedent);
    const R = buildRemarks(fam, res);
    const id = n => persons.find(p => p.name === n).id;
    assert.ok(R[id("乙子")].text.includes("第1145條第1項第1款") && R[id("乙子")].text.includes("代位"));
    assert.ok(R[id("丁女")].text.includes("第5款"));
    const rules = applicableRules(fam, res).map(r => r.title + r.text).join("\n");
    assert.ok(rules.includes("丙子對甲父雖有第1145條第1項第3款情事，經被繼承人宥恕"));
    // 匯出再匯入保留款別
    const back = importCsv(exportCsv(data.persons.map(p => ({ ...p })), data.decedent)).data;
    assert.deepStrictEqual(back.persons.find(p => p.name === "丙子").lostChecks, { [back.decedent]: { clause: "3", forgiven: true } });
  },
  "匯出再匯入，結果不變": () => {
    const { data, errors } = importCsv(decodeBytes(Buffer.from(exportCsv(sample.persons, sample.decedent))).text);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(shares(data), expected);
  },
  "用姓名填父母、不填編號、民國日期多種寫法": () => {
    const csv = [
      "稱謂,姓名,性別,出生日期,死亡日期,父,母,配偶,拋棄",
      "被繼承人,王大明,男,民國37年5月12日,114/3/10,,,林美華,",
      "配偶,林美華,女,40/9/3,,,,王大明,",
      "長男,王志強,男,1972-01-20,,王大明,林美華,,",
      "長女,王淑芬,女,67.10.5,,王大明,林美華,,是",
    ].join("\r\n");
    const { data, errors } = importCsv(csv);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(data.persons[0].birth, "民國37年5月12日");
    assert.deepStrictEqual(shares(data), { 王志強: "1/2", 林美華: "1/2" });
  },
  "Big5 編碼（Excel 中文版預設）": () => {
    const big5 = fs.readFileSync(path.join(__dirname, "../data/範本_Big5.csv"));
    const { text, encoding } = decodeBytes(big5);
    assert.strictEqual(encoding, "Big5");
    const { data, errors } = importCsv(text);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(shares(data), expected);
  },
  "父母不在名單中 → 擋下並指出列號": () => {
    const { data, errors } = importCsv("稱謂,姓名,父\n被繼承人,王大明,王老先生");
    assert.strictEqual(data, null);
    assert.ok(errors[0].includes("第 2 列") && errors[0].includes("王老先生"));
  },
  "同名參照 → 要求改填編號": () => {
    const { errors } = importCsv("編號,姓名,父\nA1,陳明,\nA2,陳明,\nA3,陳小華,陳明");
    assert.ok(errors.some(e => e.includes("同名")));
    const ok = importCsv("編號,姓名,父\nA1,陳明,\nA2,陳明,\nA3,陳小華,A2");
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.data.persons[2].father, "A2");
  },
  "再轉部分的拋棄填姓名": () => {
    const csv = exportCsv(sample.persons, sample.decedent).replace(/(P23,外孫,張小宇,男,[^\r]*?,張建國,王淑娟,,),/, "$1王淑娟,");
    const { data, errors } = importCsv(decodeBytes(Buffer.from(csv)).text);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(data.persons.find(p => p.name === "張小宇").renounced, ["P13"]);
    assert.strictEqual(shares(data).林美華, "3/8");
  },
  "Tab 分隔、前面有說明列、未知欄位": () => {
    const { data, errors, warnings } = importCsv("王大明繼承案\n稱謂\t姓名\t死亡日期\t地址\n被繼承人\t王大明\t114/3/10\t台北市");
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(data.decedent, data.persons[0].id);
    assert.ok(warnings.some(w => w.includes("地址")));
  },
};
let fail = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); console.log("通過", name); } catch (e) { fail++; console.log("失敗", name, "\n ", e.message); }
}
process.exit(fail ? 1 : 0);
