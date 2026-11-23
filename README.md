# התאמת בנק וחשבוניות — מדריך הקמה

אתר עצמאי שמאגד את תנועות הבנק וכרטיסי האשראי, מוצא ב-Gmail את החשבוניות והקבלות, ומוציא דוח מלא של מה חסר. Claude מזהה את שם בית העסק ומתאים בין התנועות למסמכים.

האתר רץ על שרת משלך, נפתח מכל מכשיר (מחשב, טלפון, טאבלט), ואינו תלוי בחשבון Claude.ai שלך.

---

## מה צריך לפני שמתחילים

ההקמה לוקחת בערך שעה, פעם אחת. צריך חשבונות בחמישה שירותים:

| שירות | בשביל מה | עלות |
|---|---|---|
| **GitHub** | מקום לשמור את קוד האתר | חינם |
| **Render** | השרת שמריץ את האתר | חינם (השרת "נרדם" אחרי 15 דקות בלי שימוש, והפתיחה הראשונה אחרי זה לוקחת עד דקה) |
| **Neon** | מסד הנתונים ששומר את התנועות והמסמכים | חינם (עד 1GB) |
| **Google Cloud** | ההרשאה לקרוא מ-Gmail ולהיכנס לאתר | חינם |
| **Anthropic Console** | מפתח ל-Claude, שקורא את החשבוניות ומתאים | תשלום לפי שימוש. כדאי להגדיר תקרה חודשית |

> חשוב: מפתח ה-Claude API מחויב בנפרד מהמנוי שלך ל-Claude.

---

## שלב 1: העלאת הקוד ל-GitHub

1. היכנס ל-github.com (או פתח חשבון).
2. לחץ **New repository**. תן שם, למשל `bank-invoice-reconcile`, ובחר **Private**. לחץ **Create repository**.
3. במסך שנפתח לחץ על הקישור **uploading an existing file**.
4. פתח את קובץ ה-zip שקיבלת, וגרור לדפדפן **את כל מה שבתוך התיקייה** (כולל התיקיות `lib` ו-`public`).
5. לחץ **Commit changes**.

## שלב 2: מסד נתונים ב-Neon

1. היכנס ל-neon.com ופתח חשבון.
2. צור פרויקט חדש. באזור (Region) בחר את האזור באירופה (למשל Frankfurt), הכי קרוב לישראל.
3. לחץ **Connect** והעתק את ה-**Connection string**. הוא מתחיל ב-`postgresql://` ומסתיים ב-`sslmode=require`.
4. שמור אותו בצד. זה הערך של `DATABASE_URL`.

## שלב 3: מפתח Claude ב-Anthropic Console

1. היכנס ל-console.anthropic.com ופתח חשבון.
2. ב-**Billing** הוסף קרדיט (למשל 10 דולר להתחלה).
3. ב-**Limits** הגדר תקרת הוצאה חודשית, כדי שלא יהיו הפתעות.
4. ב-**API Keys** לחץ **Create Key**, תן שם והעתק את המפתח (מתחיל ב-`sk-ant-`). המפתח מוצג פעם אחת בלבד.
5. שמור אותו בצד. זה הערך של `ANTHROPIC_API_KEY`.

## שלב 4: השרת ב-Render

1. היכנס ל-render.com והירשם **עם חשבון ה-GitHub** שלך.
2. לחץ **New** ← **Web Service**, ובחר את המאגר שהעלית בשלב 1.
3. מלא:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. בחלק **Environment Variables** הוסף:

| שם | ערך |
|---|---|
| `ALLOWED_EMAILS` | כתובת המייל שלך (אם יש כמה, מפרידים בפסיק) |
| `SESSION_SECRET` | מחרוזת אקראית של לפחות 32 תווים. ב-Render יש כפתור **Generate** שיוצר אחת |
| `ANTHROPIC_API_KEY` | המפתח משלב 3 |
| `DATABASE_URL` | המחרוזת משלב 2 |

5. לחץ **Deploy Web Service** והמתן כמה דקות.
6. למעלה יופיע הכתובת של האתר, למשל `https://bank-invoice-reconcile.onrender.com`. **העתק אותה**, תצטרך אותה בשלב הבא.

בשלב הזה, אם תפתח את האתר תראה הודעה שחסרים `GOOGLE_CLIENT_ID` ו-`GOOGLE_CLIENT_SECRET`. זה תקין.

## שלב 5: הרשאה ל-Gmail ב-Google Cloud

עשה את השלב הזה **מחובר לחשבון Google שבו נמצא המייל עם החשבוניות**.

1. היכנס ל-console.cloud.google.com וצור פרויקט חדש (למשל "התאמת חשבוניות").
2. בחיפוש למעלה כתוב **Gmail API**, פתח אותו ולחץ **Enable**.
3. בחיפוש כתוב **Google Auth Platform** ולחץ **Get started**:
   - **App name:** התאמת חשבוניות
   - **User support email:** המייל שלך
   - **Audience:** אם המייל שלך בדומיין של העסק (Google Workspace), בחר **Internal**. אם זה מייל gmail.com רגיל, בחר **External**.
   - **Contact information:** המייל שלך. אשר ולחץ **Create**.
