# Platform decisions (Task 0)

Verified 2026-10-19 against official docs (access date for every source below).

## Verdict at the top

**No limit blocks the plan, but two items need action before or in Task 1:**

1. **PBKDF2 CPU risk (UNVERIFIED, may FAIL).** Workers Free allows 10 ms CPU per request. PBKDF2-SHA256 at the maximum allowed 100,000 iterations took about 72 ms of CPU on a generic x86 VM (no SHA extensions). Cloudflare's hardware is likely faster but nobody documents it. A login could exceed the 10 ms budget and return Error 1102. This must be benchmarked on a deployed Free-plan Worker in the auth task, before building more on it. See "PBKDF2 iterations".
2. **Write batches must not be one statement per row.** D1 Free allows 50 queries per Worker invocation, and per-query limits apply to every statement inside `db.batch()`. 200 single-row statements would break the cap. Use one statement per request: `INSERT ... SELECT ... FROM json_each(?)` with the whole batch as one JSON parameter (1 statement, 1 bound param). Fallback: multi-row `INSERT ... VALUES` with at most 100 bound params per statement.

Email: Brevo works with a single verified Gmail sender over HTTPS and no domain, but Brevo rewrites the From address and deliverability is poor-to-fair. The in-app "My tasks" page stays the reliable signal (as design section 12 already says).

## Limits table

