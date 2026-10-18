"""The scanner's base models kept in the firm's own Firebase Storage
(docs/scan-plan.md → Scanner lab), so a deploy never depends on the authors'
download links: models/scan/base-v1/<name> in the project's default bucket.
Run in CI with GOOGLE_APPLICATION_CREDENTIALS (the deploy's service account).

  model_store.py ping            -> the bucket's name, or exit 1
  model_store.py get NAME DEST   -> exit 1 when the model is not stored yet
  model_store.py put SRC NAME
"""
import sys

from google.cloud import storage

PREFIX = "models/scan/base-v1/"
# A Firebase project's default bucket has one of these two names.
BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]


def bucket():
    client = storage.Client(project="schedule-odinson")
    for name in BUCKETS:
        b = client.bucket(name)
        try:
            list(b.list_blobs(prefix=PREFIX, max_results=1))
            return b
        except Exception as e:  # not this project's bucket, or no access
            print(f"{name}: {type(e).__name__}", file=sys.stderr)
    sys.exit("no Storage bucket reachable")


def main(argv):
    cmd = argv[1]
    if cmd == "ping":
        print(bucket().name)
    elif cmd == "get":
        blob = bucket().blob(PREFIX + argv[2])
        if not blob.exists():
            sys.exit(1)
        blob.download_to_filename(argv[3])
        print(f"from Storage: {argv[2]}")
    elif cmd == "put":
        b = bucket()
        b.blob(PREFIX + argv[3]).upload_from_filename(argv[2])
        print(f"stored in gs://{b.name}/{PREFIX}{argv[3]}")
    else:
        sys.exit("unknown command " + cmd)


if __name__ == "__main__":
    main(sys.argv)
