# P3 الخطوة 6: عرض السعر من الـ snapshot المعتمد

## اللي اتعمل
- `createOffer` اتنقلت لـ `src/server/services/estimation-offer.service.ts` وبقت تبني **من أحدث snapshot بحالة APPROVED** مش من الشيت المحفوظ، حتى لو الشيت بقى DRAFT بعد إعادة فتح.
- يترفض (409) لو مفيش اعتماد، أو الـ snapshot مش verified (إعادة الحساب من الـ inputs ما بتساوي الـ result المخزّن).
- السلوك القديم متحافظ عليه: quotation بحالة DRAFT، أول عرض برقم جديد، وبعده revision جديد لنفس الرقم، ومفيش كتابة فوق revision قديم.
- **اختيار الشكل**: `LUMP_SUM` (سطر واحد) أو `PER_ITEM` (سطر لكل item بنصيبه من السعر النهائي، مع سطر "Shared / project level" لو فيه حاجة مش تابعة لـ item). المجموع لازم يساوي السعر النهائي للسنت، وإلا الطلب يترفض (422) ومفيش تقريب. لو اسم item مش موجود على الشيت الحالي، PER_ITEM يترفض بدل ما يخترع اسم.
- العرض بيسجّل مصدره: أعمدة جديدة على `estimate_offers`: `snapshotId` و`snapshotVersion` و`layout` (كلها nullable)، والـ audit بيتكتب `action=OFFER` جوّا نفس الـ transaction.
- Route: `POST /api/projects/[id]/estimation/offer` body اختياري `{ layout? }` (الصلاحيات زي ما كانت: `pricing.edit` و`quotations.edit`). body فاضي = الافتراضي. layout غلط = 400.
- الواجهة: زر Create Offer بيفتح dialog فيه أحدث snapshot معتمد وverified والاختيار بين الشكلين، وتحذير لو الشيت اتفتح بعد الاعتماد. قايمة العروض بتعرض "from vN" والشكل.
- Migration: `20261121090000_estimate_offer_snapshot_link` (additive وidempotent، `ADD COLUMN IF NOT EXISTS`، مفيش حذف أو تعديل).

## سيناريوهات القبول (P3)
اللي اتغطى بـ tests على منطق صرف (`p3-acceptance.test.ts`): 3 عمليات مختلفة لكل item، 4 عملية مخصصة، 5 مقاول، 6 تكاليف مشروع، 7 السعر التجاري النهائي، 9 الـ versioning (الـ snapshot المعتمد ما بيتغيّرش والعرض بيتسعّر منه)، وجانب المنطق من 2 (السعر المكتوب بيتحفظ Manual والقيم الأصلية معروفة للاسترجاع).
**ما اتأكدش (محتاج DB وسيرفر شغال)**: 1 المواد التلقائية من Part List/Nesting، 2 إن Part List ما اتلمسش، 8 الحفظ بعد reload، 10 إن الموديولات الحالية (Part List, Nesting, Scrap, Procurement, Stock, Planning, Quotations) ما اتأثرتش. الأخيرة اتغطت بس إن الـ tests الموجودة كلها لسه ناجحة.

## ما اتجرّبش
- مفيش DB ولا سيرفر ولا متصفح. الـ service test بـ prisma مزيّف: **مش اختبار DB** (الـ transaction والـ constraints والـ migration ما اتشغّلوش). `prisma validate` ما اشتغلش (محتاج تحميل engine والشبكة بتمنعه)، لكن `prisma generate` نجح.
- ما فيش unique constraint مضمون على (رقم، revision): حساب الـ revision جوّا الـ transaction زي ما كان، فطلبين متزامنين جدًا ممكن يتعارضوا. ما اتعالجش هنا.
- صفحة طباعة العرض `/print/.../estimate-quotation` وزر Download Quotation لسه بيبنوا من الشيت المحفوظ (مش الـ snapshot). ما اتغيّروش.

## Needs approval
1. **الشكل الافتراضي lump sum** (معلّم في الـ dialog).
2. الشروط (الدفع، التسليم، الاستثناءات، الملاحظات) بتتنسخ من الشيت الحالي لأن الـ snapshot بيخزّن الأرقام مش الشروط. لو الشيت اتفتح بعد الاعتماد، الـ dialog بيحذّر والـ response فيه `termsFromCurrentSheet`.
3. أي شيت أُعيد فتحه يقدر يطلّع عرض من آخر اعتماد (مش بس الشيت المعتمد حاليًا).

## التطبيق
فوق الخطوة 5: `patch -p1 < p3-step6.patch` (جرّب `--dry-run`)، وبعدها `prisma migrate deploy` و`prisma generate`.
