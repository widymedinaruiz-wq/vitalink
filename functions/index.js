const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

admin.initializeApp();
const db = getFirestore();

// Firestore is in eur3 (Europe multi-region) — europe-west1 keeps functions co-located.
setGlobalOptions({ region: 'europe-west1' });

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const revenueCatWebhookAuth = defineSecret('REVENUECAT_WEBHOOK_AUTH');
const revenueCatSecretApiKey = defineSecret('REVENUECAT_SECRET_API_KEY');

const DAILY_AI_CAP = 15;
const MODEL = 'claude-sonnet-5';
// Must match the entitlement identifier configured in the RevenueCat dashboard.
const REVENUECAT_ENTITLEMENT = 'vitalinks_pro';

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

/**
 * Throws if the calling user isn't an active VitaLinks Plus subscriber.
 * Reads the Cloud-Function-only-writable entitlement doc — never trusts client input.
 */
async function requirePlusEntitlement(uid) {
  const snap = await db.doc(`users/${uid}/private/billing`).get();
  const billing = snap.exists ? snap.data() : null;
  const isPlus =
    billing &&
    billing.plan === 'plus' &&
    billing.planExpiresAt &&
    billing.planExpiresAt.toMillis() > Date.now();
  if (!isPlus) {
    throw new HttpsError('permission-denied', 'VitaLinks Plus required for this feature.');
  }
}

/**
 * Atomically checks and increments today's AI usage counter for this user, capped at
 * DAILY_AI_CAP. A transaction is required (not FieldValue.increment) because this is
 * check-then-act, not a blind counter. The doc's expiresAt field is consumed by a
 * Firestore TTL policy (configured in the console) so old counters self-delete.
 */
