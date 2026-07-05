const express   = require('express');
const cors      = require('cors');
const admin     = require('firebase-admin');
const crypto    = require('crypto');
const https     = require('https');
const rateLimit = require('express-rate-limit');
const app       = express();

// ── CORS SÉCURISÉ ──
const allowedOrigins = [
  'https://tatapay-a4972.web.app',
  'https://tatapay-a4972.firebaseapp.com',
  'https://steady-eclair-770c6e.netlify.app',
  'https://moonlit-biscochitos-65169b.netlify.app',
  'https://serene-croissant-6cebc0.netlify.app',
  'https://endearing-sorbet-5fbf83.netlify.app',
  'https://lit-biscochitos-65169b.netlify.app',
  'http://localhost:8081',
  'http://localhost:19006',
  'exp://192.168.1.91:8081'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith('exp://')) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS non autorisé : ' + origin));
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── VARIABLES D'ENVIRONNEMENT ──
const PAYTECH_API_KEY    = (process.env.PAYTECH_API_KEY    || '').trim();
const PAYTECH_API_SECRET = (process.env.PAYTECH_API_SECRET || '').trim();
const PAYTECH_ENV        = (process.env.PAYTECH_ENV || 'test').trim();
const OFFLINE_SECRET     = (process.env.OFFLINE_SECRET || 'tatapay-offline-secret-2026').trim();

// ── FIREBASE ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── RATE LIMITING ──
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' }
});
const ipnLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: { error: 'Trop de requêtes IPN' }
});

// ── MIDDLEWARE : VÉRIFICATION TOKEN FIREBASE ──
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autorisé — token manquant' });
  }
  const token = authHeader.replace('Bearer ', '').trim();
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    console.error('❌ Token invalide:', e.message);
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};

// ── VALIDATION MONTANT ──
const validateAmount = (amount) => {
  const amt = parseInt(amount);
  if (!amt || !Number.isInteger(amt)) return false;
  if (amt < 100) return false;
  if (amt > 500000) return false;
  return amt;
};

// ── ROUTE TEST ──
app.get('/', (req, res) => {
  res.json({ message: 'TataPay Backend is running!', paytech_env: PAYTECH_ENV });
});

// ── KEEP-ALIVE PING ──
app.get('/ping', (req, res) => res.json({ status: 'alive', time: new Date() }));

