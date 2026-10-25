"""執行：python -m pytest tests  或  python tests/test_engine.py"""
import sys
from datetime import date
from fractions import Fraction as F
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inheritance import Family, InheritanceEngine, Person  # noqa: E402

D = date(2025, 1, 1)


def run(persons, did="X"):
    return InheritanceEngine(Family(persons)).distribute(did).final_shares()


def dec(**kw):
    return Person(id="X", name="被繼承人", death=D, **kw)


def test_sample_case():
    root = Path(__file__).resolve().parents[1]
    fam, did = Family.from_json(root / "data/sample_family.json")
    s = InheritanceEngine(fam).distribute(did).final_shares()
    assert s == {"P10": F(1, 4), "P02": F(1, 4), "P20": F(1, 8), "P21": F(1, 8),
                 "P31": F(1, 8), "P23": F(1, 8)}


def test_spouse_with_parents_half():
    s = run([dec(father="F", mother="M", spouse="S"), Person("S", "配偶"),
             Person("F", "父"), Person("M", "母")])
    assert s == {"S": F(1, 2), "F": F(1, 4), "M": F(1, 4)}


def test_spouse_with_grandparents_two_thirds():
    s = run([dec(father="F", spouse="S"), Person("S", "配偶"),
             Person("F", "父", death=date(2000, 1, 1), father="GF"), Person("GF", "祖父")])
    assert s == {"S": F(2, 3), "GF": F(1, 3)}


def test_siblings_no_representation():
    s = run([dec(father="F"), Person("F", "父", death=date(2000, 1, 1)),
             Person("B1", "兄", father="F"),
             Person("B2", "弟", father="F", death=date(2020, 1, 1)),
             Person("N", "姪", father="B2")])
    assert s == {"B1": F(1)}   # 兄弟姊妹不適用代位繼承


def test_all_children_renounce_grandchildren_inherit():
    s = run([dec(), Person("C1", "子", father="X", renounced=["X"]),
             Person("C2", "女", mother="X", renounced=["X"]),
             Person("G1", "孫", father="C1"), Person("G2", "孫", father="C1"),
             Person("G3", "外孫", mother="C2")])
    assert s == {"G1": F(1, 3), "G2": F(1, 3), "G3": F(1, 3)}   # 第1176條第5項，按人數


def test_same_day_death_not_heir():
    s = run([dec(spouse="S"), Person("S", "配偶", death=D), Person("C", "子", father="X")])
    assert s == {"C": F(1)}    # 第11條 同時死亡推定


def test_lost_right_triggers_representation():
    s = run([dec(), Person("C1", "子", father="X", lost_right=["X"]),
             Person("G", "孫", father="C1"), Person("C2", "子", father="X")])
    assert s == {"G": F(1, 2), "C2": F(1, 2)}


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("通過", name)
