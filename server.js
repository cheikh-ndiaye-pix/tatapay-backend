// ════════════════════════════════════════════════════════════
// ── ASSISTANT IA GRATUIT (Google Gemini) ──
// Nécessite la variable d'environnement GEMINI_API_KEY sur Render.
// Clé gratuite sans carte bancaire : aistudio.google.com
// ════════════════════════════════════════════════════════════
const rateLimit = require('express-rate-limit');
const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
let genAI = null;
if (!GEMINI_API_KEY) {
  console.error('🚨 GEMINI_API_KEY n\'est pas définie — la route /api/assistant est désactivée.');
} else {
  genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Trop de requêtes, réessayez dans une minute.' }
});

const requireGeminiKey = (req, res, next) => {
  if (!genAI) {
    return res.status(503).json({ error: 'Assistant indisponible (configuration serveur manquante)' });
  }
  next();
};

app.post('/api/assistant', assistantLimiter, requireGeminiKey, async (req, res) => {
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
    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: question.trim(),
      config: { systemInstruction: systemPrompt }
    });

    const answer = (response.text || '…').trim();
    console.log(`🎙️ Assistant (${langLabel}) : "${question.slice(0,60)}" → ${answer.slice(0,80)}`);
    res.json({ answer, lang: lang === 'wo' ? 'wo' : 'fr' });

  } catch (err) {
    console.error('❌ Erreur assistant Gemini:', err);
    res.status(500).json({ error: err.message });
  }
});
