# النسخة المدمجة

الأساس: APIC-main (10) — فيه 1D part list auto import (nest-1d-*) وscrap/steel pricing.
اتضاف فوقه بالترتيب:
1. p3-step5 (واجهة شيت التسعير + route الـ snapshot)
2. p3-step6 (الـ offer من الـ snapshot المعتمد + migration 20261121090000_estimate_offer_snapshot_link)
3. accessories-section-code (parts-csv / csv-import-dialog / parts-grid / takeoff-view)

prisma/schema.prisma: ملف p10 كان ناقص 21 موديل (PricingSheet, Estimate*, RateProfile, WorkOrderGroup...)
مع إن الكود بيستخدمهم، فاستخدمت schema بتاع step6 (فيه كل الموديلات + أعمدة الـ offer) مع الحفاظ على تعليق nestKind الخاص بـ 1D.

بعد الفك: npm ci ثم npx prisma generate ثم npx prisma migrate deploy