async function checkAndIncrementDailyUsage(uid) {
  // Date is encoded into the document ID (not a further subcollection level) so this
  // stays a valid 4-segment document path alongside users/{uid}/private/billing —
  // "private" is a collection, so a path with an odd segment count resolves to a
  // collection reference, not a document, and Firestore rejects it outright.
  const usageRef = db.doc(`users/${uid}/private/aiUsage-${todayKey()}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const count = snap.exists ? snap.data().count || 0 : 0;
    if (count >= DAILY_AI_CAP) {
      throw new HttpsError('resource-exhausted', `Daily AI limit of ${DAILY_AI_CAP} reached.`);
    }
    const expiresAt = Timestamp.fromMillis(Date.now() + 3 * 24 * 60 * 60 * 1000);
    tx.set(usageRef, { count: count + 1, expiresAt }, { merge: true });
  });
}

async function callAnthropic(prompt, maxTokens, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    logger.error('Anthropic API error', { status: res.status, body: t.slice(0, 500) });
    throw new HttpsError('internal', 'Anthropic API error.');
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

// Mirrors the client's PLATE_TYPES scale hints (prototypes/foto-calorias/index.html and
// the production photo-capture flow) — kept as a fixed server-side whitelist, indexed by
// plate id, so the client can only select a known scale context rather than injecting
// arbitrary prompt text through this field.
const PLATE_SCALE_HINTS = {
  llano: 'plato llano estándar, diámetro aproximado 27cm',
  hondo: 'plato hondo/sopero, diámetro aproximado 22cm, con profundidad considerable',
  postre: 'plato de postre o ensalada, diámetro aproximado 19cm',
  bowl: 'tazón (bowl) profundo, diámetro aproximado 15cm',
  mug: 'taza o mug grande, volumen aproximado 350ml',
  tupper: 'recipiente tipo tupper/lonchera de tamaño estándar de mercado',
  artesanal: 'plato de forma o tamaño no estándar — hay un tenedor visible en la foto (largo típico 19-20cm); úsalo como referencia real de escala en vez de asumir un diámetro de plato',
};

/**
 * Server-side counterpart to the client's estimateNutrition() (index.html) — same
 * prompt/schema, so the parsed result shape is identical for Free (BYOK) and Plus
 * (proxied) users. Kept as a dedicated, server-constructed prompt (not a client-
 * supplied one) so this endpoint can't be repurposed for arbitrary Anthropic queries.
 */
exports.estimateNutritionPlus = onCall({ secrets: [anthropicApiKey] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const desc = ((request.data && request.data.desc) || '').trim();
  if (!desc) throw new HttpsError('invalid-argument', 'Missing food description.');

  await requirePlusEntitlement(uid);
  await checkAndIncrementDailyUsage(uid);

  const prompt = `Eres un nutricionista. Estima el contenido nutricional para el siguiente alimento, considerando la cantidad/porción indicada, usando valores nutricionales típicos (USDA u equivalente). Si la porción no se especifica, asume una porción individual estándar. Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:
{"calories": <entero kcal>, "protein": <entero g>, "carbs": <entero g>, "fat": <entero g>, "fiber": <entero g>, "sugar": <entero g>, "sodium": <entero mg>, "iron": <entero mg>, "calcium": <entero mg>, "potassium": <entero mg>, "vitaminC": <entero mg>, "note": "<nota breve en español, max 10 palabras>"}

Alimento: "${desc}"`;

  const text = await callAnthropic(prompt, 300, anthropicApiKey.value());
  const clean = text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new HttpsError('internal', 'Could not parse AI response.');
  }
  if (typeof parsed.calories !== 'number') {
    throw new HttpsError('internal', 'AI response missing calories.');
  }
  return parsed;
});

/**
 * Server-side counterpart to the client's estimateNutritionFromPhoto() — same
 * prompt/schema and per-item array response as the BYOK path, so Plus users get an
 * identical result shape without needing their own key. Images arrive pre-downscaled
 * by the client (~1024px, JPEG ~70%) but this still bounds payload size server-side,
 * since a client is not a trusted source for "already validated" input. The scale
 * context is a fixed whitelist lookup (PLATE_SCALE_HINTS), not client-supplied prompt
 * text, for the same reason estimateNutritionPlus builds its own prompt server-side.
 * Shares the same daily cap as text-based estimation/insights (checkAndIncrementDailyUsage)
 * rather than a separate counter — simpler to reason about, at the cost of a photo call
 * (more input tokens than a text call) counting the same as one text call toward it.
 */
exports.estimateNutritionFromPhotoPlus = onCall({ secrets: [anthropicApiKey] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const data = request.data || {};
  const images = Array.isArray(data.images) ? data.images : [];
  if (!images.length) throw new HttpsError('invalid-argument', 'Missing photo.');
  if (images.length > 3) throw new HttpsError('invalid-argument', 'Too many photos.');
  if (!images.every((b64) => typeof b64 === 'string' && b64.length > 0)) {
    throw new HttpsError('invalid-argument', 'Invalid photo data.');
  }
  const totalBytes = images.reduce((s, b64) => s + Buffer.byteLength(b64, 'base64'), 0);
  if (totalBytes > 6 * 1024 * 1024) throw new HttpsError('invalid-argument', 'Photo payload too large.');

  const plateHint = PLATE_SCALE_HINTS[data.plateType] || PLATE_SCALE_HINTS.llano;
  const note = String(data.note || '').trim().slice(0, 300);

  await requirePlusEntitlement(uid);
  await checkAndIncrementDailyUsage(uid);

  const prompt = `Eres un nutricionista analizando ${images.length > 1 ? 'fotos' : 'una foto'} de un plato de comida real, tomada${images.length > 1 ? 's' : ''} para estimar calorías.
Contexto de escala: ${plateHint}.
${note ? 'Nota del usuario: ' + note + '\n' : ''}
Identifica cada alimento visible por separado. Para cada uno, estima la porción (en gramos) usando el contexto de escala dado, y calcula su contenido nutricional usando valores típicos (USDA o equivalente). Considera la altura/volumen aparente de cada alimento en la imagen, no solo el área que ocupa en el plato.

Responde ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, sin backticks:
[{"name":"<nombre en español>","gramos":<entero>,"calories":<entero kcal>,"protein":<entero g>,"carbs":<entero g>,"fat":<entero g>}]`;

  const content = [
    ...images.map((b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
    { type: 'text', text: prompt },
  ];

  const text = await callAnthropic(content, 1024, anthropicApiKey.value());
  const clean = text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new HttpsError('internal', 'Could not parse AI response.');
  }
  if (!Array.isArray(parsed)) {
    throw new HttpsError('internal', 'AI response was not an item list.');
  }
  return { items: parsed };
});

/**
 * Server-side proxy for generateDailyInsight() (index.html). Unlike the nutrition
 * estimator, the daily-insight prompt is built entirely from the user's own local
 * health context (calories, water, exercise, BP, med adherence, weight trend —
 * see generateDailyInsight() client-side) and reconstructing that server-side would
 * mean duplicating a large slice of client logic and pulling private health data
 * into a new server code path for no real benefit. The client still builds the
 * finished prompt text locally; this function only supplies the Plus-tier "no
 * personal key needed" quota-gated forwarding to Anthropic. The 15/day cap plus the
 * requirement of an active paid subscription bounds the (low-severity) risk of this
 * being used as a general-purpose prompt relay.
 */
exports.generateDailyInsightPlus = onCall({ secrets: [anthropicApiKey] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const prompt = ((request.data && request.data.prompt) || '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Missing prompt.');

  await requirePlusEntitlement(uid);
  await checkAndIncrementDailyUsage(uid);

  const text = await callAnthropic(prompt, 100, anthropicApiKey.value());
  return { text: text.trim() };
});

/**
 * Fetches the authoritative current entitlement state from RevenueCat's REST API
 * rather than trusting webhook payload fields directly — webhook events can arrive
 * out of order (e.g. a CANCELLATION racing a RENEWAL).
 */
async function fetchRevenueCatEntitlement(appUserId, secretKey) {
  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  if (!res.ok) {
    const t = await res.text();
    logger.error('RevenueCat subscriber fetch failed', { status: res.status, body: t.slice(0, 500) });
    throw new Error('RevenueCat subscriber fetch failed');
  }
  const data = await res.json();
  const entitlement = data.subscriber && data.subscriber.entitlements && data.subscriber.entitlements[REVENUECAT_ENTITLEMENT];
  const expiresDate = entitlement && entitlement.expires_date; // null means non-expiring / active
  const isActive = !!entitlement && (expiresDate === null || new Date(expiresDate).getTime() > Date.now());
  return {
    plan: isActive ? 'plus' : 'free',
    planExpiresAt: expiresDate ? Timestamp.fromDate(new Date(expiresDate)) : null,
  };
}

/**
 * RevenueCat webhook receiver. onRequest (not onCall) because RevenueCat can't do
 * Firebase callable's client-auth-token wrapping — this endpoint authenticates the
 * caller via a static Authorization header configured in the RevenueCat dashboard
 * instead. Assumes the client configures Purchases with the Firebase Auth UID as
 * RevenueCat's app_user_id (Purchases.configure({ appUserID: firebaseUid })), so no
 * separate id-mapping table is needed.
 */
/**
 * Self-service account deletion. Deletes the Firestore data subtree, the user's own
 * feedback/error reports (a separate top-level collection, not under users/{uid}, but
 * still carries uid+email per submitFeedback in index.html), then the Auth user itself.
 * Firestore first, Auth last: recursiveDelete is idempotent, so a retry after a partial
 * failure is safe, whereas deleting the Auth user first would strand orphaned data this
 * function could no longer be called (as that uid) to clean up.
 */
exports.deleteAccount = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  try {
    await db.recursiveDelete(db.doc(`users/${uid}`));

    const feedbackSnap = await db.collection('feedback').where('uid', '==', uid).get();
    if (!feedbackSnap.empty) {
      const batch = db.batch();
      feedbackSnap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    await getAuth().deleteUser(uid);
    return { success: true };
  } catch (e) {
    logger.error('deleteAccount failed', { uid, error: String(e) });
    throw new HttpsError('internal', 'Account deletion failed.');
  }
});

exports.revenueCatWebhook = onRequest(
  // RevenueCat's servers can't present a Google-issued IAM token, so this endpoint
  // must be publicly invokable — the Authorization-header check below is the real
  // security gate, not Cloud Run's own IAM layer.
  { secrets: [revenueCatWebhookAuth, revenueCatSecretApiKey], invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }
    // .trim() both sides — secrets and header values are easy to pick up stray
    // trailing whitespace from a shell pipe or a copy-paste into a dashboard field.
    if ((req.headers.authorization || '').trim() !== revenueCatWebhookAuth.value().trim()) {
      logger.warn('RevenueCat webhook: bad Authorization header');
      res.status(401).send('Unauthorized');
      return;
    }

    const event = req.body && req.body.event;
    if (!event || !event.app_user_id || !event.id) {
      res.status(400).send('Malformed event');
      return;
    }
    const uid = event.app_user_id;
    const billingRef = db.doc(`users/${uid}/private/billing`);

    try {
      // Idempotency: RevenueCat can redeliver the same event.
      const existing = await billingRef.get();
      if (existing.exists && existing.data().lastEventId === event.id) {
        res.status(200).send('Already processed');
        return;
      }

      const entitlement = await fetchRevenueCatEntitlement(uid, revenueCatSecretApiKey.value());
      await billingRef.set(
        {
          plan: entitlement.plan,
          planExpiresAt: entitlement.planExpiresAt,
          lastEventId: event.id,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      logger.info('RevenueCat webhook processed', { uid, eventType: event.type, plan: entitlement.plan });
      res.status(200).send('OK');
    } catch (e) {
      logger.error('RevenueCat webhook processing failed', { uid, error: String(e) });
      res.status(500).send('Internal error');
    }
  }
);

/**
 * Feedback triage, Layer 1 (see project memory project_feedback_triage.md for the
 * broader design — this is deliberately just the per-document classification step,
 * not the cross-tester clustering/digest layer, which is a separate follow-up).
 *
 * Fires on every new feedback/{docId} write (both user-typed 'feedback' and
 * auto-captured 'error' reports share this collection) and writes a structured
 * classification back onto the same document: category, a 1-5 priority, whether
 * it's actionable noise, and whether it looks like a churn risk. This only ever
 * ADDS fields via .update() and never rewrites existing ones, and onDocumentCreated
 * doesn't refire on updates, so this can't loop on itself.
 *
 * Deliberately does not throw on failure (logs and returns instead) — an
 * unclassified doc just sits without these fields for manual review; retrying
 * indefinitely on a bad Claude response would be worse than that.
 */
exports.classifyFeedback = onDocumentCreated(
  { document: 'feedback/{docId}', secrets: [anthropicApiKey] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    const message = String(data.message || '').trim();
    if (!message) return;

    const context = [
      `Tipo: ${data.type === 'error' ? 'error automático capturado por la app' : 'feedback escrito por el usuario'}`,
      `Mensaje: "${message.slice(0, 1000)}"`,
      data.stack ? `Stack trace: ${String(data.stack).slice(0, 500)}` : null,
      `Pestaña: ${data.tab || 'desconocida'}, plataforma: ${data.platform || 'desconocida'}, versión: ${data.appVersion || 'desconocida'}`,
    ].filter(Boolean).join('\n');

    const prompt = `Eres un clasificador de feedback para VitaLinks, una app de salud personal (nutrición, ejercicio, presión arterial, sueño, medicamentos). Analiza el siguiente reporte de un usuario o error capturado automáticamente.

${context}

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:
{"category":"<bug|ux-friction|feature-request|praise|noise>","priority":<entero 1-5, 5 es más urgente>,"isNoise":<true o false>,"churnRisk":<true o false>,"summary":"<resumen de una frase en español, máximo 15 palabras>"}

Guía: "noise" es feedback sin contenido accionable (agradecimientos genéricos, pruebas del propio desarrollador, mensajes vacíos o irrelevantes) — en ese caso priority debe ser 1. "churnRisk" es true solo si el problema podría hacer que un usuario abandone la app (bloquea una función central, pérdida de datos, confusión grave que impide usarla), no una molestia cosmética menor.`;

    let parsed;
    try {
      const text = await callAnthropic(prompt, 250, anthropicApiKey.value());
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      logger.error('classifyFeedback: Claude call or parse failed', { docId: event.params.docId, error: String(e) });
      return;
    }

    const validCategories = ['bug', 'ux-friction', 'feature-request', 'praise', 'noise'];
    const category = validCategories.includes(parsed.category) ? parsed.category : 'unclassified';
    const priority = Number.isInteger(parsed.priority) ? Math.max(1, Math.min(5, parsed.priority)) : null;

    try {
      await snap.ref.update({
        category,
        priority,
        isNoise: !!parsed.isNoise,
        churnRisk: !!parsed.churnRisk,
        classificationSummary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : null,
        classifiedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.error('classifyFeedback: Firestore update failed', { docId: event.params.docId, error: String(e) });
    }
  }
);

/**
 * Feedback triage, Layer 2 (see project memory project_feedback_triage.md).
 *
 * Layer 1 (classifyFeedback) scores individual documents; that alone can't answer
 * "where should I focus to reduce churn" because that signal usually lives in the
 * same friction being reported by several *different* testers, not any one report's
 * severity. This reads the last FEEDBACK_DIGEST_PERIOD_DAYS of non-noise feedback,
 * asks Claude to cluster reports that describe the same underlying issue (even if
 * worded differently) across distinct users, and ranks the clusters by a mix of
 * how many distinct testers hit it, severity, and churn risk — then stores the
 * result in feedbackDigests/{digestId} for review.
 *
 * Split into a plain async function (runFeedbackDigest) called by the weekly
 * schedule below, so it can also be triggered manually from the Cloud Scheduler
 * console ("Run now" on the feedbackDigestWeekly job) without needing a separate
 * admin-gated callable endpoint just for testing.
 */
const FEEDBACK_DIGEST_PERIOD_DAYS = 7;

async function runFeedbackDigest() {
  const periodStart = Timestamp.fromMillis(Date.now() - FEEDBACK_DIGEST_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const periodEnd = Timestamp.now();
  const snap = await db.collection('feedback').where('createdAt', '>=', periodStart).get();

  const items = [];
  snap.forEach((doc) => {
    const d = doc.data();
    if (d.isNoise === true) return;
    items.push({
      id: doc.id,
      uid: d.uid || 'unknown',
      category: d.category || 'unclassified',
      priority: typeof d.priority === 'number' ? d.priority : null,
      churnRisk: !!d.churnRisk,
      message: String(d.message || '').slice(0, 300),
    });
  });

  if (!items.length) {
    await db.collection('feedbackDigests').add({
      periodStart,
      periodEnd,
      generatedAt: FieldValue.serverTimestamp(),
      totalReports: 0,
      noiseCount: snap.size,
      headline: 'Sin feedback accionable en este período.',
      issues: [],
    });
    return;
  }

  const itemsText = items
    .map((it, i) => `[${i}] usuario=${it.uid.slice(0, 8)} categoria=${it.category} prioridad=${it.priority ?? '?'} churnRisk=${it.churnRisk} mensaje="${it.message}"`)
    .join('\n');

  const prompt = `Eres un analista de producto revisando feedback de testers de VitaLinks, una app de salud personal (nutrición, ejercicio, presión arterial, sueño, medicamentos). A continuación hay ${items.length} reportes recientes, ya filtrados de ruido (cada uno ya tiene una categoría y prioridad asignadas individualmente). Tu trabajo es encontrar patrones que un análisis reporte-por-reporte no vería: agrupa los reportes que describen el mismo problema de fondo aunque estén redactados distinto, y para cada grupo cuenta cuántos usuarios DISTINTOS lo reportaron (no cuántos reportes — si el mismo usuario lo repite, cuenta 1).

Reportes:
${itemsText}

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:
{"headline":"<una frase en español indicando en qué vale más la pena enfocarse ahora>","issues":[{"title":"<título corto en español>","affectedUsers":<entero>,"maxPriority":<entero 1-5>,"churnRisk":<true|false>,"category":"<bug|ux-friction|feature-request|otro>","itemIndexes":[<índices de los reportes agrupados en este issue>]}]}

Ordena "issues" de mayor a menor urgencia real, combinando cuántos usuarios distintos afectados, la prioridad máxima del grupo, y si representa riesgo real de abandono — no solo por prioridad individual.`;

  let headline = null;
  let issues = [];
  try {
    const text = await callAnthropic(prompt, 2000, anthropicApiKey.value());
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    headline = typeof parsed.headline === 'string' ? parsed.headline.slice(0, 300) : null;
    if (Array.isArray(parsed.issues)) {
      issues = parsed.issues.map((issue) => ({
        title: typeof issue.title === 'string' ? issue.title.slice(0, 200) : 'Sin título',
        affectedUsers: Number.isInteger(issue.affectedUsers) ? issue.affectedUsers : null,
        maxPriority: Number.isInteger(issue.maxPriority) ? Math.max(1, Math.min(5, issue.maxPriority)) : null,
        churnRisk: !!issue.churnRisk,
        category: typeof issue.category === 'string' ? issue.category : 'unclassified',
        docIds: Array.isArray(issue.itemIndexes)
          ? issue.itemIndexes.map((i) => items[i] && items[i].id).filter(Boolean)
          : [],
      }));
    }
  } catch (e) {
    logger.error('feedbackDigest: Claude clustering failed', { error: String(e) });
    headline = 'No se pudo generar el análisis esta vez — revisar feedback manualmente.';
  }

  await db.collection('feedbackDigests').add({
    periodStart,
    periodEnd,
    generatedAt: FieldValue.serverTimestamp(),
    totalReports: items.length,
    noiseCount: snap.size - items.length,
    headline,
    issues,
  });
}

exports.feedbackDigestWeekly = onSchedule(
  { schedule: 'every monday 09:00', timeZone: 'Europe/Madrid', secrets: [anthropicApiKey] },
  async () => {
    await runFeedbackDigest();
  }
);
