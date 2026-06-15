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
  const { amount, phone, method, type, uid, meta } = req.body;

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Montant minimum 100 FCFA' });
  }
  if (!uid) {
    return res.status(400).json({ error: 'UID utilisateur manquant' });
  }

  const refCommand = 'TTP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // Sauvegarder côté serveur (anti-falsification)
  await db.collection('paytech_transactions').doc(refCommand).set({
    uid,
    amount,
    type:      type || 'recharge',
    method:    method || 'wave',
    meta:      meta || null,   // ← infos ticket (busUid, from, to, etc.)
    status:    'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const itemNames = {
    recharge: 'Recharge TataPay',
    ticket:   'Ticket TataPay',
    retrait:  'Retrait TataPay'
  };

  const payload = {
    item_name:    itemNames[type] || 'TataPay',
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
        'API_KEY':      PAYTECH_API_KEY,
        'API_SECRET':   PAYTECH_API_SECRET,
        'Content-Type': 'application/json'
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
    type_event:  req.body.type_event,
    ref_command: req.body.ref_command,
    item_price:  req.body.item_price
  }));

  try {
    const {
      type_event,
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

    if (type_event !== 'sale_complete') {
      console.log('⏭️ Événement ignoré:', type_event);
      return res.status(200).send('OK');
    }

    // ✅ ANTI-DOUBLE CRÉDIT (transaction atomique)
    const txRef = db.collection('paytech_transactions').doc(ref_command);

    await db.runTransaction(async (t) => {
      const txSnap = await t.get(txRef);

      if (!txSnap.exists) {
        console.error('❌ Transaction inconnue:', ref_command);
        return;
      }
      if (txSnap.data().status === 'credited') {
        console.log('⚠️ Déjà crédité:', ref_command);
        return;
      }

      const txData = txSnap.data();
      const { uid, amount, type, meta } = txData;

      if (!uid || !amount) {
        console.error('❌ uid ou amount manquant');
        return;
      }

      const userRef  = db.collection('users').doc(uid);
      const histRef  = db.collection('users').doc(uid).collection('history').doc();
      const finalMethod = method || txData.method || 'Mobile Money';

      // ── CAS 1 : RECHARGE PASSAGER ──
      if (type === 'recharge') {
        t.update(userRef, {
          balance: admin.firestore.FieldValue.increment(amount)
        });
        t.set(histRef, {
          type:   'recharge',
          label:  `Recharge via ${finalMethod} — ${ref_command}`,
          amount,
          ref:    ref_command,
          ts:     admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Recharge : ${uid} +${amount} FCFA`);
      }

      // ── CAS 2 : TICKET ──
      else if (type === 'ticket' && meta) {
        // Créer la demande pending pour le receveur
        const pendingRef = db.collection('pending').doc();
        t.set(pendingRef, {
          busUid:        meta.busUid,
          busId:         meta.busId,
          passengerUid:  uid,
          passengerId:   meta.passengerId,
          passengerName: meta.passengerName,
          from:          meta.from,
          to:            meta.to,
          section:       meta.section,
          price:         amount,
          method:        finalMethod,
          gie:           meta.gie,
          vehicle:       meta.vehicle,
          ligne:         meta.ligne,
          zone:          meta.zone,
          ref:           ref_command,
          paidAt:        admin.firestore.FieldValue.serverTimestamp(),
          status:        'pending'
        });
        // Débiter le passager
        t.update(userRef, {
          balance: admin.firestore.FieldValue.increment(-amount)
        });
        t.set(histRef, {
          type:   'ticket',
          label:  `Ticket ${meta.gie}/${meta.vehicle} → ${meta.to}`,
          amount: -amount,
          ref:    ref_command,
          ts:     admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Ticket créé : ${uid} -${amount} FCFA → pending receveur ${meta.busUid}`);
      }

      // ── CAS 3 : RETRAIT RECEVEUR ──
      else if (type === 'retrait') {
        // Le virement mobile est géré par PayTech
        // On débite juste le wallet (déjà vérifié côté front avant init)
        t.update(userRef, {
          balance: admin.firestore.FieldValue.increment(-amount)
        });
        t.set(histRef, {
          type:   'withdraw',
          label:  `Retrait via ${finalMethod} — ${ref_command}`,
          amount: -amount,
          ref:    ref_command,
          ts:     admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Retrait : ${uid} -${amount} FCFA`);
      }

      // Marquer comme crédité
      t.update(txRef, {
        status:     'credited',
        method:     finalMethod,
        creditedAt: admin.firestore.FieldValue.serverTimestamp()
      });
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