4. אם בחרת **External**: עבור ל-**Audience**, ותחת **Test users** הוסף את המייל שלך.
5. עבור ל-**Data Access** ← **Add or remove scopes**. חפש `gmail.readonly`, סמן אותו, ולחץ **Update** ואז **Save**.
6. עבור ל-**Clients** ← **Create client**:
   - **Application type:** Web application
   - **Authorized redirect URIs:** הכתובת מ-Render ואחריה `/auth/callback`. למשל:
     `https://bank-invoice-reconcile.onrender.com/auth/callback`
   - לחץ **Create** והעתק את ה-**Client ID** ואת ה-**Client secret**.

> **Internal או External?** באפליקציה **Internal** (חשבון Workspace) לא צריך אישור של Google, וההתחברות נשמרת. באפליקציה **External** במצב בדיקה, Google מנתק את הגישה ל-Gmail כל 7 ימים, ותצטרך ללחוץ "התחבר מחדש ל-Google" בהגדרות של האתר.

## שלב 6: השלמת ההגדרות ב-Render

1. חזור ל-Render, לשירות שלך ← **Environment**.
2. הוסף:

| שם | ערך |
|---|---|
| `GOOGLE_CLIENT_ID` | ה-Client ID משלב 5 |
| `GOOGLE_CLIENT_SECRET` | ה-Client secret משלב 5 |

3. לחץ **Save Changes**. Render יפעיל מחדש את האתר אוטומטית.

## שלב 7: כניסה ראשונה

1. פתח את כתובת האתר.
2. לחץ **התחבר עם Google**, בחר את החשבון שלך ואשר את הגישה ל-Gmail. סמן את התיבה של Gmail אם היא מופיעה.
3. לחץ **הגדרות** ומלא את שמות העסק (למשל "שטיינברג שמאות מקרקעין, שלום שטיינברג"). כך Claude מזהה חשבוניות שאתה הוצאת ללקוחות.

כדי שיהיה נוח, אפשר להוסיף את האתר למסך הבית בטלפון: בכרום ← תפריט ← **הוסף למסך הבית**.

---

## איך משתמשים

1. **חשבונות:** מורידים מאתר הבנק ומאתר חברת האשראי קובץ תנועות (אקסל, CSV או PDF) וגוררים לעמודה הראשונה.
2. **מייל:** לוחצים **סרוק חשבוניות ב-Gmail**. Claude קורא כל מייל עם חשבונית, כולל קבצי PDF מצורפים. סריקה חוזרת קוראת רק מיילים חדשים.
3. **התאמה:** לוחצים **בצע התאמה** ועוברים ל**דוח חוסרים**.

בדוח: תשלומים בלי חשבונית (מקובצים לפי ספק, עם נוסח מוכן לבקשת חשבונית), תשלומים שיש להם רק אישור תשלום, תנועות לבדיקה, וחשבוניות שלא נמצא להן חיוב. אפשר לייצא הכל לאקסל.

---

## כשמשהו לא עובד

| מה רואים | מה לעשות |
|---|---|
| `redirect_uri_mismatch` בכניסה | הכתובת ב-Google (שלב 5.6) חייבת להיות זהה בדיוק לכתובת האתר, עם `https://` ועם `/auth/callback` בסוף |
| "החשבון הזה לא ברשימת המורשים" | בדוק ש-`ALLOWED_EMAILS` ב-Render כולל בדיוק את המייל שאיתו נכנסת |
| `Access blocked` או `org_internal` | נכנסת עם חשבון אחר מזה שבו יצרת את הפרויקט ב-Google, או שבחרת External ולא הוספת את עצמך כ-Test user |
| Workspace חוסם את הגישה ל-Gmail | מנהל ה-Workspace צריך לאפשר את האפליקציה: Admin console ← Security ← API controls |
| האתר נטען לאט בפעם הראשונה | זה השרת החינמי של Render שמתעורר. עד דקה, ואז מהיר |
| "נגמרה היתרה בחשבון ה-Claude API" | הוסף קרדיט ב-console.anthropic.com |
| צריך להתחבר ל-Gmail שוב כל שבוע | האפליקציה ב-Google מוגדרת External. אם יש לך Workspace, שנה ל-Internal |

## עדכון האתר

כשתקבל גרסה חדשה של הקבצים, העלה אותם לאותו מאגר ב-GitHub (Add file ← Upload files). Render יעדכן את האתר לבד.

## אבטחה

- רק המיילים שב-`ALLOWED_EMAILS` יכולים להיכנס.
- הגישה ל-Gmail היא **קריאה בלבד**. האתר לא שולח, לא מוחק ולא משנה מיילים.
- טוקן הגישה ל-Gmail נשמר מוצפן במסד הנתונים.
- האתר לא מתחבר לבנק ולא מבקש סיסמאות. התנועות מגיעות רק מקבצים שאתה מעלה.
- אל תשתף את המפתחות (`ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `DATABASE_URL`) עם אף אחד.

---

## למפתחים

- Node.js 20 ומעלה, Express, Postgres (`pg`). בלי `DATABASE_URL` הנתונים נשמרים בקבצים בתיקייה `data`.
- הרצה מקומית: מעתיקים את `.env.example` ל-`.env`, ממלאים, ואז `npm install` ו-`npm run local`. ב-Google מוסיפים redirect URI: `http://localhost:3000/auth/callback`.
- המודלים של Claude נקבעים במשתנים `AI_MODEL_FAST`, `AI_MODEL` ו-`AI_MODEL_BEST`.
- מבנה: `server.js` (נתיבים), `lib/google.js` (כניסה ו-Gmail), `lib/claude.js` (Claude API), `lib/extract.js` (חילוץ חשבוניות), `lib/store.js` (שמירה), `public/` (הממשק).
