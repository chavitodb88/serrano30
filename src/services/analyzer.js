const fs = require('fs');
const pdf = require('pdf-parse');
const OpenAI = require('openai');

const EXTRACTION_PROMPT = `Eres un experto en derecho registral español. Analiza el texto de esta Nota Simple del Registro de la Propiedad y extrae los siguientes datos en formato JSON estricto.

Si un campo no aparece en el documento, usa null.

Campos a extraer:
{
  "finca_registral": "número de finca registral",
  "registro_propiedad": "nombre del registro de la propiedad",
  "idufir": "código IDUFIR",
  "referencia_catastral": "referencia catastral completa",
  "metros_cuadrados": "superficie en m² (solo número)",
  "valor_tasacion": "valor de tasación en euros (solo número)",
  "acreedor_hipoteca": "nombre de la entidad acreedora de la hipoteca",
  "principal_hipotecario": "importe del principal de la hipoteca (solo número)",
  "interes_ordinario": "tipo de interés ordinario (ej: 2,50% o texto descriptivo)",
  "intereses_moratorios": "tipo de interés moratorio (ej: 3,00% o texto descriptivo)",
  "tipo_dominio": "pleno dominio | usufructo | concesión administrativa | derecho de superficie | otro (especificar)"
}

IMPORTANTE:
- Devuelve SOLO el JSON, sin explicaciones ni markdown.
- Los importes deben ser números sin símbolo de moneda.
- Si hay varias hipotecas, extrae la que esté vigente (no cancelada). Si hay varias vigentes, extrae la primera.
- "tipo_dominio" se refiere a sobre qué derecho recae la hipoteca.`;

async function extractTextFromPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text;
}

async function analyzeWithGpt(text, fileName) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada en .env');
  }

  const openai = new OpenAI({ apiKey });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: `Nota Simple (archivo: ${fileName}):\n\n${text}` },
    ],
  });

  const content = response.choices[0].message.content.trim();

  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error(`No se pudo parsear la respuesta de GPT para ${fileName}`);
  }
}

module.exports = { extractTextFromPdf, analyzeWithGpt };
