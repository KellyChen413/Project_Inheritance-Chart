"""產生測試用的虛構 PDF（data/pdf）。需要 reportlab、Pillow；範例2 另以 LibreOffice 由 CSV 轉出。
python tools/make_sample_pdfs.py
"""
import csv
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics, cidfonts

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)
# 繁體中文、不內嵌字型（Adobe-CNS1）；修正 reportlab 預設對照把 MSung-Light 配到簡體編碼的問題
cidfonts.defaultUnicodeEncodings["MSung-Light"] = ("cht", "UniCNS-UCS2-H")
pdfmetrics.registerFont(cidfonts.UnicodeCIDFont("MSung-Light"))
F = "MSung-Light"

# 範例1：二親等資料，2 頁、每頁重複表頭、頁碼、一格換行
rows = list(csv.reader(open(ROOT / "data/範例1_王大明_二親等資料.csv", encoding="utf-8-sig")))
# PDF 範例沿用較精簡的 9 欄版面，示範不同格式也能讀取
cols = ["稱謂", "姓名", "統一編號", "性別", "出生日期", "死亡日期", "父姓名", "母姓名", "配偶姓名"]
src = {"父姓名": "父親姓名", "母姓名": "母親姓名"}
idx = {h: i for i, h in enumerate(rows[0])}
def pick(r, c):
    if c == "性別": return {"長男": "男", "次男": "男", "弟": "男", "孫": "男", "外孫": "男", "長女": "女", "次女": "女", "外孫女": "女", "母": "女", "配偶": "女", "父": "男", "本人": "男"}.get(r[idx["稱謂"]], "")
    return r[idx[src.get(c, c)]]
head, data = cols, [[pick(r, c) for c in cols] for r in rows[1:]]
W, H = landscape(A4)
xs = [40, 95, 160, 265, 315, 395, 475, 555, 635]
c = canvas.Canvas(str(OUT / "範例1_王大明_二親等資料.pdf"), pagesize=(W, H))
for pi, chunk in enumerate([data[:7], data[7:]]):
    c.setFont(F, 16); c.drawString(40, H - 50, "戶役政資訊系統　親等關聯資料查詢結果（虛構範例）")
    c.setFont(F, 10); c.drawString(40, H - 72, "查詢對象：王大明　查詢範圍：二親等")
    for x, h in zip(xs, head): c.drawString(x, H - 100, h)
    c.line(35, H - 105, W - 35, H - 105)
    c.drawString(W / 2 - 30, 30, f"第 {pi + 1} 頁／共 2 頁")
    y = H - 125
    for r in chunk:
        for x, v in zip(xs, r):
            if r[1] == "王志偉" and v == "黃雅婷":
                c.drawString(x, y, "黃雅"); c.drawString(x, y - 12, "婷"); continue
            c.drawString(x, y, v)
        y -= 34 if r[1] == "王志偉" else 26
    c.showPage()
c.save()

# 範例3：個人戶籍資料，「欄位名稱：值」表單格式
c = canvas.Canvas(str(OUT / "範例3_王小平_個人戶籍資料.pdf"), pagesize=A4)
W2, H2 = A4
c.setFont(F, 16); c.drawString(50, H2 - 60, "個人戶籍資料（虛構範例）")
c.setFont(F, 11)
for i, t in enumerate(["統一編號：A000000021　　姓名：王小平　　性別：女", "出生日期：093/12/01　　死亡日期：",
                       "父姓名：王志偉　　母姓名：黃雅婷　　配偶姓名：", "戶籍地址：（虛構）"]):
    c.drawString(50, H2 - 100 - i * 24, t)
c.save()
print("完成：", OUT)
