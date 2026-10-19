# Target Management Portal — Design

*Date: 19 Oct 2026. Status: approved by owner, 19 Oct 2026.*
*Marked **[my call]** = decided by Claude during design, open to change. Everything else was stated by the owner.*

## 1. Intent

Every month, Pepsi's sales departments receive a target in cases, per pack. Today the split from department → managers → salesmen is done in Excel (see the TT DMM October file: a department total by pack, and a route × salesman × pack upload sheet).

The portal moves that split into a web app so that:

- every manager adjusts his own team's targets himself, inside a small fixed allowance;
- totals can never drift: every level still adds up exactly to what it received, so the grand target per pack is always met and never exceeded;
- the result goes up the hierarchy in order and ends as one clean file for the commission system.

The system does **no forecasting or allocation logic**. The starting numbers come from an uploaded forecast. The system only sums, checks the rules, rounds, routes the work, and exports.

## 2. People

| Role | Who | What they do |
|---|---|---|
| Admin | The owner (Sales Support Engineer) | Sets up everything, uploads the monthly forecast, watches progress, moves work between levels, exports. Non-coder: everything must be doable from admin screens. |
| Manager | Department heads, area managers, supervisors, key-account managers (about 30 users max, never all at once) | Rebalances his own target between his direct team members, then submits. |

Salesmen, routes and key-account executives/accounts are **not users**; they are the lowest rows that receive targets.

## 3. Goals, non-goals, anti-goals

**Goals**
- Replace the monthly Excel split for all sales departments: TT, MT, Wholesale, HORECA, each with its own key-account team.
- Enforce the redistribution rules (section 6) at every level, live, while the manager types.
- Top-down flow through an admin-defined hierarchy, with email notification when it's someone's turn.
- Export in exactly the import format, whole cases only.
- Arabic and English UI (RTL for Arabic).
- Free hosting.

**Non-goals**
- No forecasting, driver-based allocation, history-based suggestions or seasonality.
- No integration with the CRM, iSELL or the commission system. Data moves by file upload/download only.
- No reject/approve buttons. Work only moves forward; the admin can move it anywhere.
- No physical/unit-case conversion. Everything is in the cases given in the file.
- No mobile app (the web screens should still be usable on a laptop; phone use is not a target).

**Anti-goals (would be a failure even if it "works")**
- Any total that ends up different from what was uploaded, including through rounding.
- A manager able to see or change teams outside his own branch.
- An export the commission system can't take as-is.
- Anything that needs the owner to touch code, servers or a database to run a normal month.

## 4. Constraints

