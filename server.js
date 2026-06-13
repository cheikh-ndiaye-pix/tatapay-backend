const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const crypto  = require('crypto');
const app     = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── VARIABLES D'ENVIRONNEMENT ──
const PAYTECH_API_KEY    = (process.env.PAYTECH_API_KEY    || '').trim();
const PAYTECH_API_SECRET = (process.env.PAYTECH_API_SECRET || '').trim();

// ── FIREBASE ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── ROUTE TEST ──
app.get('/', (req, res) => {
  res.json({ message: 'TataPay Backend is running!' });
});

// ── INIT PAIEMENT PAYTECH ──
app.post('/api/payment/init', async (req, res) => {
  const { amount, phone, method, type, uid } = req.body;

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Montant minimum 100 FCFA' });
  }
  if (!uid) {
    return res.status(400).json({ error: 'UID utilisateur manquant' });
  }

  const refCommand = 'TTP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // Sauvegarder le montant attendu côté serveur (anti-falsification)
  await db.collection('paytech_transactions').doc(refCommand).set({
    uid,
    amount,
    type,
    method,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const payload = {
    item_name:    type === 'recharge' ? 'Recharge TataPay' : 'Ticket TataPay',
    item_price:   amount,
    currency:     'XOF',
    ref_command:  refCommand,
    command_name: 'TataPay Paiement',
    env:          'prod',
    ipn_url:      'https://tatapay-backend-1.onrender.com/api/ipn',
    success_url:  'https://tatapay-a4972.web.app/success.html',
    cancel_url:   'https://tatapay-a4972.web.app/cancel.html',
    sender_phone:    phone || '',
    sender_country:  'SN',
    channel:      method || 'wave',
    custom_field: JSON.stringify({ uid, type, ref: refCommand })
  };

  try {
    const fetch = await import('node-fetch');
    const response = await fetch.default('https://paytech.sn/api/payment/request-payment', {
      method: 'POST',
      headers: {
        'API_KEY':       PAYTECH_API_KEY,
        'API_SECRET':    PAYTECH_API_SECRET,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();
    console.log('🔍 Statut PayTech:', response.status);
    console.log('🔍 Réponse PayTech:', rawText.slice(0, 500));

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: 'Réponse non-JSON de PayTech', raw: rawText.slice(0, 500) });
    }

    if (data.payment_url) {
      res.json({ payment_url: data.payment_url, ref_command: refCommand });
    } else {
      // Supprimer la transaction en attente si PayTech refuse
      await db.collection('paytech_transactions').doc(refCommand).delete();
      res.status(500).json({ error: data.message || 'Erreur PayTech', details: data });
    }

  } catch (error) {
    console.error('❌ Erreur init paiement:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── IPN PAYTECH (sécurisé) ──
app.post('/api/ipn', async (req, res) => {
  console.log('📩 IPN reçu:', JSON.stringify({
    type_event:   req.body.type_event,
    ref_command:  req.body.ref_command,
    item_price:   req.body.item_price
    // Ne pas logger sender_phone (PII)
  }));

  try {
    const {
      type_event,
      custom_field,
      item_price,
      ref_command,
      method,
      api_key_sha256,
      api_secret_sha256
    } = req.body;

    // ✅ VÉRIFICATION SIGNATURE PAYTECH
    const expectedKeyHash    = crypto.createHash('sha256').update(PAYTECH_API_KEY).digest('hex');
    const expectedSecretHash = crypto.createHash('sha256').update(PAYTECH_API_SECRET).digest('hex');

    if (api_key_sha256 !== expectedKeyHash || api_secret_sha256 !== expectedSecretHash) {
      console.error('❌ IPN non authentifié — signature invalide');
      return res.status(403).send('Forbidden');
    }

    // Ignorer les événements autres que sale_complete
    if (type_event !== 'sale_complete') {
      console.log('⏭️ Événement ignoré:', type_event);
      return res.status(200).send('OK');
    }

    // ✅ ANTI-DOUBLE CRÉDIT (via Firestore transaction atomique)
    const txRef = db.collection('paytech_transactions').doc(ref_command);

    await db.runTransaction(async (t) => {
      const txSnap = await t.get(txRef);

      if (!txSnap.exists) {
        console.error('❌ Transaction inconnue:', ref_command);
        return; // Ne pas créditer une transaction non initiée par nous
      }

      if (txSnap.data().status === 'credited') {
        console.log('⚠️ Déjà crédité:', ref_command);
        return;
      }

      const txData  = txSnap.data();
      const uid     = txData.uid;
      // ✅ Utiliser le montant stocké côté serveur (pas celui de custom_field)
      const amount  = txData.amount;

      if (!uid || !amount) {
        console.error('❌ uid ou amount manquant dans la transaction');
        return;
      }

      const userRef = db.collection('users').doc(uid);

      // Créditer le wallet
      t.update(userRef, {
        balance: admin.firestore.FieldValue.increment(amount)
      });

      // Historique
      const histRef = db.collection('users').doc(uid).collection('history').doc();
      t.set(histRef, {
        type:   'recharge',
        label:  `Recharge via ${method || txData.method || 'Mobile Money'} — ${ref_command}`,
        amount: amount,
        ref:    ref_command,
        ts:     admin.firestore.FieldValue.serverTimestamp()
      });

      // Marquer comme crédité
      t.update(txRef, {
        status:     'credited',
        method:     method || txData.method,
        creditedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Wallet crédité : ${uid} +${amount} FCFA via ${method}`);
    });

    res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Erreur IPN:', err);
    res.status(500).send('Erreur');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur TataPay démarré sur le port ${PORT}`);
});
