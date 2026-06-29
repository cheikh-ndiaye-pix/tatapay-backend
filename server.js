// ── RETRAIT RÉEL VIA PAYTECH FUND CALL ──
app.post('/api/withdraw', verifyToken, limiter, async (req, res) => {
  const { amount, phone, method } = req.body;
  const uid = req.uid;

  const amt = validateAmount(amount);
  if (!amt) return res.status(400).json({ error: 'Montant invalide (min 100, max 500 000 FCFA)' });
  if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis' });

  try {
    // Vérifier solde suffisant
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'Utilisateur introuvable' });
    
    const balance = userSnap.data().balance || 0;
    if (balance < amt) return res.status(400).json({ error: 'Solde insuffisant' });

    const refCommand = 'TTW-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // Fund call PayTech
    const payload = {
      montant:     amt,
      numero:      phone,
      operateur:   method || 'wave', // wave | orange | free
      ref_command: refCommand,
      env:         PAYTECH_ENV
    };

    const fetch = await import('node-fetch');
    const response = await fetch.default('https://paytech.sn/api/payment/fund-call', {
      method: 'POST',
      headers: {
        'API_KEY':      PAYTECH_API_KEY,
        'API_SECRET':   PAYTECH_API_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();
    console.log('💸 Fund call PayTech:', response.status, rawText.slice(0, 300));

    let data;
    try { data = JSON.parse(rawText); } 
    catch (e) { return res.status(502).json({ error: 'Réponse non-JSON PayTech', raw: rawText.slice(0, 300) }); }

    if (data.success || response.status === 200) {
      // Décrémenter solde + historique
      const histRef = db.collection('users').doc(uid).collection('history').doc();
      await db.runTransaction(async (t) => {
        t.update(db.collection('users').doc(uid), {
          balance: admin.firestore.FieldValue.increment(-amt)
        });
        t.set(histRef, {
          type: 'withdraw',
          label: `Retrait ${method || 'Wave'} — ${phone} — ${refCommand}`,
          amount: -amt,
          ref: refCommand,
          ts: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      console.log(`✅ Retrait : ${uid} -${amt} FCFA → ${phone}`);
      res.json({ message: 'Retrait effectué avec succès', ref: refCommand });

    } else {
      res.status(400).json({ error: data.message || 'Échec PayTech', details: data });
    }

  } catch (err) {
    console.error('❌ Erreur retrait:', err);
    res.status(500).json({ error: err.message });
  }
});
