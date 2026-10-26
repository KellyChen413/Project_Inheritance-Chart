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

out = here.parent / "繼承系統表產生器.html"
out.write_text(html, encoding="utf-8")
print(out, f"{out.stat().st_size / 1024:.0f} KB")