| Limit | Value (Free plan) | Our expected use | Pass/fail | Source |
|---|---|---|---|---|
| Workers requests per day | 100,000 (resets 00:00 UTC) | ~30 users, a few hundred to a few thousand requests per day | PASS | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers CPU time per HTTP request | 10 ms | Normal requests are small JSON reads and writes. Login with PBKDF2 is the exception. | PASS, except login (see PBKDF2) | Workers limits |
| Workers subrequests per request | 50 | 0 external, plus D1 queries (counted separately below). One Brevo `fetch` per email. | PASS | Workers limits |
| Workers memory | 128 MB per isolate | A 200-row batch is about 100 KB | PASS | Workers limits |
| Worker size | 64 MiB uncompressed | Small app. Excel library runs in the browser, served as a static asset. | PASS | Workers limits |
| Cron Triggers per account | 5 | 1 (daily reminder job) | PASS | Workers limits |
| Cron CPU per run | 10 ms (Free); 15 min wall time | Daily job: one query plus a handful of `fetch` calls to Brevo (network wait does not count as CPU) | PASS, keep the job light | Workers limits |
| Cron timezone | UTC only | Reminder "day before the deadline": compute in UTC, schedule early enough for Saudi time (UTC+3) | PASS (note) | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| D1 rows written per day | 100,000 (reset 00:00 UTC; queries fail once exceeded) | At most 3,000 packed rows per full upload. Even 10 full re-uploads in a day is about 30,000 plus index writes. | PASS | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows read per day | 5,000,000 | Full scan of 3,000 rows costs 3,000 reads. 1,000 scans per day is still 3M. Use indexed queries. | PASS | D1 pricing |
| D1 database size | 500 MB per database (5 GB per account) | 3,000 rows x about 1 KB per month is about 3 MB per month | PASS | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 max row/string/BLOB size | 2,000,000 bytes | One packed row (JSON grid of about 42 packs) is about 0.3 to 1 KB | PASS | D1 limits |
| D1 max bound parameters per query | **100** | See line below | PASS with the JSON approach | D1 limits |
| D1 max SQL statement length | 100,000 bytes (SQL text, not bound values) | Short SQL | PASS | D1 limits |
| D1 queries per Worker invocation | 50 (Free) | One statement per 200-row batch with `json_each`. Fallback multi-row VALUES needs 10 to 20 statements. Per-row statements (200) would FAIL. | PASS only with `json_each` or multi-row inserts | D1 limits |
| Monthly volume | n/a | 30k leaf-pack values stored as at most 3,000 packed rows; batches of at most 200 rows means at most 15 requests per full upload | PASS | design.md section 4 |
| Brevo free sends per day | 300 | About 30 to 60 on a busy day (turn-open emails plus reminders) | PASS | [Brevo email API](https://www.brevo.com/features/email-api/), [Brevo pricing](https://www.brevo.com/pricing/) |

Note on the rows-written count: D1 counts index entries as extra rows written. Keep secondary indexes on the packed table minimal.

Uncertain: the docs do not say whether a `db.batch()` of N statements counts as N queries against the 50 cap. We assume N (the conservative reading).

## D1 max bound params

**D1 max bound params: 100 per statement** (all plans). SQL statement length is capped at 100,000 bytes, and per-query limits apply to each statement inside `batch()`. Later tasks: never build `VALUES (?,?,...)` lists beyond 100 params. Prefer a single `json_each(?)` bind (1 param) for bulk writes. Confirm `json_each` works on D1 in the first data-layer task.

## PBKDF2 iterations

**PBKDF2 iterations: max 100,000 on Cloudflare Workers.** Use 100,000 with SHA-256 as the target. Store the algorithm and iteration count inside each stored hash (for example `pbkdf2-sha256$100000$salt$hash`) so it can be raised on a company server later.

- Evidence: the workerd source (`checkPbkdfIterations`) says "historically we've limited this to 100,000 iterations max"; above that, WebCrypto throws `NotSupportedError`: "Pbkdf2 failed: iteration counts above N are not supported". Source: [workerd limit-enforcer.h](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h) and [impl.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/crypto/impl.c%2B%2B). Third-party confirmation: [lord.technology, 2024-02-21](https://lord.technology/2024/02/21/hashing-passwords-on-cloudflare-workers.html). The official Web Crypto docs page does not state the cap ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)).
- This is below the OWASP recommendation (600,000 for PBKDF2-SHA256). Accepted: only the admin creates accounts, there is no public signup, and logins are rate-limited.
- **CPU risk:** Free CPU is 10 ms per request. Local measurement on 2026-10-19, Node `pbkdf2Sync` SHA-256, 100,000 iterations: about 72 ms on a generic Xeon 2.8 GHz VM. Whether Cloudflare counts native crypto time and how fast its hardware is are not documented. Required follow-up: deploy a test Worker on the Free plan and time a login. If it hits Error 1102, options in order: (a) lower iterations until it passes and record the value here; (b) PBKDF2-SHA-1 or fewer iterations with a longer minimum password length; (c) Workers Paid (owner decision, breaks $0). Do not silently weaken the hash; record the chosen value in this file.
- Add login rate limiting before running PBKDF2.
- **Decision (Task 7, ruling R4): 10,000 iterations, PBKDF2-SHA256, 16-byte random salt.** Reason: Workers Free allows about 10 ms CPU per request and 100,000 iterations measured about 72 ms. Stored as `pbkdf2-sha256$10000$<base64 hash>` (salt in `pw_salt`), and `verifyPassword` reads the count from the stored string, so it can be raised later without breaking existing passwords. The weaker hash is compensated by login throttling: 5 failed attempts per username in 15 minutes returns 429 before any password work (table `login_failures`, migration 0002). Still to confirm on a deployed Free Worker that a login stays under the CPU limit.

## Email

**Recommended provider: Brevo (free plan), HTTPS API.** Endpoint `POST https://api.brevo.com/v3/smtp/email` with an `api-key` header, JSON body (`sender`, `to`, `subject`, `htmlContent`, optional `replyTo`).

Limits (free plan):
- 300 emails per day, no time limit, no credit card ([Brevo pricing](https://www.brevo.com/pricing/), [Brevo email API](https://www.brevo.com/features/email-api/)). Transactional API and SMTP are included on all plans.
- Free-plan emails likely carry a Brevo footer/logo (removal is listed as a paid feature; not confirmed on the free plan).
- Brevo may review new accounts before enabling sending ("After Brevo approves your account for sending", pricing FAQ).

No custom domain: it works, with a catch.
- Free domains such as gmail.com cannot be authenticated ([Brevo domain help](https://help.brevo.com/hc/en-us/articles/12163873383186-Create-a-new-sender-and-verify-a-sender-address)). A sender on an unauthenticated domain is verified instead by a 6-digit code sent to that address ([Create a new sender](https://help.brevo.com/hc/en-us/articles/208836149)).
- Brevo "replaces any free email address used for sending" with a compliant one on its own domain, for example `mycompany@5000001.t-sender-sib.com` for transactional mail ([Brevo Gmail/Yahoo requirements](https://help.brevo.com/hc/en-us/articles/14925263522578-Prepare-for-Gmail-and-Yahoo-s-new-sender-requirements); [community thread](https://community.brevo.com/t/email-being-sent-with-t-sender-sib-com/783)). Brevo calls this a stopgap, not a permanent solution. Result: mail is delivered (it passes SPF/DKIM/DMARC as Brevo's domain) but the visible From address is not the Gmail address.
- Mitigation: set `replyTo` to the owner's Gmail, use a clear display name (for example "Target Portal"), and keep subject/body plain with the direct link.

Owner setup steps:
1. Create a free Brevo account with the owner's Gmail (or a dedicated Gmail such as the one used for the portal). Complete any account validation Brevo asks for.
2. Settings > Senders, Domains, IPs > Senders > Add a sender: name "Target Portal", email = that Gmail address. Enter the 6-digit code Brevo emails to that address.
3. SMTP & API > API keys > Generate a new API key. Give it to Claude only as a Worker secret (`wrangler secret put BREVO_API_KEY`), never in the repo.
4. Set the sender address as the Worker variable `MAIL_FROM` (the verified Gmail address; also used as reply-to). The sender name is fixed in code as "Target Portal".
5. Send a test to a company inbox and to a personal inbox. Check spam folders and report the result. Ask company IT to allow-list `*.t-sender-sib.com` / `brevo` if the company inbox blocks it.

Caveats:
- Deliverability to company mail (Microsoft 365, Gmail Workspace) is not guaranteed. A mail may be spam-filtered or rejected. This is why the in-app "My tasks" page and the admin "copy link" are the reliable signals.
- Gmail sending limits and DMARC (`p=none` or stricter at gmail.com) make direct sending from a Worker as `@gmail.com` impossible, so a relay is required; Brevo's rewrite is what keeps it working.
- The API calls are plain `fetch`, so the code is portable; the provider can be swapped (including SMTP on a company server later) behind one `sendEmail()` function.
- Not verified by me (no account to test with): whether the Brevo API refuses an unverified sender, and how long new-account approval takes. Check these in the email task with a real key.

Alternatives checked ($0, Worker over HTTPS):
- **Cloudflare Email Service:** free on Workers Free but only to verified destination addresses in the owner's account; arbitrary recipients need Workers Paid or an onboarded sending domain ([Email Service](https://developers.cloudflare.com/email-service/), [limits](https://developers.cloudflare.com/email-service/platform/limits/)). FAIL for our use.
- **Mailjet free:** 200 per day, 6,000 per month, API/SMTP included ([Mailjet pricing](https://www.mailjet.com/pricing/)). Single-sender validation behaviour for Gmail addresses not verified; use as a backup if Brevo account approval fails.
- Resend and similar services require a verified domain to mail arbitrary recipients (from general knowledge, not re-checked): not suitable.

## Sources (all accessed 2026-10-19)

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/email-service/ and /platform/limits/
- https://github.com/cloudflare/workerd (limit-enforcer.h, impl.c++)
- https://lord.technology/2024/02/21/hashing-passwords-on-cloudflare-workers.html
- https://www.brevo.com/pricing/ and /features/email-api/
- https://help.brevo.com/hc/en-us/articles/208836149, /12163873383186, /14925263522578
- https://community.brevo.com/t/email-being-sent-with-t-sender-sib-com/783
- https://www.mailjet.com/pricing/

## Bulk import from Excel (Task E, 2026-10-22)

Owner request: admin bulk-loads Users, Packs and the Hierarchy tree from Excel (add and update only; nothing deleted or disabled; rows missing from the file are left alone).

- **Where the work runs.** The browser reads the .xlsx (read-excel-file) and sends text rows. `src/shared/imports.ts` computes the plan (create / update / unchanged + issues by sheet row); the Worker runs it on `/preview` and again on `/apply` (never trusts the preview). Routes: `POST /api/admin/import/{users|packs|hierarchy}/{preview|apply}` and `POST /api/admin/import/users/password`, behind the admin guard and the JSON content-type guard. At most 2,000 rows per file (413 above).
- **Atomic apply.** One `db.batch()` of set-based statements (`json_each`, at most 500 rows per statement; packs use `insertJson`, 200 rows) plus one audit row (`import.users` / `import.packs` / `import.hierarchy`, counts and names, never passwords or hashes). A file with any error writes nothing. A re-applied file has 0 changes and writes nothing (no audit row either). A concurrent change that breaks a UNIQUE, FOREIGN KEY or NOT NULL constraint rolls the batch back as 409.
- **Passwords: N = 1 per request.** PBKDF2-SHA256 at 10,000 iterations measured **5.3 ms CPU per hash** (Node WebCrypto, 2-vCPU VM, 50 runs, 2026-10-22); two would exceed the ~10 ms Free-plan budget, so each password is one request (`/users/password`, op `verify` or `hash`), exactly like login and user creation. Results are staged in `import_passwords` (migration 0004: import id, username, admin id, hash/salt or NULL = "already the current password"; pruned after 1 hour; excluded from the backup). Apply copies the staged hashes in its single batch and deletes them, so the user writes stay atomic. Existing users' passwords are checked (`verify`) before hashing, so re-importing the same file is 0 changes. Because `verify` tells whether a password is right, it uses the login throttle (R4): each check is recorded in `login_failures` first (insert-first, like the login), removed again when the answer is "same", and more than 5 in 15 minutes for a username is 429 (this also throttles that user's login, as intended). A staged slot (import id + username) belongs to the admin who staged it (another admin's write is 409 `import_slot_taken`); staged rows older than 1 hour are ignored by preview and apply even before they are pruned. Apply returns `passwordsSet` (usernames whose password it actually set); the browser shows a generated password only for those. Password cells are used exactly as typed (not trimmed); the owner guide says to format Username/Password columns as Text. A blank password for a new user gets a generated one (12 characters from a 55-letter alphabet without look-alikes, ~69 bits), returned once by the password step and shown in the browser only after Apply succeeds; never stored or logged. Same rules as the user screens: usernames lower-cased (R11), the admin cannot demote themself, a reset signs the user out (not the admin's own sessions).
- **Hierarchy semantics.** Rows match nodes by (department code or name, node name); node names must be unique per department. Blank parent = department head; the existing head can be neither replaced nor moved (uq_nodes_root); cycles (in the file or through the live tree) are errors; a blank manager keeps the current one (none for a new node, with a warning). New nodes are inserted level by level (parents first, at most 8 levels of new nodes under new nodes). Interpretation: "changes apply to the live tree only, as the existing hierarchy admin screens do" was read as "same behaviour as the tree editor", which carries edits into open months (spec section 5): manager changes go to running/loading months at once (new set-based tree change kind `managers`), and each moved node that is in an open month goes through the existing safe-rule `move_node` propagation. Month data is never edited any other way.
- **D1 budget.** Measured with a query-counting wrapper (test/worker/imports.test.ts, which asserts the exact figure): worst-case hierarchy apply = **44 queries** including the session lookup (2,000 rows: 4 open-month moves + manager changes, new nodes on 8 levels sized to need the maximum 11 insert statements of 500 rows, 1 update, 1 audit, 2 for managers, 24 for moves). Users apply ≤ 13, password step ≤ 7, packs apply ≤ 13. Each open-month node move costs 6 queries, hence **at most 4 such moves per import** (more is an error asking to split the file or use the tree).
- **Not atomic with the open months.** The live-tree write is one atomic batch; carrying its moves and manager changes into open months runs afterwards in separate batches, exactly like the tree editor. If that step fails, the tree change stands and the result's `treeChange.error` is shown in the banner.
- **Cycle and depth check** is one linear pass (colouring walk up the parent links with memoised levels); a 2,000-node chain or loop is checked in milliseconds. Long loops are shown with their first 10 names.
- **CPU risk (accepted, unmeasured on Cloudflare).** Planning 2,000 rows is a few Map lookups per row; not benchmarked on a deployed Free Worker. If a 2,000-row import ever hits Error 1102, split the file.

