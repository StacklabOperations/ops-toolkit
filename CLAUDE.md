# Claude Code Instructions — Stacklab Ops Toolkit

Read DEV_ENVIRONMENT.md before doing anything in this repo.

---

## DEVSUM

When the user says DEVSUM, generate a structured handoff report 
covering this build session. Format it exactly like this:

"DEVSUM — Build Session Report
[date]

TOOL BUILT: [name and file path]

WHAT IT DOES:
[2-3 sentence plain English description]

GRAPHQL OPERATIONS USED:
- [mutation/query name]: [what it does, key input fields]
- [repeat for each]

ALIGNI DISCOVERIES (corrections or new knowledge):
- [anything that differed from what the brief expected]
- [field names that weren't obvious]
- [quirks, errors, rate limit or sequencing gotchas]

DECISIONS MADE DURING BUILD:
- [anything not in the brief that had to be figured out]

OUTSTANDING ISSUES / WATCH POINTS:
- [anything fragile or needing future attention]

CONTEXT UPDATES NEEDED:
- DEV_ENVIRONMENT.md: [specific line or section to add/correct]
- Project Log: [one paragraph summary for the log]
- Spec file saved at: [path]"
