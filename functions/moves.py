"""A status moved only while it still holds, for every signing (signing.py, transfer.py, client_signing.py)."""


def move(db, ref, check, fields):
    """ref updated with fields only while check(its data) still holds, read and written in one transaction (two calls at
    once — a double tap, two tabs, a send while the client signs — never both pass) → the data as it was, or None.
    A store without transactions (the tests' stand-in) does the same check and write in a row."""
    def step(get, put):
        snap = get()
        cur = snap.to_dict() if snap.exists else None
        if not cur or not check(cur):
            return None
        put(fields)
        return cur
    if not hasattr(db, "transaction"):
        return step(ref.get, ref.update)
    from firebase_admin import firestore

    @firestore.transactional
    def go(tx):
        return step(lambda: ref.get(transaction=tx), lambda f: tx.update(ref, f))
    return go(db.transaction())
