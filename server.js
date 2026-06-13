const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PAYTECH_API_KEY    = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

app.get('/', (req, res) => {
  res.json({ message: 'TataPay Backend is running!' });
});

app.post('/api/payment/init', async (req, res) => {
  const { amount, phone, method, type, uid } = req.body;

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Montant minimum 100 FCFA' });
  }

  const refCommand = 'TTP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  const payload = {
    item_name: type === 'recharge' ? 'Recharge TataPay' : 'Ticket TataPay',
    item_price: amount,
    currency: 'XOF',
    ref_command: refCommand,
    command_name: 'TataPay Paiement',
    env: 'prod',
    ipn_url:     'https://tatapay-backend-1.onrender.com/api/ipn',
    success_url: 'https://tatapay-a4972.web.app/success.html',
    cancel_url:  'https://tatapay-a4972.web.app/cancel.html',
    sender_phone:   phone,
    sender_country: 'SN',
    channel: method === 'wave' ? 'wave' : 'orange_money',
    custom_field: JSON.stringify({ uid: uid || '', type, amount })
  };

  try {
    const fetch = await import('node-fetch');
    const response = await fetch.default('https://paytech.sn/api/payment/request-payment', {
      method: 'POST',
      headers: {
        'API_KEY':    PAYTECH_API_KEY,
        'API_SECRET': PAYTECH_API_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();
    console.log('🔍 Statut PayTech:', response.status);
    console.log('🔍 Réponse brute PayTech:', rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: 'Réponse non-JSON de PayTech', raw: rawText.slice(0, 1000) });
    }

    if (data.payment_url) {
      res.json({ payment_url: data.payment_url, ref_command: refCommand });
    } else {
      res.status(500).json({ error: 'Erreur PayTech', details: data });
    }
  } catch (error) {
    console.error('Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ipn', async (req, res) => {
  console.log('📩 IPN reçu:', req.body);

  try {
    const { type_event, custom_field, item_price, ref_command, method } = req.body;

    if (type_event !== 'sale_complete') {
      console.log('⏭️ Événement ignoré:', type_event);
      return res.status(200).send('OK');
    }

    const custom = JSON.parse(custom_field || '{}');
    const uid    = custom.uid;
    const amount = Number(custom.amount || item_price || 0);

    if (!uid || !amount) {
      console.error('❌ uid ou amount manquant');
      return res.status(200).send('OK');
    }

    // Anti-double crédit
    const txRef  = db.collection('paytech_transactions').doc(ref_command);
    const txSnap = await txRef.get();
    if (txSnap.exists && txSnap.data().status === 'credited') {
      console.log('⚠️ Déjà crédité:', ref_command);
      return res.status(200).send('OK');
    }

    // Créditer le balance
    await db.collection('users').doc(uid).update({
      balance: admin.firestore.FieldValue.increment(amount)
    });

    // Historique
    await db.collection('users').doc(uid).collection('history').add({
      type:   'recharge',
      label:  `Recharge via ${method || 'Wave'} – ${ref_command}`,
      amount: amount,
      ref:    ref_command,
      ts:     admin.firestore.FieldValue.serverTimestamp()
    });

    // Marquer comme crédité
    await txRef.set({
      uid, amount, method, ref_command,
      status:     'credited',
      creditedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`✅ Wallet crédité : ${uid} +${amount} FCFA`);
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
