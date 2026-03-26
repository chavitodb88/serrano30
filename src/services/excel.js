const ExcelJS = require('exceljs');

const COLUMNS = [
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

async function generateExcel(results, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Notas Simples');

  sheet.columns = COLUMNS;

  // Estilo cabecera
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2F5496' },
  };
  sheet.getRow(1).alignment = { horizontal: 'center', wrapText: true };

  for (const r of results) {
    sheet.addRow({
      archivo: r.original_name,
      finca_registral: r.finca_registral,
      registro_propiedad: r.registro_propiedad,
      idufir: r.idufir,
      referencia_catastral: r.referencia_catastral,
      metros_cuadrados: r.metros_cuadrados ? Number(r.metros_cuadrados) : null,
      valor_tasacion: r.valor_tasacion ? Number(r.valor_tasacion) : null,
      acreedor_hipoteca: r.acreedor_hipoteca,
      principal_hipotecario: r.principal_hipotecario ? Number(r.principal_hipotecario) : null,
      interes_ordinario: r.interes_ordinario,
      intereses_moratorios: r.intereses_moratorios,
      tipo_dominio: r.tipo_dominio,
    });
  }

  sheet.getColumn('valor_tasacion').numFmt = '#,##0.00';
  sheet.getColumn('principal_hipotecario').numFmt = '#,##0.00';

  await workbook.xlsx.writeFile(outputPath);
}

module.exports = { generateExcel };
