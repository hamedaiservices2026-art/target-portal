# Target Portal: Owner Guide

English first, then Arabic (العربية أدناه).

---

# English

You do not write code. Claude does. You only use the portal's admin screens and the GitHub and Cloudflare websites.

Live address: https://target-portal.hamedaiservices2026.workers.dev

## 1. How deployment works

Deployment is automatic. Every time Claude pushes code to GitHub, the **Deploy** workflow (GitHub > Actions) builds, tests and publishes the portal to Cloudflare. If it shows a green tick, the live site is updated. You never deploy by hand.

To publish again without a code change (for example after changing a secret): GitHub > Actions > **Deploy** > **Run workflow**.

## 2. One-time setup: GitHub secrets

Go to GitHub > your repository > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**. Add these:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with account-level permissions **Workers Scripts: Edit** and **D1: Edit**. Create it in Cloudflare > My Profile > API Tokens. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (Cloudflare dashboard > Workers & Pages, right-hand side). |
| `BOOTSTRAP_ADMIN_PASSWORD` | The password for the first login (see section 5). Choose a long one. |
| `BREVO_API_KEY` | Brevo API key for sending email (section 4). Optional. |
| `MAIL_FROM` | The verified sender email address in Brevo (section 4). Optional. |
| `APP_URL` | `https://target-portal.hamedaiservices2026.workers.dev` |

Note on `APP_URL`: it is used for the links in emails, including the daily deadline reminders. Set it exactly as shown, with no slash at the end.

Rules for secrets:

- **Never paste a secret in a chat**, not even to Claude. Type it only into the GitHub secret box.
- If a token or key is ever exposed: open Cloudflare (or Brevo), **roll** (regenerate) it, and update only the GitHub secret with the new value.
- After you change any secret, re-run the **Deploy** workflow so the portal picks it up.

## 3. Workers.dev address

Cloudflare needs a workers.dev subdomain for your account (Cloudflare > Workers & Pages). This is already done for this account. The live address above is the result.

## 4. Email with Brevo (optional)

Without email the portal still works fully. Managers just do not get notification emails. The skipped emails are recorded in the `email_log` table with the result `logged`.

1. Create a free account at brevo.com.
2. Verify a single sender: Brevo > Senders > add your Gmail address and confirm the link Brevo sends you.
3. Create an API key (version v3): Brevo > SMTP & API > API Keys > Generate.
4. In GitHub, set `BREVO_API_KEY` to that key and `MAIL_FROM` to the verified sender address exactly.
5. Re-run the **Deploy** workflow.

The free plan allows 300 emails per day, which is enough for this portal.

## 5. First login and users

1. Open the live address and sign in with username `admin` and the password you saved as `BOOTSTRAP_ADMIN_PASSWORD`.
2. Go to **Users**. Add each manager (full name, username, email, role, language). Give each person their own password with **Reset password**.
3. Change the `admin` password in **Users** > **Reset password** and keep it private. The bootstrap login only creates the first admin when there are no users; after that the account is a normal one.

Other setup screens in the top menu: **Departments**, **Packs**, **Settings** (the distribution cap), **Hierarchy** (the tree of managers and the route mapping upload).

## 6. Monthly checklist

1. **Months** > **Open a new month**. Enter the month as YYYY-MM (for example 2026-11) and an optional deadline.
2. Open the month. For each department, press **Upload forecast**:
   - Optional: choose the **Sheet 1** file to compare totals per pack.
   - Choose the forecast Excel file. The forecast can be on any sheet. The Period column header can be `Period (YYYY-MM)` or `Period (YYYYMM)`.
   - Blank **Cases** cells are counted as 0 and shown as a warning. You may accept warnings.
3. Fix every **error** in the Excel file and choose it again. Nothing is saved until there are no errors and you press **Accept and upload**.
4. When the upload is done, press **Start**. The top manager gets the task and an email.
5. Watch the **Status board**. Use **Refresh**, **Reopen**, **Push forward** or **Copy link** when someone is stuck.
6. When the department shows **Complete**, press **Export Excel** (or **Export all departments**). The file is in the same format as the forecast. Give it to the commission system.

If something is wrong with a department before it starts, **Reset** deletes its uploaded forecast so you can upload again.

## 7. Backups

In the portal: **History** > **Download backup**. You get one file with all the data except passwords. Download one at the end of each month and keep it in a safe place (not only on one computer).