- **Hosting:** Cloudflare free plan (owner's choice). Expected load: ~30 users, ~5 departments. The TT DMM file is 1,756 values (42 routes × 42 packs), so a whole month is in the order of 10,000–30,000 values (estimate).
- **Login:** username + password, created by the admin. No Microsoft/SSO.
- **Who maintains it:** Claude writes and changes all code; the owner only uses the screens.
- **Later move:** the owner may move it to a company server later, so avoid lock-in where it's cheap to (keep data exportable; keep business rules in plain, testable code).

## 5. Things in the system

- **Department** — TT, MT, Wholesale, HORECA (admin can add more). Each has its own hierarchy.
- **Key-account team** — **owner decided:** each department's KA team is a branch **under the department head**, like any other branch. The head can move cases between field sales and KA within the cap.
- **Hierarchy node** — a position in the tree (e.g. TT DMM head → area manager → supervisor). Admin builds and edits the tree at any time. **Owner decided (mid-month changes):** changing a node's manager works at any time. Moving routes or nodes changes the current month only where none of the affected nodes has started (everything still *waiting*); otherwise the move applies from the next month. Each month therefore keeps its own copy of the tree. Depth can differ per department and branch. Each non-leaf node has one manager user. **[my call]** One user may manage more than one node.
- **Leaf (target line owner)** — the lowest row. **[my call]** A leaf is identified by *Delivery System + Route Code*: routes are stable, salesmen rotate. Salesman ID is stored per month from the upload file and written back on export. For key accounts, the account or executive code is carried in the same columns. Each leaf sits under one node, so the admin maps routes once instead of every month.
- **Pack** — the "Sales Target Category" codes (42 in the TT file, e.g. CSD_PET1000). Admin maintains the list: code, group, active flag, display order.
- **Pack group** — exactly three: **CSD, Water, LRB-Others**. Each pack belongs to one group. No sub-groups (the owner removed SSNR/CANS/MSPET levels).
- **Month** — one cycle per period (YYYY-MM). Holds the uploaded forecast, every node's work and status, and the final result.
- **Settings** — cap % (default 5%, admin-editable).

## 6. The redistribution rules (the core)

For a manager's node, for each pack separately, let:
- **T** = the node's total for that pack. **Locked**; the manager can't change it.
- **s₁…sₙ** = each direct team member's starting number (sum = T).
- **v₁…vₙ** = the numbers the manager enters (whole numbers ≥ 0).
- **C** = floor(cap% × T). Example: 5% of 950 = 47.5 → C = 47.

A pack passes when all three hold:
1. **Fixed total:** v₁ + … + vₙ = T.
2. **Per-person cap:** for every member, |vᵢ − sᵢ| ≤ C.
3. **Total-moved cap:** total cases moved (sum of all increases, which equals the sum of all decreases) ≤ C.

Owner's examples:
- T = 1,000, reps 700/300 → may go to 650/350 or 750/250 (C = 50).
- Four reps, moving 50 off each of two reps onto the other two = 100 moved → **blocked** (rule 3), even though no single rep changed by more than 50.

Submit is allowed only when every pack with T > 0 passes. Packs with T = 0 can't change (C = 0).

The same rules apply **at every level**: a department head rebalancing between area managers, an area manager between supervisors, a supervisor between salesmen.

Rule 2 is implied by rule 3, since one person can never move more than the total moved. It is kept because the owner stated it, and so it still applies if the rules change later. The screen shows a single "Moved too much" status for both.

**Baseline [my call]:** sᵢ are the numbers the node had when its turn opened. Reopening a node does **not** reset them to the last submission, so the cap can't be stepped around by repeated reopens. Only a parent's resubmission that changes this node's total gives it new starting numbers (section 7).

**Note [my call]:** with a small T the cap rounds down to 0 (T < 20 at 5%), so that pack simply can't be moved. That is the correct reading of "5% of total"; the screen shows the cap so it is never a surprise.

## 7. Starting numbers, scaling and rounding

**Loading the month.** The admin uploads the forecast file per department (Sheet 2 format). Each leaf's decimal cases are rounded to whole cases **without changing totals**: **[my call]** for each pack, the department total is the rounded sum of the decimals, and leaf values are rounded with the largest-remainder method so they add up exactly to that total. Every node's starting total is the sum of its leaves.

**When a manager changes a child's total.** Top-down means a supervisor's total can change after his area manager submits, while the leaves under him still hold the old forecast. On submit, the system silently fixes this before anyone below sees it (owner approved):
- For each child whose total changed for a pack, every leaf under that child is scaled by the same percentage (new total ÷ old total), then rounded with the largest-remainder method so the leaves add up exactly to the new total.
- Example: Supervisor A goes 1,000 → 950, reps 700/300 → 665/285; Supervisor B goes 1,000 → 1,050, reps 600/400 → 630/420.
- A then starts his own rebalancing from 665/285, with the cap based on his new total (950 → C = 47).
- **[my call]** If a child had 0 for a pack and received cases, the cases are split as evenly as possible across that child's leaves (largest remainder), and the lower manager adjusts within his cap.

**Rounding everywhere [my call]:** largest-remainder, with ties broken by the larger starting value and then by the code. Result: no case is ever created or lost.

## 8. The monthly flow

1. **Admin opens the month:** uploads one forecast file per department, fixes any flagged problems (section 10), and sets the deadline(s).
2. **Top level goes first:** each department head gets an email, rebalances between his direct reports, and submits.
3. **Each level in turn:** when a node's parent submits, that node's manager gets an email and his screen unlocks with his locked total. Siblings work in parallel. A node can save drafts before submitting.
4. **After submit:** the node becomes read-only for that manager. He can still view his whole branch.
5. **Admin control:** the admin sees every node's status (waiting / in progress / submitted) and can move work **between levels** in either direction:
   - **reopen** a submitted node so its manager can edit again, or
   - **push forward** a node that is late (submitting its current numbers as they are, which may be the unchanged start).
   - **[my call]** Reopening a node sends its descendants back to *waiting*. When the node is resubmitted, children whose totals didn't change keep their earlier work. Children whose totals changed lose their earlier work: they get rescaled starting numbers (section 7) and redo their part.
   - **[my call] Re-uploading the forecast** for a department after its month has started is allowed. It resets that department's work to the new file, after a clear warning to the admin.
6. **Close:** when every node in a department has submitted, the department is complete. The admin exports (section 11). **[my call]** The admin can still reopen after export; the export is re-run afterwards.

Departments run independently. Cases never move between departments.

## 9. Screens

### Manager: distribution screen
Approved mockup: `distribution-screen-v4.html` (in this project). Contents:
- **Header:** month, department, node, step; **Arabic/English toggle** (Arabic = full RTL; pack codes stay as codes; Western digits).
- **Summary cards:** my locked total (all packs), team size, cap %, packs passing (x of y), deadline.
- **The three rules** in one line of plain text.
- **Group tabs:** All packs / CSD / Water / LRB-Others.
- **Search bar:** matches pack names. Typing a route code or salesman ID (or team member name) shows only that member's column.
- **Toggles:** hide packs with 0 target; expand all; collapse all; clear filters.
- **Table:**
  - Rows are packs, under collapsible group rows (CSD / Water / LRB-Others). Each group row shows the group total, each member's subtotal with change from start, and "x / y OK".
  - Columns:
    - Pack.
    - My target (locked).
    - One column per direct team member: an input, plus "start N" or "+/−d from N".
    - Moved / cap.
    - Status: OK / Over by N / Short by N / Moved too much.
    - Reset (per pack).
- **Filter row under every column:**
  - Text filter for Pack.
  - Number filters (`>500`, `<100`, `=0`, `100-500`) for target, each member column and moved.
  - Dropdown (All / OK / Problems) for Status.
- **Buttons:** Save draft; **Submit to next level** (disabled until all packs pass).
- **Display:** a member is shown by route code + salesman ID at the lowest level, or by node name + manager name at higher levels **[my call]**.

### Manager: home
**[my call]** A list of the months and nodes assigned to him, with status and deadline. He can open his team screen (editable on his turn, read-only otherwise) and view his whole branch read-only.

### Admin screens [my call on layout; content as agreed]
- **Users:** create/edit/disable; name, username, email, password reset, language preference.
- **Departments.**
- **Hierarchy:**
  - Tree editor per department: add/move/remove nodes and assign a manager to each.
  - Place leaves under nodes.
  - Bulk upload of the leaf → node mapping from Excel, since there are hundreds of routes.
- **Packs:** code, group (CSD/Water/LRB-Others), active, order. Add/update/remove.
- **Settings:** cap %.
- **Month control panel:**
  - Open a month and upload the forecast per department.
  - Upload check report (section 10).
  - Deadline(s).
  - Status board per node, with reopen / push forward.
  - Export.
- **History:** log of uploads, saves, submits, reopens, push-forwards and settings changes (who, when, what).

## 10. Upload checks

The forecast file has these columns: Period (YYYY-MM), Delivery System, Route Code, Salesman ID, Sales Target Category, Cases. On upload the system lists problems **before** accepting the file.

**[my call]** A month can take several files (per department or per region, e.g. "TT DMM"). Each row is matched to its leaf, and a leaf may appear in only one file per month.

**[my call]** The system always stores a **full grid**: every leaf × every active pack, with missing pairs = 0. That way, cases moved onto a pair that started at 0 are never lost.

**Errors (block the upload):**
- Pack code not in the pack list.
- Period doesn't match the month being opened.
- Non-numeric or negative cases.
- Duplicate rows for the same leaf + pack.
- Leaf not placed under any node in the hierarchy.

**Warnings (shown; the admin may accept them):**
- Blank Salesman ID (4 TT routes had this).
- One route split across two Salesman IDs (4 TT routes had one stray row under another ID).
- Leaf with 0 in every pack.
- Packs in the pack list but missing from the file.

**[my call]** If the admin also uploads the department total by pack (Sheet 1 format), the system checks that the forecast adds up to it per pack and shows any difference.

## 11. Export

- Same columns as the imported file. Rows are the full grid (every leaf × every active pack, zeros included), like the TT sample file.
- Cases are whole numbers.
- One `.xlsx` per department, plus an "all departments" file **[my call]**.
- The file is uploaded to the commission system by hand.

## 12. Notifications

- Email from the system:
  - when a node's turn opens;
  - a reminder the day before the deadline **[my call]**;
  - to the admin when a department completes **[my call]**.
- Each email links straight to the right screen.
- **Owner decided: stay at $0.** No custom domain. Email goes through a free sending service with a verified sender address. Because of that, emails may land in spam or be blocked by company mail. So:
  - the in-app home page ("My tasks") is the reliable signal;
  - the admin's status board has a **copy link** per node, so a reminder can be sent by hand (e.g. WhatsApp) when needed **[my call]**.

## 13. How it's built (my call unless noted)

- **Hosting:** Cloudflare free plan (**owner decided**). A single web app on Cloudflare Workers with static assets, plus Cloudflare D1 (SQLite) for data.
- **Code:** TypeScript end to end.
  - The redistribution rules, scaling and rounding live in one small, pure, fully unit-tested module, because they are the heart of the system and must never be wrong.
- **Auth:** username/password with salted hashing and session cookies; admin-only user creation and password reset.
- **Excel [my call]:** read and write `.xlsx` **in the browser** (e.g. the SheetJS library). Only the checked rows are sent to the server, in batches, which keeps the work inside the free-plan per-request CPU limit.
- **Languages:** all UI text in two translation files (en, ar). Layout uses logical CSS so RTL works without separate screens.
- **Backups:**
  - The admin can download a full data export at any time.
  - D1 point-in-time restore is the safety net.
  - This also makes the later move to a company server straightforward.

**To verify before building:**
- Cloudflare free-plan limits for Workers and D1 against the load in section 4. The reviewer noted roughly 100k D1 row writes per day and about 10 ms of CPU per request. A month of ~30k values fits if values are stored packed per leaf (one row per leaf holding all its packs) rather than one row per value.
- Which free email service allows sending without a custom domain, and whether test emails reach a company inbox.

## 14. Left to the builder

- Database schema, API shape, framework choices within the stack above.
- Visual styling beyond the approved mockup.
- Exact email wording (in both languages).
- Performance tactics for the largest screens (e.g. a department head's view across many packs).
