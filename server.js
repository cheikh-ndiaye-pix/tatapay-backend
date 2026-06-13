const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'TataPay Backend is running!' });
});

app.post('/api/payment/init', async (req, res) => {
  const { amount, phone, method } = req.body;
  const ref = 'TTP-' + Date.now();
  
  res.json({ 
    payment_url: `https://paytech.sn/payment/simulate/${ref}`,
    ref_command: ref
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur TataPay démarré sur le port ${PORT}`));
