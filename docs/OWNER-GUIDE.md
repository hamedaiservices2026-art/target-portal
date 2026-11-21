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

### Bulk import from Excel (users, packs, hierarchy)

The **Users**, **Packs** and **Hierarchy** screens each have an **Import from Excel** button.

1. Press **Download template**. Keep the header row, delete the example row, and fill in one row per record.
2. Press **Choose Excel file**. Nothing is saved yet: you see how many rows will be added, updated or left unchanged, and every problem with its Excel row number.
3. Fix any **errors** in the file and choose it again. **Warnings** can be accepted.
4. Press **Apply**. The whole file is saved together, or nothing is.

Tip: in Excel, format the **Username** and **Password** columns as **Text** before typing (Home > Number format > Text), so values like `00123456` keep their leading zeros. Passwords are used exactly as typed, spaces included.

Rules: the import only adds and updates. It never deletes or disables anything, and records that are not in the file stay as they are. Importing the same file again changes nothing. At most 2,000 rows per file.

Template columns:

| Screen | Columns | Notes |
|---|---|---|
| Users | `Username`, `Full name`, `Role`, `Password`, `Language`, `Email` | Role is `admin` or `manager`. Language (`en`/`ar`) and Email are optional. New user with a blank Password: the portal generates one and shows it **once** after Apply, with a **Download passwords** button. Existing user: blank Password keeps the current one; a value resets it and signs that user out. Passwords are never stored in History. Users with passwords are prepared one by one, so a big file takes a little while. |
| Packs | `Code`, `Group`, `Sort order`, `Active` | Group is exactly `CSD`, `Water` or `LRB-Others`. Sort order and Active (`yes`/`no`) are optional. |
| Hierarchy | `Department`, `Node name`, `Parent node name`, `Manager username` | Department is the department code. A row matches a node by department + node name, so node names must be unique in a department. Leave Parent node name blank only for the department head. Manager username must be an existing active user (import users first); blank keeps the current manager. Rows can be in any order. Moves and manager changes reach open months the same way as edits in the tree; at most 4 moves of nodes in an open month per file. |

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

### الاستيراد الجماعي من إكسل (المستخدمون، العبوات، الهيكل)

في كل من شاشات **Users** و**Packs** و**Hierarchy** زر **Import from Excel** (استيراد من إكسل).

1. اضغط **Download template** (تحميل النموذج). أبقِ صف العناوين، واحذف صف المثال، واكتب صفًا واحدًا لكل سجل.
2. اضغط **Choose Excel file** (اختيار ملف إكسل). لن يُحفظ شيء بعد: سترى عدد الصفوف التي ستُضاف أو تُحدَّث أو تبقى دون تغيير، وكل مشكلة مع رقم صفها في ملف Excel.
3. صحّح أي **أخطاء** في الملف ثم اختره من جديد. يمكن قبول **التنبيهات**.
4. اضغط **Apply** (تطبيق). يُحفظ الملف كله معًا، أو لا يُحفظ منه شيء.

نصيحة: في Excel نسّق عمودي **Username** و**Password** بتنسيق **نص** (Text) قبل الكتابة (الصفحة الرئيسية > تنسيق الأرقام > نص)، حتى تحتفظ القيم مثل `00123456` بالأصفار في أولها. تُستخدم كلمات المرور كما كُتبت تمامًا، بما فيها المسافات.

القواعد: الاستيراد يضيف ويحدّث فقط. لا يحذف شيئًا ولا يعطّل شيئًا، وتبقى السجلات غير الموجودة في الملف كما هي. استيراد الملف نفسه مرة أخرى لا يغيّر شيئًا. الحد الأقصى 2,000 صف لكل ملف.

أعمدة النماذج (تُكتب العناوين بالإنجليزية كما هي):

| الشاشة | الأعمدة | ملاحظات |
|---|---|---|
| Users | `Username`، `Full name`، `Role`، `Password`، `Language`، `Email` | الدور `admin` أو `manager`. اللغة (`en`/`ar`) والبريد اختياريان. مستخدم جديد بكلمة مرور فارغة: تُنشئ البوابة كلمة مرور وتعرضها **مرة واحدة فقط** بعد التطبيق، مع زر **Download passwords** لتحميلها. مستخدم موجود: الفراغ يُبقي كلمة المرور الحالية، وأي قيمة تعيد تعيينها وتُخرج المستخدم من جلساته. لا تُحفظ كلمات المرور أبدًا في السجل (History). تُجهَّز كلمات المرور واحدة تلو الأخرى، لذا يستغرق الملف الكبير بعض الوقت. |
| Packs | `Code`، `Group`، `Sort order`، `Active` | المجموعة إحدى القيم التالية تمامًا: `CSD` أو `Water` أو `LRB-Others`. ترتيب العرض والحالة Active (`yes`/`no`) اختياريان. |
| Hierarchy | `Department`، `Node name`، `Parent node name`، `Manager username` | Department هو رمز القسم. يُطابَق الصف مع المستوى بالقسم واسم المستوى، لذا يجب ألا يتكرر اسم المستوى داخل القسم. اترك Parent node name فارغًا لرأس القسم فقط. يجب أن يكون Manager username مستخدمًا موجودًا ونشطًا (استورد المستخدمين أولًا)، والفراغ يُبقي المدير الحالي. ترتيب الصفوف حر. تنتقل عمليات النقل وتغيير المديرين إلى الأشهر المفتوحة كما يحدث عند التعديل في الشجرة، وبحد أقصى 4 عمليات نقل لمستويات داخل شهر مفتوح في كل ملف. |

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