Second safety net in Cloudflare: Cloudflare dashboard > **Storage & Databases** > **D1** > `target-portal`. There you can export the database and use Time Travel (point-in-time restore).

## 8. Before the real launch

The Deploy workflow currently also runs on pushes to the preview branch `build/portal-v1`. When Claude merges to `main` for the real launch, Claude will remove the `build/portal-v1` push trigger from `.github/workflows/deploy.yml`. You do not need to do anything.

## 9. If something fails

- Green tick in GitHub > Actions = deployed. Red cross = open the run, copy the error text (it contains no secrets), and send it to Claude.
- Cannot sign in as `admin`: check `BOOTSTRAP_ADMIN_PASSWORD` is set and the Deploy was re-run. If an admin already exists, use that admin's current password.

---

<div dir="rtl" lang="ar">

# العربية

# دليل المالك: بوابة الأهداف

لا تحتاج إلى كتابة أي كود، فهذا عمل Claude. أنت تستخدم فقط شاشات الإدارة في البوابة ومواقع GitHub وCloudflare.

العنوان المباشر: https://target-portal.hamedaiservices2026.workers.dev

## ١. كيف يتم النشر

النشر تلقائي. عندما يرفع Claude الكود إلى GitHub يعمل مسار **Deploy** (من GitHub > Actions) فيبني البوابة ويختبرها وينشرها على Cloudflare. إذا ظهرت علامة صح خضراء فقد تم تحديث الموقع. لا تنشر يدويًا أبدًا.

لإعادة النشر دون تغيير في الكود (مثلًا بعد تغيير سرّ): GitHub > Actions > **Deploy** > **Run workflow**.

## ٢. الإعداد لمرة واحدة: أسرار GitHub

افتح مستودع المشروع في GitHub > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**، ثم أضف الأسرار التالية:

| السرّ | المعنى |
|---|---|
| `CLOUDFLARE_API_TOKEN` | رمز API من Cloudflare بصلاحيتين على مستوى الحساب: **Workers Scripts: Edit** و**D1: Edit**. يُنشأ من Cloudflare > My Profile > API Tokens. |
| `CLOUDFLARE_ACCOUNT_ID` | معرّف حساب Cloudflare (لوحة Cloudflare > Workers & Pages، في الجانب). |
| `BOOTSTRAP_ADMIN_PASSWORD` | كلمة مرور أول دخول (انظر القسم ٥). اختر كلمة طويلة. |
| `BREVO_API_KEY` | مفتاح Brevo لإرسال البريد (القسم ٤). اختياري. |
| `MAIL_FROM` | عنوان المرسل الذي تم توثيقه في Brevo (القسم ٤). اختياري. |
| `APP_URL` | `https://target-portal.hamedaiservices2026.workers.dev` |

ملاحظة عن `APP_URL`: يُستخدم للروابط في رسائل البريد، ومنها رسائل التذكير اليومية بالموعد النهائي. اكتبه كما هو تمامًا ودون شرطة مائلة في آخره.

قواعد الأسرار:

- **لا تلصق أي سرّ في المحادثة أبدًا**، حتى مع Claude. اكتبه فقط في خانة السرّ داخل GitHub.
- إذا انكشف رمز أو مفتاح: افتح Cloudflare (أو Brevo) وأنشئ رمزًا جديدًا بدل القديم (**Roll**)، ثم حدّث سرّ GitHub فقط بالقيمة الجديدة.
- بعد تغيير أي سرّ أعد تشغيل مسار **Deploy** لتلتقطه البوابة.

## ٣. عنوان workers.dev

يحتاج حسابك في Cloudflare إلى نطاق فرعي من workers.dev (Cloudflare > Workers & Pages). هذا منجز مسبقًا لهذا الحساب، والعنوان المباشر أعلاه هو نتيجته.

## ٤. البريد الإلكتروني عبر Brevo (اختياري)

تعمل البوابة كاملة بدون بريد، لكن المديرين لن يصلهم إشعار. الرسائل التي لم تُرسل تُسجَّل في جدول `email_log` بنتيجة `logged`.

1. أنشئ حسابًا مجانيًا في brevo.com.
2. وثّق مرسلًا واحدًا: Brevo > Senders ثم أضف عنوان Gmail وأكّد الرابط الذي تصلك به رسالة من Brevo.
3. أنشئ مفتاح API (الإصدار v3): Brevo > SMTP & API > API Keys > Generate.
4. في GitHub اجعل `BREVO_API_KEY` هو المفتاح، و`MAIL_FROM` هو عنوان المرسل الموثَّق تمامًا كما كتبته.
5. أعد تشغيل مسار **Deploy**.

