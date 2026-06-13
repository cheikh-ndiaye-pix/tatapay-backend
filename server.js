const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Clés PayTech (déjà dans les variables d'environnement Render)
const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;

app.get('/', (req, res) => {
  res.json({ message: 'TataPay Backend is running!' });
});

app.post('/api/payment/init', async (req, res) => {
  const { amount, phone, method, type } = req.body;
  
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
    env: 'test',  // ← Mets 'prod' pour les vrais paiements
    ipn_url: 'https://tatapay-backend-1.onrender.com/api/ipn',
    success_url: 'https://tatapay-a4972.web.app/success.html',
    cancel_url: 'https://tatapay-a4972.web.app/cancel.html',
    sender_phone: phone,
    sender_country: 'SN',
    channel: method === 'wave' ? 'wave' : 'orange_money',
    custom_field: JSON.stringify({ userId: 'temp', type: type, amount: amount })
  };

  try {
    const fetch = await import('node-fetch');
    const response = await fetch.default('https://paytech.sn/api/payment/request', {
      method: 'POST',
      headers: {
        'API_KEY': PAYTECH_API_KEY,
        'API_SECRET': PAYTECH_API_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    
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

app.post('/api/ipn', (req, res) => {
  console.log('📩 IPN reçu:', req.body);
  // Ici, tu crédites le wallet après confirmation
  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur TataPay démarré sur le port ${PORT}`);
});
