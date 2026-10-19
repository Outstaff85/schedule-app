"""Once, on the owner's PC (docs/hf-plan.md → H0): the training records and counters
collected before the names said what the models do get today's names —
scanTraining/<id>: cornersModel / cornersFixed → edgesModel / edgesFixed,
kindModel / kindFixed / kindBy → doctypeModel / doctypeFixed / doctypeBy;
scanTrainingStats/current: newSince → edgesSince, kindsSince → doctypesSince (added to what
the new names counted meanwhile), lastKindsTrainedAt / lastKindsReport →
lastDoctypesTrainedAt / lastDoctypesReport. Until it runs, the server and the training
scripts read the old names too. Safe to run again: a renamed record has nothing left to move.

  python rename_fields.py            # what would change
  python rename_fields.py --apply
"""
import argparse

from google.cloud import firestore

from common import OLD_NAMES, OLD_STATS, db


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    d, n = db(), 0
    batch = d.batch()
    for snap in d.collection("scanTraining").stream():
        r = snap.to_dict()
        upd = {}
        for old, new in OLD_NAMES.items():
            if old in r:
                if new not in r:
                    upd[new] = r[old]
                upd[old] = firestore.DELETE_FIELD
        if upd:
            n += 1
            batch.update(snap.reference, upd)
            if n % 400 == 0 and a.apply:
                batch.commit()
                batch = d.batch()
    ref = d.collection("scanTrainingStats").document("current")
    st = (ref.get().to_dict() or {})
    supd = {}
    for old, new in OLD_STATS.items():
        if old not in st:
            continue
        if old == "newSince":
            supd[new] = int(st.get(new) or 0) + int(st[old] or 0)
        elif old == "kindsSince":
            cur, prev = st.get(new) or {}, st[old] or {}
            supd[new] = {k: int(cur.get(k) or 0) + int(prev.get(k) or 0) for k in set(cur) | set(prev)}
        elif new not in st:
            supd[new] = st[old]
        supd[old] = firestore.DELETE_FIELD
    print(f"{n} training records to rename; counters: {', '.join(k for k in OLD_STATS if k in st) or 'nothing'}")
    if not a.apply:
        print("Nothing changed — run with --apply")
        return
    if supd:
        batch.update(ref, supd)
    batch.commit()
    print("Renamed.")


if __name__ == "__main__":
    main()
