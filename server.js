// ════════════════════════════════════════════════════════════
// ── ASSISTANT IA (TataPay) ──
// Répond aux questions des utilisateurs en wolof ou en français.
// Nécessite la variable d'environnement ANTHROPIC_API_KEY sur Render.
// ════════════════════════════════════════════════════════════
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
if (!ANTHROPIC_API_KEY) {
  console.error('🚨 ANTHROPIC_API_KEY n\'est pas définie — la route /api/assistant est désactivée.');
}

const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Trop de questions, réessayez dans une minute.' }
});

const requireAnthropicKey = (req, res, next) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Assistant indisponible (configuration serveur manquante)' });
  }
  next();
};

app.post('/api/assistant', assistantLimiter, requireAnthropicKey, async (req, res) => {
  const { question, lang } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question manquante' });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: 'Question trop longue (max 500 caractères)' });
  }

  const langLabel = lang === 'wo' ? 'wolof' : 'français';

  const systemPrompt =
    `Tu es l'assistant vocal de l'application TataPay (paiement de tickets de bus au Sénégal). ` +
    `Réponds UNIQUEMENT en ${langLabel}, en 2 à 4 phrases courtes et simples, adaptées à une lecture ` +
    `à voix haute. Explique clairement comment utiliser l'application (inscription, paiement, tickets, ` +
    `retraits, rôles passager/receveur/propriétaire/directeur). Si tu n'es pas sûr d'une information, ` +
    `dis-le simplement plutôt que d'inventer.`;

  try {
    const fetch = await import('node-fetch');
    const response = await fetch.default('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 400,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: question.trim() }]
      })
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('❌ Réponse non-JSON Anthropic:', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Réponse invalide de l\'assistant' });
    }

    if (!response.ok) {
      console.error('❌ Erreur Anthropic:', data);
      return res.status(502).json({ error: data.error?.message || 'Erreur assistant' });
    }

    const answer = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim() || '…';

    console.log(`🎙️ Assistant (${langLabel}) : "${question.slice(0,60)}" → ${answer.slice(0,80)}`);
    res.json({ answer, lang: lang === 'wo' ? 'wo' : 'fr' });

  } catch (err) {
    console.error('❌ Erreur assistant:', err);
    res.status(500).json({ error: err.message });
  }
});
