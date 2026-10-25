"""
繼承系統表樹狀圖：讀取 Family 與 Result，用 Graphviz 在本機輸出 PDF / PNG / SVG。
不連網、不呼叫任何外部服務。
"""
from __future__ import annotations

from collections import deque
from datetime import date
from fractions import Fraction
from html import escape

import graphviz

from .engine import Family, Result

FONT = "Noto Sans CJK TC"   # Windows 可改 "Microsoft JhengHei"，macOS 可改 "PingFang TC"

COLORS = {
    "decedent": ("#FBE3E1", "#B3261E"),
    "heir":     ("#E3F2E6", "#1E6B34"),
    "retrans":  ("#FFF4D6", "#8A6100"),
    "excluded": ("#F1F1F1", "#8C8C8C"),
}


def roc(d: date | None) -> str:
    return f"民國{d.year - 1911}年{d.month}月{d.day}日" if d else ""


def frac(f: Fraction) -> str:
    return str(f.numerator) if f.denominator == 1 else f"{f.numerator}/{f.denominator}"


def _generations(fam: Family, root: str) -> dict[str, int]:
    gen, q = {root: 0}, deque([root])
    while q:
        pid = q.popleft()
        p = fam.p[pid]
        nxt = [(c.id, gen[pid] + 1) for c in fam.children(pid)]
        nxt += [(x.id, gen[pid] - 1) for x in fam.parents(pid)]
        if p.spouse and p.spouse in fam.p:
            nxt.append((p.spouse, gen[pid]))
        for nid, g in nxt:
            if nid not in gen:
                gen[nid] = g
                q.append(nid)
    return gen


def build_chart(fam: Family, result: Result) -> graphviz.Digraph:
    did = result.decedent_id
    dec = fam.p[did]
    first = {s.person_id: s for s in result.shares}
    final = result.final_shares()

    # 再轉繼承的子結果裡也有說明（例如再轉時拋棄）
    sub_notes = {}
    for heir_id, sub in result.retransfers.items():
        for s in sub.shares:
            sub_notes[s.person_id] = f"再轉繼承（自{fam.p[heir_id].name}）"
        for pid, n in sub.notes.items():
            sub_notes.setdefault(pid, f"{n}（{fam.p[heir_id].name}部分）")

    g = graphviz.Digraph("inheritance", format="pdf")
    g.attr(rankdir="TB", splines="polyline", ordering="out", nodesep="0.4", ranksep="0.55",
           fontname=FONT, labelloc="t", fontsize="20",
           label=f"繼承系統表\n被繼承人：{dec.name}（{roc(result.opened_on)}死亡）　繼承順序：{result.order}\n ")
    g.attr("node", shape="box", style="rounded,filled", fontname=FONT, fontsize="11", margin="0.12,0.06")
    g.attr("edge", arrowhead="none", color="#555555")

    for pid, p in fam.p.items():
        lines = [f"<B>{escape(p.title)}</B>" if p.title else "", f"<FONT POINT-SIZE='13'>{escape(p.name)}</FONT>"]
        if p.birth:
            lines.append(f"<FONT POINT-SIZE='9'>{roc(p.birth)}生</FONT>")
        if p.death:
            lines.append(f"<FONT POINT-SIZE='9'>{roc(p.death)}歿</FONT>")

        if pid == did:
            kind = "decedent"
            lines.append("<B>被繼承人</B>")
        elif pid in result.retransfers:
            kind = "retrans"
            lines.append(f"原應繼分 {frac(first[pid].share)}")
            lines.append("<B>繼承開始後死亡 → 再轉繼承</B>")
        elif pid in final:
            kind = "heir"
            if pid in first:
                basis = first[pid].basis
            else:
                basis = sub_notes.get(pid, "")
            lines.append(f"<FONT POINT-SIZE='9'>{escape(basis)}</FONT>")
            lines.append(f"<B>應繼分 {frac(final[pid])}</B>")
        else:
            kind = "excluded"
            note = result.notes.get(pid) or sub_notes.get(pid) or "非繼承人"
            lines.append(f"<FONT POINT-SIZE='9'>{escape(note)}</FONT>")

        fill, line = COLORS[kind]
        label = "<" + "<BR/>".join(x for x in lines if x) + ">"
        attrs = dict(label=label, fillcolor=fill, color=line, fontcolor="#1A1A1A")
        if kind == "decedent":
            attrs.update(penwidth="3", peripheries="2")
        elif kind == "excluded":
            attrs.update(style="rounded,filled,dashed", fontcolor="#666666")
        else:
            attrs.update(penwidth="1.6")
        g.node(pid, **attrs)

    # 婚姻：配偶放進同一個隱形群組並排，以中間點相連，子女從中間點往下
    def blood_first(a, b):
        pa, pb = fam.p[a], fam.p[b]
        if a == did or (pa.father or pa.mother) and not (pb.father or pb.mother):
            return a, b
        if b == did or (pb.father or pb.mother) and not (pa.father or pa.mother):
            return b, a
        return (a, b) if pa.gender == "M" else (b, a)

    unions = {}
    for pid, p in fam.p.items():
        if p.spouse and p.spouse in fam.p:
            key = tuple(sorted((pid, p.spouse)))
            if key in unions:
                continue
            left, right = blood_first(*key)
            u = f"u_{key[0]}_{key[1]}"
            unions[key] = u
            with g.subgraph(name=f"cluster_{u}") as c:
                c.attr(style="invis", margin="4")
                c.node(u, shape="point", width="0.06", color="#555555", label="")
                with c.subgraph() as s:
                    s.attr(rank="same")
                    s.edge(left, u, penwidth="2", weight="20")
                    s.edge(u, right, penwidth="2", weight="20")

    for p in sorted(fam.p.values(), key=lambda x: x.birth or date.min):
        key = tuple(sorted((p.father, p.mother))) if p.father and p.mother else None
        if key in unions:
            g.edge(unions[key], p.id)
        else:
            for par in (p.father, p.mother):
                if par in fam.p:
                    g.edge(par, p.id)

    # 圖例
    with g.subgraph(name="cluster_legend") as lg:
        lg.attr(label="圖例", fontname=FONT, fontsize="11", style="rounded", color="#BBBBBB")
        for key, text in [("decedent", "被繼承人"), ("heir", "繼承人"),
                          ("retrans", "再轉繼承"), ("excluded", "不參與繼承")]:
            fill, line = COLORS[key]
            lg.node(f"lg_{key}", text, fillcolor=fill, color=line, fontsize="10",
                    style="rounded,filled,dashed" if key == "excluded" else "rounded,filled")
        lg.edge("lg_decedent", "lg_heir", style="invis")
        lg.edge("lg_heir", "lg_retrans", style="invis")
        lg.edge("lg_retrans", "lg_excluded", style="invis")

    return g


def share_table(fam: Family, result: Result) -> list[tuple[str, str, str, str]]:
    """（姓名, 稱謂, 依據, 最終應繼分）"""
    rows = []
    first = {s.person_id: s for s in result.shares}
    for pid, f in result.final_shares().items():
        p = fam.p[pid]
        if pid in first:
            basis = first[pid].basis
        else:
            src = next(h for h, sub in result.retransfers.items()
                       if any(s.person_id == pid for s in sub.shares))
            basis = f"再轉繼承（自{fam.p[src].name}，原應繼分 {frac(first[src].share)}）"
        rows.append((p.name, p.title, basis, frac(f)))
    return rows
