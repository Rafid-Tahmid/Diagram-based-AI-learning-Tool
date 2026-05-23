# verify

Takes a Playwright screenshot of the running app and checks the current phase criteria.

Steps:
1. Read `CLAUDE.md` to get the current phase's "Done when" criteria
2. Run the Playwright screenshot script — wait for `.react-flow__node` before capturing
3. Check each "Done when" criterion against what's visible in the screenshot
4. Report PASS or list what's missing
5. If PASS, remind to update `CLAUDE.md` phase status to "complete"

Note: dev server must be running on http://localhost:3000 before using this command.
