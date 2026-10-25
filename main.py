"""
用法：python main.py [家族資料.json] [輸出資料夾]
全程本機運算，不連網。
"""
import csv
import sys
from pathlib import Path

from inheritance import Family, InheritanceEngine, build_chart, share_table


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "data/sample_family.json")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "output")
    out.mkdir(parents=True, exist_ok=True)

    fam, decedent = Family.from_json(src)
    result = InheritanceEngine(fam).distribute(decedent)

    rows = share_table(fam, result)
    print(f"被繼承人：{fam.p[decedent].name}　繼承順序：{result.order}\n")
    for name, title, basis, share in rows:
        print(f"  {title:<6}{name:<5}{share:>6}　{basis}")

    with open(out / "應繼分明細.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["姓名", "稱謂", "繼承依據", "應繼分"])
        w.writerows(rows)

    chart = build_chart(fam, result)
    for fmt in ("pdf", "png", "svg"):
        chart.render(out / "繼承系統表", format=fmt, cleanup=True)
    print(f"\n已輸出至 {out.resolve()}")


if __name__ == "__main__":
    main()
