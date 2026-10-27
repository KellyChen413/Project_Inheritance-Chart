// 執行：node web/test_excel.js　（先執行 python tools/make_sample_excel.py 產生測試檔）
// 各種 Excel 匯出檔讀入後，結果必須與 CSV 完全一致
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { excelReadRows, xlKind, xlSerialToIso } = require("./excel.js");
const { decodeBytes } = require("./csv.js");
const { hhrReadTable, hhrTableFromRows, hhrGuessMapping, hhrGuessKind, hhrParse, hhrMerge } = require("./hhr.js");

const DATA = path.join(__dirname, "../data");
const summary = table => {
  const parsed = hhrParse(table, hhrGuessMapping(table.headers), hhrGuessKind(table.headers));
  assert.deepStrictEqual(parsed.errors, []);
  const persons = []; let n = 1;
  hhrMerge(persons, parsed, "x", () => `N${n++}`);
  return { kind: hhrGuessKind(table.headers), anchor: parsed.anchorUid,
    persons: persons.map(p => [p.uid, p.name, p.birthRaw, p.deathRaw, p.marriageDateRaw, p.fatherUid, p.motherUid, p.spouseUid, p.fatherName, p.motherName, (p.changeNotes || []).join()].join("|")) };
};
const fromCsv = f => summary(hhrReadTable(decodeBytes(fs.readFileSync(path.join(DATA, f))).text));
const expect1 = fromCsv("範例1_王大明_二親等資料.csv"), expect2 = fromCsv("範例2_王淑娟_二親等資料.csv");

const cases = {};
for (const [file, expect, fmt] of [
  ["範例1_文字.xlsx", expect1, "xlsx"], ["範例1_數字日期.xlsx", expect1, "xlsx"], ["範例1_日期格式.xlsx", expect1, "xlsx"],
  ["範例1_舊版.xls", expect1, "xls"], ["範例1_網頁格式.xls", expect1, "html"], ["範例2_LibreOffice.xls", expect2, "xls"],
]) {
  cases[`${file} 與 CSV 匯入結果一致`] = async () => {
    const buf = fs.readFileSync(path.join(DATA, "excel", file));
    assert.strictEqual(xlKind(new Uint8Array(buf)), fmt);
    const sheet = await excelReadRows(new Uint8Array(buf));
    assert.strictEqual(sheet.format, fmt);
    const got = summary(hhrTableFromRows(sheet.rows));
    assert.deepStrictEqual(got, expect);
  };
}
cases["日期序號換算"] = async () => {
  assert.strictEqual(xlSerialToIso(17665), "1948-05-12");
  assert.strictEqual(xlSerialToIso(45726), "2025-03-10");
};
cases["非 Excel 檔 → 明確錯誤"] = async () => {
  await assert.rejects(excelReadRows(new TextEncoder().encode("hello")), /無法辨識/);
};

(async () => {
  let fail = 0;
  for (const [name, fn] of Object.entries(cases)) {
    try { await fn(); console.log("通過", name); } catch (e) { fail++; console.log("失敗", name, "\n ", e.message.slice(0, 1500)); }
  }
  process.exit(fail ? 1 : 0);
})();
