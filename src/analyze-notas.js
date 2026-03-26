require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const OpenAI = require('openai');
const ExcelJS = require('exceljs');

const NOTAS_DIR = process.env.NOTAS_DIR || './notas-simples';
const OUTPUT_EXCEL = process.env.OUTPUT_EXCEL || './notas-simples/resultado.xlsx';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('ERROR: Falta OPENAI_API_KEY en .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
    console.error(`  [WARN] Respuesta no es JSON válido para ${fileName}, reintentando...`);
    // Intentar extraer JSON del contenido
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error(`No se pudo parsear la respuesta de GPT para ${fileName}`);
  }
}

async function createExcel(results) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Notas Simples');

  // Columnas
  sheet.columns = [
    { header: 'Archivo', key: 'archivo', width: 25 },
    { header: 'Finca Registral', key: 'finca_registral', width: 18 },
    { header: 'Registro Propiedad', key: 'registro_propiedad', width: 25 },
    { header: 'IDUFIR', key: 'idufir', width: 20 },
    { header: 'Ref. Catastral', key: 'referencia_catastral', width: 25 },
    { header: 'Metros²', key: 'metros_cuadrados', width: 12 },
    { header: 'Valor Tasación (€)', key: 'valor_tasacion', width: 18 },
    { header: 'Acreedor Hipoteca', key: 'acreedor_hipoteca', width: 30 },
    { header: 'Principal (€)', key: 'principal_hipotecario', width: 18 },
    { header: 'Interés Ordinario', key: 'interes_ordinario', width: 18 },
    { header: 'Int. Moratorios', key: 'intereses_moratorios', width: 18 },
    { header: 'Tipo Dominio', key: 'tipo_dominio', width: 22 },
  ];

  // Estilo cabecera
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2F5496' },
  };
  sheet.getRow(1).alignment = { horizontal: 'center', wrapText: true };

  // Datos
  for (const r of results) {
    sheet.addRow({
      archivo: r.archivo,
      finca_registral: r.data.finca_registral,
      registro_propiedad: r.data.registro_propiedad,
      idufir: r.data.idufir,
      referencia_catastral: r.data.referencia_catastral,
      metros_cuadrados: r.data.metros_cuadrados ? Number(r.data.metros_cuadrados) : null,
      valor_tasacion: r.data.valor_tasacion ? Number(r.data.valor_tasacion) : null,
      acreedor_hipoteca: r.data.acreedor_hipoteca,
      principal_hipotecario: r.data.principal_hipotecario ? Number(r.data.principal_hipotecario) : null,
      interes_ordinario: r.data.interes_ordinario,
      intereses_moratorios: r.data.intereses_moratorios,
      tipo_dominio: r.data.tipo_dominio,
    });
  }

  // Formato numérico para columnas de dinero
  sheet.getColumn('valor_tasacion').numFmt = '#,##0.00';
  sheet.getColumn('principal_hipotecario').numFmt = '#,##0.00';

  await workbook.xlsx.writeFile(OUTPUT_EXCEL);
}

async function main() {
  console.log(`Buscando PDFs en: ${path.resolve(NOTAS_DIR)}`);

  const pdfFiles = fs.readdirSync(NOTAS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));

  if (pdfFiles.length === 0) {
    console.log('No se encontraron archivos PDF en la carpeta.');
    return;
  }

  console.log(`Encontrados ${pdfFiles.length} PDFs.\n`);

  const results = [];

  for (const file of pdfFiles) {
    const filePath = path.join(NOTAS_DIR, file);
    console.log(`[${results.length + 1}/${pdfFiles.length}] Procesando: ${file}`);

    try {
      const text = await extractTextFromPdf(filePath);

      if (!text || text.trim().length < 50) {
        console.log(`  [WARN] PDF sin texto extraíble (puede ser imagen/escaneado)`);
        results.push({ archivo: file, data: {}, error: 'Sin texto extraíble' });
        continue;
      }

      console.log(`  Texto extraído: ${text.length} caracteres`);
      const data = await analyzeWithGpt(text, file);
      console.log(`  [OK] Datos extraídos correctamente`);
      results.push({ archivo: file, data });
    } catch (error) {
      console.error(`  [ERROR] ${error.message}`);
      results.push({ archivo: file, data: {}, error: error.message });
    }
  }

  // Generar Excel
  console.log(`\nGenerando Excel: ${path.resolve(OUTPUT_EXCEL)}`);
  await createExcel(results);
  console.log(`✓ Excel generado con ${results.length} registros.`);
}

main();
