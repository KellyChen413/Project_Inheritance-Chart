"""把 engine.js、chart.js、app.js 與範例資料組成單一 HTML 檔：python web/build.py"""
import json
from pathlib import Path

here = Path(__file__).parent
html = (here / "template.html").read_text(encoding="utf-8")
engine = (here / "engine.js").read_text(encoding="utf-8").replace(
    'if (typeof module !== "undefined") module.exports', "// module.exports")
sample = json.loads((here.parent / "data/sample_family.json").read_text(encoding="utf-8"))

samples = [{"name": f.name, "text": f.read_text(encoding="utf-8-sig")}
           for f in sorted((here.parent / "data").glob("範例*_*.csv"))]
html = html.replace("/*HHR_SAMPLES*/", json.dumps(samples, ensure_ascii=False).replace("</", "<\\/"))
html = (html.replace("/*SAMPLE*/", json.dumps(sample, ensure_ascii=False).replace("</", "<\\/"))
            .replace("/*ENGINE*/", engine)
            .replace("/*CHART*/", (here / "chart.js").read_text(encoding="utf-8") + "\n" +
                     (here / "csv.js").read_text(encoding="utf-8")
                     .replace('const _parseDate = typeof parseDate === "function" ? parseDate : require("./engine.js").parseDate;', "const _parseDate = parseDate;")
                     .replace('if (typeof module !== "undefined") module.exports', "// module.exports") + "\n" +
                     (here / "hhr.js").read_text(encoding="utf-8").replace('if (typeof module !== "undefined") module.exports', "// module.exports") + "\n" +
                     (here / "casework.js").read_text(encoding="utf-8").replace('if (typeof module !== "undefined") module.exports', "// module.exports") + "\n" +
                     (here / "xlsx.js").read_text(encoding="utf-8").replace('if (typeof module !== "undefined") module.exports', "// module.exports") + "\n" +
                     (here / "pdfread.js").read_text(encoding="utf-8").replace('if (typeof module !== "undefined") module.exports', "// module.exports"))
            .replace("/*APP*/", (here / "app.js").read_text(encoding="utf-8")))

# PDF 讀取元件（pdf.js 3.11.174，Apache-2.0）與繁中字碼表，內嵌於頁面
import base64
vendor = here / "vendor"
safe = lambda js: js.replace("</script", "<\\/script").replace("<!--", "<\\!--")
cmaps = {f.stem: base64.b64encode(f.read_bytes()).decode() for f in sorted((vendor / "cmaps").glob("*.bcmap"))}
html = (html.replace("/*PDFJS_WORKER*/", safe((vendor / "pdf.worker.min.js").read_text(encoding="utf-8")))
            .replace("/*PDFJS*/", safe((vendor / "pdf.min.js").read_text(encoding="utf-8")))
            .replace("/*CMAPS*/", json.dumps(cmaps)))

# Inter 字型（拉丁字母與數字，SIL OFL 1.1），以 data URI 內嵌；中文沿用系統字型
faces = "\n".join(
    f'@font-face {{ font-family: "Inter"; font-style: normal; font-weight: {w}; font-display: swap; '
    f'src: url(data:font/woff2;base64,{base64.b64encode((vendor / "fonts" / f"inter-latin-{w}-normal.woff2").read_bytes()).decode()}) format("woff2"); '
    f'unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }}'
    for w in (400, 500, 600, 700))
html = html.replace("/*FONTS*/", faces)

# 安全政策：以 SHA-256 雜湊只允許本檔案內既有的 <script> 與 <style>（JSON 資料區塊不會執行，不需列入）
import hashlib, re
def _hash(t): return "'sha256-" + base64.b64encode(hashlib.sha256(t.encode("utf-8")).digest()).decode() + "'"
_body = html[html.index("</head>"):]
_scripts = re.findall(r"<script>(.*?)</script>", _body, re.S)
_styles = re.findall(r"<style>(.*?)</style>", html[html.index("<title>"):html.index("</head>")], re.S)
assert len(_scripts) == 3 and len(_styles) == 1, (len(_scripts), len(_styles))
html = html.replace("__SCRIPT_HASHES__", " ".join(_hash(x) for x in _scripts)).replace("__STYLE_HASHES__", " ".join(_hash(x) for x in _styles))

out = here.parent / "繼承系統表產生器.html"
out.write_text(html, encoding="utf-8")
print(out, f"{out.stat().st_size / 1024:.0f} KB")