// ── INIT PAIEMENT PAYTECH ──
app.post('/api/payment/init', verifyToken, limiter, async (req, res) => {
  const { amount, phone, method, type, meta } = req.body;
  const uid = req.uid;

  const amt = validateAmount(amount);
  if (!amt) {
    return res.status(400).json({ error: 'Montant invalide (min 100, max 500 000 FCFA)' });
  }

  const allowedTypes = ['recharge', 'ticket', 'retrait'];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'Type de paiement invalide' });
  }

  const refCommand = 'TTP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  await db.collection('paytech_transactions').doc(refCommand).set({
    uid, amount: amt, type, method: method || 'wave',
    meta: meta || null, status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const itemNames = { recharge: 'Recharge TataPay', ticket: 'Ticket TataPay', retrait: 'Retrait TataPay' };

  const payload = {
    item_name:      itemNames[type] || 'TataPay',
    item_price:     amt,
    currency:       'XOF',
    ref_command:    refCommand,
    command_name:   'TataPay Paiement',
    env:            PAYTECH_ENV,
    ipn_url:        'https://tatapay-backend-1.onrender.com/api/ipn',
    success_url:    'https://tatapay-a4972.web.app/success.html',
    cancel_url:     'https://tatapay-a4972.web.app/cancel.html',
    sender_phone:   phone || '',
    sender_country: 'SN',
    channel:        method || 'wave',
    custom_field:   JSON.stringify({ uid, type, ref: refCommand })
  };

  try {
    const fetch = await import('node-fetch');
    const response = await fetch.default('https://paytech.sn/api/payment/request-payment', {
      method: 'POST',
      headers: {
        'API_KEY':      PAYTECH_API_KEY,
        'API_SECRET':   PAYTECH_API_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();
    console.log('🔍 Statut PayTech:', response.status, '| env:', PAYTECH_ENV);
    console.log('🔍 Réponse PayTech:', rawText.slice(0, 500));

    let data;
    try { data = JSON.parse(rawText); }
    catch (e) { return res.status(502).json({ error: 'Réponse non-JSON de PayTech', raw: rawText.slice(0, 500) }); }

    if (data.payment_url || data.redirect_url) {
      const url = data.payment_url || data.redirect_url;
      res.json({ payment_url: url, redirect_url: url, ref_command: refCommand });
    } else {
      await db.collection('paytech_transactions').doc(refCommand).delete();
      res.status(500).json({ error: data.message || 'Erreur PayTech', details: data });
    }
  } catch (error) {
    console.error('❌ Erreur init paiement:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── IPN PAYTECH ──
app.post('/api/ipn', ipnLimiter, async (req, res) => {
  console.log('📩 IPN reçu:', JSON.stringify({
    type_event: req.body.type_event, ref_command: req.body.ref_command, item_price: req.body.item_price
  }));

  try {
    const { type_event, ref_command, method, api_key_sha256, api_secret_sha256 } = req.body;

    const expectedKeyHash    = crypto.createHash('sha256').update(PAYTECH_API_KEY).digest('hex');
    const expectedSecretHash = crypto.createHash('sha256').update(PAYTECH_API_SECRET).digest('hex');

    if (api_key_sha256 !== expectedKeyHash || api_secret_sha256 !== expectedSecretHash) {
      console.error('❌ IPN non authentifié — signature invalide');
      return res.status(403).send('Forbidden');
    }

    if (type_event !== 'sale_complete') {
      console.log('⏭️ Événement ignoré:', type_event);
      return res.status(200).send('OK');
    }

    const txRef = db.collection('paytech_transactions').doc(ref_command);

    await db.runTransaction(async (t) => {
      const txSnap = await t.get(txRef);
      if (!txSnap.exists) { console.error('❌ Transaction inconnue:', ref_command); return; }
      if (txSnap.data().status === 'credited') { console.log('⚠️ Déjà crédité:', ref_command); return; }

      const txData = txSnap.data();
      const { uid, amount, type, meta } = txData;
      if (!uid || !amount) { console.error('❌ uid ou amount manquant'); return; }

      const userRef     = db.collection('users').doc(uid);
      const histRef     = db.collection('users').doc(uid).collection('history').doc();
      const finalMethod = method || txData.method || 'Mobile Money';

      if (type === 'recharge') {
        t.update(userRef, { balance: admin.firestore.FieldValue.increment(amount) });
        t.set(histRef, { type: 'recharge', label: `Recharge via ${finalMethod} — ${ref_command}`, amount, ref: ref_command, ts: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`✅ Recharge : ${uid} +${amount} FCFA`);
      } else if (type === 'ticket' && meta) {
        const pendingRef = db.collection('pending').doc();
        t.set(pendingRef, { busUid: meta.busUid, busId: meta.busId, passengerUid: uid, passengerId: meta.passengerId, passengerName: meta.passengerName, from: meta.from, to: meta.to, section: meta.section, price: amount, method: finalMethod, gie: meta.gie, vehicle: meta.vehicle, ligne: meta.ligne, zone: meta.zone, ref: ref_command, paidAt: admin.firestore.FieldValue.serverTimestamp(), status: 'pending' });
        t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });
        t.set(histRef, { type: 'ticket', label: `Ticket ${meta.gie}/${meta.vehicle} → ${meta.to}`, amount: -amount, ref: ref_command, ts: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`✅ Ticket : ${uid} -${amount} FCFA → receveur ${meta.busUid}`);
      } else if (type === 'retrait') {
        t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });
        t.set(histRef, { type: 'withdraw', label: `Retrait via ${finalMethod} — ${ref_command}`, amount: -amount, ref: ref_command, ts: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`✅ Retrait : ${uid} -${amount} FCFA`);
      }

      t.update(txRef, { status: 'credited', method: finalMethod, creditedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Erreur IPN:', err);
    res.status(500).send('Erreur');
  }
});

// ── GÉNÉRER QR SIGNÉ HORS-LIGNE ──
app.post('/api/offline/qr', verifyToken, limiter, async (req, res) => {
  const uid = req.uid;
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const userData = userSnap.data();
    const payload = { uid, walletId: userData.walletId, name: userData.name, balance: userData.balance || 0, issuedAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    const signature = crypto.createHmac('sha256', OFFLINE_SECRET).update(JSON.stringify(payload)).digest('hex');

    console.log(`✅ QR offline : ${uid} | solde: ${payload.balance} FCFA`);
    res.json({ payload, signature });
  } catch (err) {
    console.error('❌ Erreur QR offline:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── VÉRIFIER QR HORS-LIGNE ──
app.post('/api/offline/verify', async (req, res) => {
  const { payload, signature } = req.body;
  if (!payload || !signature) return res.status(400).json({ error: 'Données manquantes' });

  try {
    const expectedSig = crypto.createHmac('sha256', OFFLINE_SECRET).update(JSON.stringify(payload)).digest('hex');
    const valid = expectedSig === signature;
    const expired = Date.now() > payload.expiresAt;
    res.json({ valid, expired, maxOffline: 1000 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SYNC TRANSACTIONS HORS-LIGNE ──
app.post('/api/offline/sync', verifyToken, limiter, async (req, res) => {
  const { transactions } = req.body;
  if (!transactions || !Array.isArray(transactions)) return res.status(400).json({ error: 'Tableau de transactions manquant' });

  const results = [];

  for (const tx of transactions) {
    const { payload, signature, price, receiverUid, syncRef } = tx;
    try {
      const expectedSig = crypto.createHmac('sha256', OFFLINE_SECRET).update(JSON.stringify(payload)).digest('hex');
      if (expectedSig !== signature) { results.push({ syncRef, status: 'rejected', reason: 'Signature invalide' }); continue; }
      if (Date.now() > payload.expiresAt + 24 * 60 * 60 * 1000) { results.push({ syncRef, status: 'rejected', reason: 'QR expiré' }); continue; }
      if (price > 1000) { results.push({ syncRef, status: 'rejected', reason: 'Dépasse limite 1000 FCFA' }); continue; }

      const existingSnap = await db.collection('offline_transactions').doc(syncRef).get();
      if (existingSnap.exists) { results.push({ syncRef, status: 'already_synced' }); continue; }

      const passengerRef  = db.collection('users').doc(payload.uid);
      const passengerSnap = await passengerRef.get();
      if (!passengerSnap.exists || (passengerSnap.data().balance || 0) < price) { results.push({ syncRef, status: 'rejected', reason: 'Solde insuffisant' }); continue; }

      const receiverRef = db.collection('users').doc(receiverUid);
      const passHistRef = db.collection('users').doc(payload.uid).collection('history').doc();
      const recvHistRef = db.collection('users').doc(receiverUid).collection('history').doc();

      await db.runTransaction(async (t) => {
        t.update(passengerRef, { balance: admin.firestore.FieldValue.increment(-price) });
        t.set(passHistRef, { type: 'ticket_offline', label: `Ticket hors-ligne — ${syncRef}`, amount: -price, ref: syncRef, ts: admin.firestore.FieldValue.serverTimestamp() });
        t.update(receiverRef, { balance: admin.firestore.FieldValue.increment(price) });
        t.set(recvHistRef, { type: 'collect_offline', label: `Collecte hors-ligne — ${syncRef}`, amount: price, ref: syncRef, ts: admin.firestore.FieldValue.serverTimestamp() });
        t.set(db.collection('offline_transactions').doc(syncRef), { passengerUid: payload.uid, receiverUid, price, syncRef, syncedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'synced' });
      });

      results.push({ syncRef, status: 'synced' });
      console.log(`✅ Sync offline : ${payload.uid} -${price} FCFA → ${receiverUid}`);
    } catch (err) {
      console.error(`❌ Erreur sync ${syncRef}:`, err.message);
      results.push({ syncRef, status: 'error', reason: err.message });
    }
  }

  const synced   = results.filter(r => r.status === 'synced').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  console.log(`📊 Sync : ${synced} acceptées, ${rejected} rejetées`);
  res.json({ results, synced, rejected });
});

// ── DÉMARRAGE SERVEUR ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ TataPay Backend démarré — port ${PORT} | env: ${PAYTECH_ENV}`);
  console.log('🔒 Sécurité : CORS ✓ | Rate Limit ✓ | Token Firebase ✓ | Validation montant ✓');
  setInterval(() => {
    https.get('https://tatapay-backend-1.onrender.com/ping', () => {}).on('error', () => {});
  }, 9 * 60 * 1000);
  console.log('🔁 Keep-alive activé — ping toutes les 9 minutes');
});
