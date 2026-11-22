# P3 الخطوة 5: واجهة شيت التسعير

## اللي اتعمل
- **Route جديد** `GET /api/projects/[id]/estimation/versions/[snapshotId]` (`pricing.view`): بيرجّع snapshot كامل (inputs + result + verified) بشرط إنه تابع لشيت المشروع، وإلا 404.
- **Header**: رقم الشيت، الـ version، الـ status، العملة، ومتتبع المراحل الأربع.
- **أزرار**: Save Draft / Calculate / Approve / Reopen (بسبب إلزامي) / Templates / Quotation preview. بتظهر وتتعطّل بـ `transition()` نفسها اللي السيرفر بيستخدمها، وحسب الصلاحية. الشيت المعتمد read-only.
- **الأرقام**: الشيت المعتمد بيعرض أرقام الـ snapshot المعتمد من السيرفر، مش حساب من بيانات حية.
- **Items** قابل للتوسيع + تابات Materials / Manufacturing / Project Costs / Commercial Summary / Versions / Audit.
- **مصدر السعر** (Procurement / Scrap / Manual؛ Stock معطّل)، السطر المعدّل بيظهر جنبه القيمة الأصلية، وزر Restore.
- **Issues**: لوحة (error بيمنع Calculate وApprove، warning لا) + رسايل جنب الحقول.
- **Versions** مع verified، و"إيه اللي اتعتمد بالظبط"، والمقارنة. **Audit** على مستوى الحقل.
- **Templates**: تطبيق على item أو المشروع، وإدارة (إنشاء/تعديل/حذف).
- **Quotation preview**: معاينة فقط، مش عرض صادر.

## إصلاحات لقيتها
- تعديل السعر على سطر تلقائي كان بيرجع لسعر المصدر بعد الحفظ (السيرفر بيتجاهل رقم المتصفح لو الـ priceSource مش MANUAL). دلوقتي كتابة السعر بتحوّل السطر لـ Manual.
- الحساب الحي في المتصفح كان بيتجاهل الخصم والرسوم الأخرى والـ target وأساس التوزيع. دلوقتي نفس مدخلات السيرفر. حقول الخصم/الرسوم/الدفعة المقدمة/الضمان/المراحل اتضافت لتاب Commercial.

## ملفات
جديد: `sheet-view.ts` و`template-form.ts` (منطق صرف + tests)، و`ui/`: `api.ts` `sheet-parts.tsx` `items-table.tsx` `materials-table.tsx` `history-panels.tsx` `templates-ui.tsx` `quotation-preview.tsx`، وroute الـ snapshot، و`estimation-snapshot.service.test.ts`.
معدّل: `estimation-view.tsx` `fields.tsx` `active-project-estimation.tsx` `types.ts` `estimation.service.ts` (دالة `getSnapshot` فقط) `validators/estimation.ts` `estimation-routes.test.ts` وصفحتين `pricing/page.tsx` (تمرير `canApprove` و`canManageTemplates`). لا migration، لا تغيير في schema. ما اتلمسش `/api/pricing/*` ولا `pricing.service.ts`.

## ما اتجرّبش
- **مفيش DB ولا سيرفر شغال ولا متصفح.** الواجهة اتفحصت بـ `tsc` و`eslint` و`next build` (exit 0) وبـ tests للمنطق الصرف. ما اتعملش render حقيقي ولا HTTP request. مفيش component tests للـ React في الـ repo.
- الـ service test بـ prisma مزيّف: **مش اختبار DB**.
- الأخطاء المعروضة جنب الحقول هي من `calcEstimate().issues` وفحوصات الـ client؛ أخطاء الـ validator بتاع السيرفر بتظهر كرسالة عامة.
- في الـ audit بيظهر معرّف المستخدم مختصر (الـ API مش بيرجّع الاسم).
- في الـ snapshot dialog، الـ items اللي اتمسحت بعد الاعتماد بتظهر "no longer on the sheet" (الـ snapshot مفيهوش أسماء).

## Needs approval (معلّمة في الواجهة)
1. مصدر السعر الافتراضي Procurement.
2. Reopen يحتاج `pricing.approve` (ADMIN فقط حاليًا).
3. صيغة رقم الشيت `PS-<رقم المشروع>`.
4. إدارة القوالب تحتاج `pricing.edit`.
5. ترتيب التأمين والضريبة والخصم كما هو موثّق في `calcCommercial`.
6. زر Create Offer لسه بيبني من الشيت المحفوظ (يتغيّر في الخطوة 6).

## التطبيق
`patch -p1 < p3-step5.patch` من جذر الـ repo (جرّب `--dry-run` الأول).