الخطة المجانية تسمح بـ ٣٠٠ رسالة يوميًا، وهذا كافٍ لهذه البوابة.

## ٥. أول دخول والمستخدمون

1. افتح العنوان المباشر وسجّل الدخول باسم المستخدم `admin` وكلمة المرور التي حفظتها في `BOOTSTRAP_ADMIN_PASSWORD`.
2. افتح **Users** (المستخدمون). أضف كل مدير (الاسم الكامل، اسم المستخدم، البريد، الدور، اللغة). أعطِ كل شخص كلمة مرور خاصة به عبر **Reset password**.
3. غيّر كلمة مرور `admin` من **Users** > **Reset password** واحفظها سرًّا. دخول البداية ينشئ أول مدير فقط عندما لا يوجد مستخدمون، وبعد ذلك يصبح الحساب عاديًا.

شاشات الإعداد الأخرى في القائمة العلوية: **Departments** (الأقسام)، **Packs** (العبوات)، **Settings** (الإعدادات: سقف التوزيع)، **Hierarchy** (الهيكل: شجرة المديرين ورفع ربط المسارات).

## ٦. قائمة العمل الشهرية

1. **Months** > **Open a new month**. أدخل الشهر بصيغة YYYY-MM (مثل 2026-11) وموعدًا نهائيًا اختياريًا.
2. افتح الشهر. لكل قسم اضغط **Upload forecast**:
   - اختياري: اختر ملف **Sheet 1** لمقارنة إجمالي كل عبوة.
   - اختر ملف Excel الخاص بالتوقعات. يمكن أن يكون التوقع في أي ورقة. عنوان عمود الفترة يكون `Period (YYYY-MM)` أو `Period (YYYYMM)`.
   - خانات **Cases** الفارغة تُحسب صفرًا وتظهر كتحذير. يمكنك قبول التحذيرات.
3. أصلح كل **خطأ** في ملف Excel ثم اخترْه من جديد. لا يُحفظ شيء حتى تزول الأخطاء وتضغط **Accept and upload**.
4. بعد اكتمال الرفع اضغط **Start**. تصل المهمة ورسالة البريد إلى المدير الأعلى.
5. تابع **Status board**. استخدم **Refresh** أو **Reopen** أو **Push forward** أو **Copy link** عندما يتعطل أحد.
6. عندما يظهر القسم **Complete** اضغط **Export Excel** (أو **Export all departments**). الملف بنفس صيغة ملف التوقعات. سلّمه إلى نظام العمولات.

إذا حدث خطأ في قسم قبل أن يبدأ، فإن **Reset** يحذف التوقع المرفوع ليمكنك الرفع من جديد.

## ٧. النسخ الاحتياطي

من البوابة: **History** > **Download backup**. تحصل على ملف واحد فيه كل البيانات ما عدا كلمات المرور. نزّل نسخة في نهاية كل شهر واحفظها في مكان آمن (وليس على جهاز واحد فقط).

شبكة أمان ثانية في Cloudflare: لوحة Cloudflare > **Storage & Databases** > **D1** > `target-portal`. يمكنك هناك تصدير قاعدة البيانات واستعادتها إلى نقطة زمنية سابقة (Time Travel).

## ٨. قبل الإطلاق الفعلي

يعمل مسار Deploy حاليًا أيضًا عند الرفع إلى الفرع التجريبي `build/portal-v1`. عندما يدمج Claude الكود في `main` للإطلاق الفعلي، سيزيل Claude مشغّل الرفع الخاص بالفرع `build/portal-v1` من الملف `.github/workflows/deploy.yml`. لا تحتاج إلى فعل شيء.

## ٩. عند حدوث مشكلة

- علامة صح خضراء في GitHub > Actions تعني أن النشر تم. علامة X حمراء تعني أن تفتح التشغيل وتنسخ نص الخطأ (لا يحتوي على أسرار) وترسله إلى Claude.
- تعذّر الدخول باسم `admin`: تأكد أن `BOOTSTRAP_ADMIN_PASSWORD` مضبوط وأنك أعدت تشغيل Deploy. وإذا كان للمدير حساب قائم فاستخدم كلمة مروره الحالية.

</div>
