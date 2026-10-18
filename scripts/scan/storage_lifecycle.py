"""The scanner's training copies are deleted 12 months after they are written
(docs/scan-plan.md → S6): a lifecycle rule on the project's bucket deletes every
object under training/ older than 365 days. Idempotent; run by deploy-rules.yml
with the deploy's service account (it needs Storage Admin on the bucket)."""
import sys

from google.cloud import storage

BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]
RULE = {"action": {"type": "Delete"}, "condition": {"age": 365, "matchesPrefix": ["training/"]}}


def main():
    client = storage.Client(project="schedule-odinson")
    for name in BUCKETS:
        b = client.bucket(name)
        try:
            b.reload()
        except Exception as e:  # not this project's bucket name, or no access
            print(f"{name}: {type(e).__name__}", file=sys.stderr)
            continue
        rules = list(b.lifecycle_rules)
        if any(r.get("action", {}).get("type") == "Delete" and r.get("condition", {}).get("matchesPrefix") == ["training/"] for r in rules):
            print(f"{name}: the training/ rule is already set")
            return
        b.lifecycle_rules = rules + [RULE]
        b.patch()
        print(f"{name}: training/ objects are deleted after 365 days")
        return
    sys.exit("no Storage bucket reachable")


if __name__ == "__main__":
    main()
