#!/usr/bin/env bash
# Start-of-session sync. Run this BEFORE doing any work.
#
# The repository is the source of truth, and several agents work in it at once.
# This shows you what moved since you last looked, what is in flight, and which
# decisions are newest — because the newest decision wins over older docs that
# were not updated to match.
#
#   ./scripts/sync.sh            since the last 10 commits
#   ./scripts/sync.sh HEAD~30    since a specific point
set -uo pipefail

SINCE="${1:-HEAD~10}"
warn=0
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

echo "STRKWORLD sync"

# ---------------------------------------------------------------------------
hdr "1. Remote state"
git fetch -q origin 2>/dev/null || echo "  (offline — remote state unknown)"
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "$LOCAL")
if [ "$LOCAL" != "$REMOTE" ]; then
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  [ "$behind" != "0" ] && { echo "  ⚠ $behind commit(s) BEHIND origin/main — pull before working"; warn=1; }
  [ "$ahead" != "0" ] && { echo "  ⚠ $ahead commit(s) ahead and unpushed — push so others can see them"; warn=1; }
else
  echo "  in sync with origin/main"
fi

# ---------------------------------------------------------------------------
hdr "2. Uncommitted work in the tree"
dirty=$(git status --porcelain 2>/dev/null)
if [ -n "$dirty" ]; then
  echo "$dirty" | sed 's/^/  /'
  echo
  echo "  ⚠ This is NOT in the repo, so it is not the source of truth yet."
  echo "    If it is another agent's in-flight work, do not overwrite it."
  echo "    If it is yours, commit it before you stop."
  warn=1
else
  echo "  clean"
fi

# ---------------------------------------------------------------------------
hdr "3. Open pull requests"
if command -v gh >/dev/null 2>&1; then
  prs=$(gh pr list --state open --limit 10 \
        --json number,title,author,updatedAt \
        --template '{{range .}}  #{{.number}} {{.title}} — @{{.author.login}}{{"\n"}}{{end}}' 2>/dev/null)
  [ -n "$prs" ] && echo "$prs" || echo "  none open"
else
  echo "  (gh not available)"
fi

# ---------------------------------------------------------------------------
hdr "4. What changed since $SINCE"
git log --oneline "$SINCE"..HEAD 2>/dev/null | sed 's/^/  /' || echo "  (no range)"

# ---------------------------------------------------------------------------
hdr "5. Newest decisions — these win over older docs"
grep -E "^## D-[0-9]+ —" docs/DECISIONS.md 2>/dev/null | tail -6 | sed 's/^## /  /'
echo
superseded=$(grep -E "^## D-[0-9]+ —" -A2 docs/DECISIONS.md 2>/dev/null \
             | grep -iE "supersede" | head -5)
[ -n "$superseded" ] && { echo "  superseding entries:"; echo "$superseded" | sed 's/^/    /'; }

# ---------------------------------------------------------------------------
hdr "6. Newest findings — verified facts that override assumptions"
grep -E "^### [0-9]{4}-[0-9]{2}-[0-9]{2} —" AGENTS.md 2>/dev/null | head -5 | sed 's/^### /  /'

# ---------------------------------------------------------------------------
hdr "7. Health"
./scripts/check-invariants.sh >/dev/null 2>&1 \
  && echo "  invariants pass" \
  || { echo "  ⚠ invariants FAILING — run ./scripts/check-invariants.sh"; warn=1; }

echo
if [ "$warn" -eq 0 ]; then
  echo "Synced. You are working from current truth."
else
  echo "Synced WITH WARNINGS. Resolve the ⚠ items before writing code."
fi
echo "Before you stop: commit, push, and record what you learned (AGENTS.md / DECISIONS.md)."
exit 0
