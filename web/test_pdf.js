// 執行：npm install pdfjs-dist@3.11.174（於任一資料夾），再執行
//       node web/test_pdf.js <該資料夾> data/pdf
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const [, , pdfjsDir, pdfDir] = process.argv;
const lib = require(path.join(pdfjsDir, "node_modules/pdfjs-dist/legacy/build/pdf.js"));
const cmapDir = path.join(pdfjsDir, "node_modules/pdfjs-dist/cmaps");
const cmap = name => { const f = path.join(cmapDir, name + ".bcmap"); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; };
const { pdfReadTable } = require("./pdfread.js");
const { hhrGuessKind, hhrGuessMapping, hhrParse } = require("./hhr.js");
const read = f => pdfReadTable(new Uint8Array(fs.readFileSync(path.join(pdfDir, f))), { lib, cmap });

const cases = {
  "二親等表格（非內嵌中文字型、跨頁、儲存格換行）": async () => {
    const t = await read("範例1_王大明_二親等資料.pdf");
    assert.strictEqual(t.meta.mode, "table");
    assert.strictEqual(t.meta.pages, 2);
    assert.deepStrictEqual(t.headers, ["稱謂", "姓名", "統一編號", "性別", "出生日期", "死亡日期", "父姓名", "母姓名", "配偶姓名"]);
    assert.strictEqual(t.body.length, 12);                          // 含無統一編號的王福來
    assert.ok(t.body.some(r => r[1] === "王福來" && r[2] === ""));
    const wei = t.body.find(r => r[1] === "王志偉");
    assert.strictEqual(wei[8], "黃雅婷");                          // 換行合併
    assert.strictEqual(hhrGuessKind(t.headers), "kin");
    const p = hhrParse(t, hhrGuessMapping(t.headers), "kin");
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(p.anchorUid, "A000000001");
    assert.strictEqual(p.records.find(r => r.name === "王小安").fatherName, "王志偉");
  },
  "戶役政實際 16 欄版面：兩行表頭、無統號列、變更註記 *，結果與 CSV 一致": async () => {
    const t = await read("範例5_王大明_二親等資料_實際版面.pdf");
    assert.strictEqual(t.meta.mode, "table");
    assert.deepStrictEqual(t.meta.notes, []);
    const { decodeBytes } = require("./csv.js");
    const { hhrReadTable } = require("./hhr.js");
    const csv = hhrReadTable(decodeBytes(fs.readFileSync(path.join(__dirname, "../data/範例1_王大明_二親等資料.csv"))).text);
    assert.deepStrictEqual(t.headers, csv.headers);
    assert.deepStrictEqual(t.body, csv.body.map(r => r.map(v => v.trim())));
    const p = hhrParse(t, hhrGuessMapping(t.headers), hhrGuessKind(t.headers));
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(p.anchorUid, "A000000001");
  },
  "LibreOffice 匯出的表格（內嵌字型）": async () => {
    const t = await read("範例2_王淑娟_二親等資料.pdf");
    assert.strictEqual(t.meta.mode, "table");
    assert.strictEqual(t.body.length, 10);
    const p = hhrParse(t, hhrGuessMapping(t.headers), hhrGuessKind(t.headers));
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(p.records.find(r => r.name === "張建國").spouseName, "王淑娟");
  },
  "個人戶籍資料（欄位名稱：值的表單）": async () => {
    const t = await read("範例3_王小平_個人戶籍資料.pdf");
    assert.strictEqual(t.meta.mode, "form");
    assert.strictEqual(hhrGuessKind(t.headers), "personal");
    const p = hhrParse(t, hhrGuessMapping(t.headers), "personal");
    assert.deepStrictEqual(p.errors, []);
    const r = p.records[0];
    assert.strictEqual(r.name, "王小平"); assert.strictEqual(r.uid, "A000000021");
    assert.strictEqual(r.fatherName, "王志偉"); assert.strictEqual(r.birth, "093/12/01");
    assert.strictEqual(r.death, "");                       // 空白欄不可抓到下一行的「父姓名」
    assert.strictEqual(r.spouseName, "");
  },
  "掃描影像 PDF（沒有文字）": async () => {
    const t = await read("範例4_掃描影像.pdf");
    assert.strictEqual(t.meta.scanned, true);
  },
};
(async () => {
  let fail = 0;
  for (const [name, fn] of Object.entries(cases)) {
    try { await fn(); console.log("通過", name); } catch (e) { fail++; console.log("失敗", name, "\n ", e.message); }
  }
  process.exit(fail ? 1 : 0);
})();
