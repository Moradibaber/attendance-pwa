# فرم ثبت تردد آفلاین

این بسته یک PWA ساده برای ثبت آفلاین تردد است:

- ثبت نام، نام خانوادگی و شماره پرسنلی
- ثبت شروع/پایان
- گرفتن عکس چهره و فشرده‌سازی آن
- ثبت موقعیت جغرافیایی
- ذخیره آفلاین در IndexedDB
- هشدار حذف اطلاعات
- ارسال دستی به Google Sheets از طریق Google Apps Script
- نگهداری اطلاعات ارسال‌نشده تا ارسال موفق
- پاکسازی فقط برای رکوردهای ارسال‌شده بعد از ۹۰ روز

## ستون‌های پیشنهادی Google Sheet

در Sheet با نام `Records` این ستون‌ها را به همین ترتیب بسازید:

```text
ID, PersonnelCode, FirstName, LastName, RecordType, RecordDate, RecordTime, RecordHour, Latitude, Longitude, Accuracy, PhotoUrl, DeviceTime, ServerTime, Status, Note, DuplicateKey
```

## راه‌اندازی Google Apps Script

1. داخل Google Sheet بروید به `Extensions > Apps Script`.
2. محتوای فایل `apps-script.gs` را داخل Apps Script کپی کنید.
3. ذخیره کنید.
4. از `Deploy > New deployment` گزینه `Web app` را انتخاب کنید.
5. مقدار `Execute as` را روی `Me` بگذارید.
6. مقدار `Who has access` را روی `Anyone` یا `Anyone with the link` بگذارید.
7. Deploy کنید و Web app URL را کپی کنید.
8. در فایل `app.js` مقدار زیر را با همان URL جایگزین کنید:

```js
appsScriptUrl: "PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE"
```

## اجرای PWA

برای کارکرد Service Worker و نصب PWA، فایل‌ها باید روی HTTPS یا localhost اجرا شوند. برای تست ساده می‌توانید آن را روی یک هاست HTTPS، GitHub Pages، Netlify یا هر هاست داخلی HTTPS قرار دهید.

## نکته مهم

PWA نمی‌تواند صددرصد جلوی حذف دستی اطلاعات مرورگر را بگیرد. این نسخه از IndexedDB و Persistent Storage استفاده می‌کند و داخل برنامه هشدار واضح نمایش می‌دهد. اگر کاربر `Clear data` بزند یا مرورگر را حذف کند، احتمال حذف اطلاعات وجود دارد.
