"""
民法繼承規則引擎（現行法）

實作條文：
- 第 1138 條：法定繼承人順序（配偶 + 直系血親卑親屬／父母／兄弟姊妹／祖父母）
- 第 1139 條：第一順序以親等近者為先
- 第 1140 條：代位繼承（繼承開始前死亡或喪失繼承權）
- 第 1144 條：配偶應繼分
- 第 1176 條：拋棄繼承之效果（應繼分歸屬同順序其他繼承人；
              第一順序親等近者均拋棄時，由次親等直系血親卑親屬繼承）
- 再轉繼承：繼承人於繼承開始後、遺產分割前死亡，其應繼分由其繼承人再行繼承
- 第 11 條：同時死亡推定（死亡日期相同者，互不繼承）

限制（雛形階段）：
- 僅適用現行民法，尚未依死亡日期切換舊法（例如日據時期舊慣、74 年修法前規定）
- 未處理離婚、收養終止、胎兒、遺囑及特留分
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from fractions import Fraction
from pathlib import Path


# ---------- 資料模型 ----------

@dataclass
class Person:
    id: str
    name: str
    title: str = ""                 # 稱謂，例如：長男、配偶、母
    gender: str = ""
    birth: date | None = None
    death: date | None = None
    father: str | None = None
    mother: str | None = None
    spouse: str | None = None       # 現存婚姻之配偶
    renounced: list[str] = field(default_factory=list)   # 對哪些被繼承人拋棄繼承
    lost_right: list[str] = field(default_factory=list)  # 對哪些被繼承人喪失繼承權（第 1145 條）


@dataclass
class Share:
    person_id: str
    share: Fraction
    basis: str


@dataclass
class Result:
    decedent_id: str
    opened_on: date
    order: str
    shares: list[Share]
    notes: dict[str, str]                       # 未參與繼承或狀態說明
    retransfers: dict[str, "Result"] = field(default_factory=dict)

    def final_shares(self) -> dict[str, Fraction]:
        """展開再轉繼承後，每個人最終取得的比例。"""
        out: dict[str, Fraction] = {}
        for s in self.shares:
            if s.person_id in self.retransfers:
                for pid, f in self.retransfers[s.person_id].final_shares().items():
                    out[pid] = out.get(pid, Fraction(0)) + f * s.share
            else:
                out[s.person_id] = out.get(s.person_id, Fraction(0)) + s.share
        return out


def _d(value):
    return date.fromisoformat(value) if value else None


# ---------- 家族資料 ----------

class Family:
    def __init__(self, persons: list[Person]):
        self.p = {}
        for x in persons:
            if x.id in self.p:
                raise ValueError(f"人員 ID 重複：{x.id}，請先修正")
            self.p[x.id] = x
        for x in persons:  # 配偶關係雙向補齊
            if x.spouse and x.spouse in self.p and not self.p[x.spouse].spouse:
                self.p[x.spouse].spouse = x.id

    @classmethod
    def from_json(cls, path: str | Path) -> tuple["Family", str]:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        persons = []
        for r in raw["persons"]:
            persons.append(Person(
                id=r["id"], name=r["name"], title=r.get("title", ""),
                gender=r.get("gender", ""),
                birth=_d(r.get("birth")), death=_d(r.get("death")),
                father=r.get("father"), mother=r.get("mother"),
                spouse=r.get("spouse"),
                renounced=r.get("renounced", []), lost_right=r.get("lost_right", []),
            ))
        return cls(persons), raw["decedent"]

    # 親屬查詢
    def children(self, pid):
        kids = [x for x in self.p.values() if pid in (x.father, x.mother)]
        return sorted(kids, key=lambda x: x.birth or date.min)

    def parents(self, pid):
        me = self.p[pid]
        return [self.p[i] for i in (me.father, me.mother) if i in self.p]

    def siblings(self, pid):
        mine = {i for i in (self.p[pid].father, self.p[pid].mother) if i}
        return [x for x in self.p.values()
                if x.id != pid and mine & {x.father, x.mother} - {None}]

    def grandparents(self, pid):
        out = {}                                   # 以 ID 去重：同一位祖父母可能經父、母兩個分支被找到
        for par in self.parents(pid):
            for g in self.parents(par.id):
                out[g.id] = g
        return list(out.values())


# ---------- 規則引擎 ----------

class InheritanceEngine:
    def __init__(self, family: Family):
        self.f = family

    @staticmethod
    def _alive_at(p: Person, d: date) -> bool:
        born = p.birth is None or p.birth <= d
        # 死亡日與繼承開始日相同 → 推定同時死亡，不具繼承資格
        return born and (p.death is None or p.death > d)

    def _eligible(self, p, did, d):
        return self._alive_at(p, d) and did not in p.renounced and did not in p.lost_right

    def distribute(self, did: str, opened_on: date | None = None, _depth: int = 0) -> Result:
        if _depth > 10:
            raise RecursionError("再轉繼承層數過深，請檢查資料")
        dec = self.f.p[did]
        d = opened_on or dec.death
        if d is None:
            raise ValueError(f"{dec.name} 沒有死亡日期，無法開始繼承")
        notes: dict[str, str] = {}

        # ---- 第一順序：直系血親卑親屬（含代位） ----
        def branch(pid, represented=None):
            p = self.f.p[pid]
            if not (p.birth is None or p.birth <= d):
                return []
            if did in p.renounced:
                notes[pid] = "拋棄繼承"
                return []                       # 拋棄不發生代位
            if self._eligible(p, did, d):
                basis = (f"第1140條 代位繼承（代位{represented}）" if represented
                         else "第1138條 第一順序 直系血親卑親屬")
                return [(pid, Fraction(1), basis)]
            notes[pid] = "喪失繼承權" if did in p.lost_right else "繼承開始前死亡"
            subs = [b for b in (branch(k.id, p.name) for k in self.f.children(pid)) if b]
            if not subs:
                return []
            return [(h, w / len(subs), bs) for sub in subs for (h, w, bs) in sub]

        heirs_branches: list[list] = []
        level = self.f.children(did)
        first_degree = True
        while level and not heirs_branches:
            heirs_branches = [b for b in (branch(c.id) for c in level) if b]
            if heirs_branches and not first_degree:   # 第 1176 條第 5 項
                heirs_branches = [[(h, w, "第1176條第5項 次親等直系血親卑親屬繼承")
                                   for (h, w, _) in b] for b in heirs_branches]
            if not heirs_branches:
                level = [g for c in level for g in self.f.children(c.id)]
                first_degree = False

        # ---- 配偶 ----
        sp = self.f.p.get(dec.spouse) if dec.spouse else None
        spouse_ok = bool(sp and self._eligible(sp, did, d))
        if sp and not spouse_ok:
            notes[sp.id] = ("拋棄繼承" if did in sp.renounced
                            else "繼承開始前死亡" if not self._alive_at(sp, d) else "喪失繼承權")

        shares: list[Share] = []
        if heirs_branches:
            order = "第一順序"
            units = len(heirs_branches) + (1 if spouse_ok else 0)
            for b in heirs_branches:
                for (h, w, bs) in b:
                    shares.append(Share(h, w / units, bs))
            if spouse_ok:
                shares.append(Share(sp.id, Fraction(1, units), "第1144條第1款 配偶與第一順序平均"))
        else:
            order, others, spouse_part = None, [], Fraction(1)
            candidates = [
                ("第二順序", self.f.parents(did), Fraction(1, 2), "第1138條 第二順序 父母"),
                ("第三順序", self.f.siblings(did), Fraction(1, 2), "第1138條 第三順序 兄弟姊妹"),
                ("第四順序", self.f.grandparents(did), Fraction(2, 3), "第1138條 第四順序 祖父母"),
            ]
            for name, group, sp_share, basis in candidates:
                ok = []
                for x in group:
                    if self._eligible(x, did, d):
                        ok.append(x)
                    else:
                        notes.setdefault(x.id, "拋棄繼承" if did in x.renounced
                                         else "繼承開始前死亡" if not self._alive_at(x, d)
                                         else "喪失繼承權")
                if ok:
                    order, others, spouse_part = name, [(x, basis) for x in ok], sp_share
                    break
            if others:
                rest = (1 - spouse_part) if spouse_ok else Fraction(1)
                for x, basis in others:
                    shares.append(Share(x.id, rest / len(others), basis))
                if spouse_ok:
                    art = {"第二順序": "第2款", "第三順序": "第2款", "第四順序": "第3款"}[order]
                    shares.append(Share(sp.id, spouse_part, f"第1144條{art} 配偶"))
            elif spouse_ok:
                order = "僅配偶"
                shares.append(Share(sp.id, Fraction(1), "第1144條第4款 無其他順序繼承人"))
            else:
                order = "無人承受（第1177條）"

        # 同順序內未參與者標註（例如第一順序存在時，父母不繼承）
        if order == "第一順序":
            for x in self.f.parents(did) + self.f.siblings(did) + self.f.grandparents(did):
                notes.setdefault(x.id, "有第一順序繼承人，不繼承")

        result = Result(did, d, order, shares, notes)

        # ---- 再轉繼承 ----
        for s in shares:
            heir = self.f.p[s.person_id]
            if heir.death and heir.death > d:
                result.retransfers[heir.id] = self.distribute(heir.id, heir.death, _depth + 1)

        total = sum((s.share for s in shares), Fraction(0))
        assert not shares or total == 1, f"應繼分合計 {total} ≠ 1"
        return result
