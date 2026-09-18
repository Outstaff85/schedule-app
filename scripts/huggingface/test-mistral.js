// Standalone smoke test for the Hugging Face Inference API — not part of the
// client-side app (schedule-manager.html / worker-punch.html never call HF).
// Run: npm install && npm test   (from this scripts/huggingface/ folder)
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Tokens', 'HuggingFace.env') });

const { InferenceClient } = require('@huggingface/inference');

// NOTE: as of this writing, mistralai/Mistral-7B-Instruct-v0.3's only listed
// Inference Provider (novita) shows status "error" on Hugging Face's side —
// requests to it currently fail with "not a chat model" regardless of this
// script. Verified the token/network/SDK all work correctly against a model
// with a live provider (meta-llama/Llama-3.1-8B-Instruct); swap MODEL below
// if this one is still down when you run it.
const MODEL = 'mistralai/Mistral-7B-Instruct-v0.3';

async function main() {
  const token = process.env.HF_TOKEN;
  if (!token) {
    console.error('HF_TOKEN not found — expected in Tokens/HuggingFace.env at the repo root.');
    process.exit(1);
  }

  const hf = new InferenceClient(token);

  console.log(`Sending a test chat request to ${MODEL}...`);
  const response = await hf.chatCompletion({
    model: MODEL,
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    max_tokens: 64,
  });

  console.log('Response:', response.choices[0].message.content);
}

main().catch((err) => {
  console.error('Hugging Face request failed:', err.message || err);
  process.exit(1);
});
