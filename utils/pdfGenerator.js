'use strict';

const PDFDocument = require('pdfkit');
const moment = require('moment');

// ─── Standard design tokens ───────────────────────────────────────────────────

const COLORS = {
  primary:      '#1e3a8a', // Koyu mavi  – başlık / tablo header arkaplanı
  secondary:    '#3b82f6', // Açık mavi  – tarih / altbilgi
  accent:       '#f59e0b', // Turuncu    – grup başlıkları
  light:        '#f3f4f6', // Açık gri   – belge başlığı arkaplanı
  dark:         '#1f2937', // Koyu gri   – içerik metni
  white:        '#ffffff', // Beyaz
  headerBg:     '#1e3a8a', // Tablo başlığı arkaplanı (beyaz yazı üstünde)
  tableBorder:  '#d1d5db', // Tablo çizgisi
  tableRowAlt:  '#f9fafb', // Alternatif satır rengi
};

const FONTS = {
  bold:    'Times-Bold',
  regular: 'Times-Roman',
};

const LAYOUT = {
  margin:    40,  // compact – 40 px kenar boşluğu
  rowHeight: 20,  // kompakt satır yüksekliği
  headerH:   60,  // belge üst-bilgi bloğu yüksekliği
  subHeaderH: 22, // bölüm başlığı çubuğu yüksekliği
  tableHeaderH: 18, // tablo sütun başlığı yüksekliği
};

// ─── Türkçe → ASCII dönüşüm ──────────────────────────────────────────────────

function turkishToAscii(text) {
  if (!text) return '';
  return String(text)
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ç/g, 'c').replace(/Ç/g, 'C')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O');
}

// ─── Layout seçimi ───────────────────────────────────────────────────────────
// Toplam sütun genişliği portrait A4'e (515 px) sığmıyorsa ya da
// sütun sayısı > 5 ise → landscape

function chooseLayout(columnCount, totalColWidth) {
  const portraitUsableWidth = 595 - 2 * LAYOUT.margin; // ≈ 515
  if (columnCount > 5 || totalColWidth > portraitUsableWidth) {
    return 'landscape';
  }
  return 'portrait';
}

// ─── PDFDocument oluştur ─────────────────────────────────────────────────────

function createDoc(layout, meta = {}) {
  return new PDFDocument({
    size:   'A4',
    layout,
    margin: LAYOUT.margin,
    info: {
      Author:  'Turkiye Kuras',
      Creator: 'Kuras Backend',
      ...meta,
    },
  });
}

// ─── Sayfa üst-bilgisi ───────────────────────────────────────────────────────
// Döndürür: başlık bloğunun bitişindeki Y koordinatı

function drawPageHeader(doc, organisation, subtitle) {
  const m  = LAYOUT.margin;
  const w  = doc.page.width - 2 * m;
  const h  = LAYOUT.headerH;

  // Arkaplan kutusu
  doc.rect(m, m, w, h).fill(COLORS.light);

  // "TURKIYE KURAS" – 14 pt bold koyu mavi
  doc.font(FONTS.bold).fontSize(14).fillColor(COLORS.primary)
     .text('TURKIYE KURAS', m, m + 6, { width: w, align: 'center' });

  // Turnuva adı – 11 pt bold koyu gri
  doc.font(FONTS.bold).fontSize(11).fillColor(COLORS.dark)
     .text(turkishToAscii(organisation.tournamentName), m, m + 22, { width: w, align: 'center' });

  // Tarih + yer – 9 pt regular
  const startDate = moment(organisation.tournamentDate.startDate).format('DD.MM.YYYY');
  const endDate   = organisation.tournamentDate.endDate
    ? moment(organisation.tournamentDate.endDate).format('DD.MM.YYYY')
    : startDate;

  let infoLine = `${startDate} - ${endDate}`;
  if (organisation.tournamentPlace && organisation.tournamentPlace.city) {
    infoLine += `  |  ${turkishToAscii(organisation.tournamentPlace.city.name)}`;
    if (organisation.tournamentPlace.venue) {
      infoLine += ` - ${turkishToAscii(organisation.tournamentPlace.venue)}`;
    }
  }

  doc.font(FONTS.regular).fontSize(9).fillColor(COLORS.secondary)
     .text(infoLine, m, m + 38, { width: w, align: 'center' });

  // Alt şerit – subtitle başlığı (mavi arka plan, beyaz yazı)
  if (subtitle) {
    doc.rect(m, m + h, w, LAYOUT.subHeaderH).fill(COLORS.primary);
    doc.font(FONTS.bold).fontSize(11).fillColor(COLORS.white)
       .text(turkishToAscii(subtitle), m, m + h + 4, { width: w, align: 'center' });
    return m + h + LAYOUT.subHeaderH + 4; // content başlangıcı
  }

  return m + h + 4;
}

// ─── Tablo sütun başlıkları ───────────────────────────────────────────────────
// headers: [{ label, width }]   → döndürür: tableTop + tableHeaderH

function drawTableHeaders(doc, tableLeft, headers, tableTop) {
  const totalW = headers.reduce((s, c) => s + c.width, 0);

  // Arkaplan (koyu mavi)
  doc.rect(tableLeft, tableTop, totalW, LAYOUT.tableHeaderH).fill(COLORS.primary);

  // Yazılar (9 pt bold beyaz)
  doc.font(FONTS.bold).fontSize(9).fillColor(COLORS.white);
  let x = tableLeft;
  for (const col of headers) {
    doc.text(col.label, x + 3, tableTop + 4, { width: col.width - 6, lineBreak: false });
    x += col.width;
  }

  // Dış çerçeve
  doc.rect(tableLeft, tableTop, totalW, LAYOUT.tableHeaderH)
     .lineWidth(0.5).stroke(COLORS.tableBorder);

  // Sütun çizgileri
  x = tableLeft;
  for (let i = 0; i < headers.length - 1; i++) {
    x += headers[i].width;
    doc.moveTo(x, tableTop).lineTo(x, tableTop + LAYOUT.tableHeaderH)
       .lineWidth(0.5).stroke(COLORS.tableBorder);
  }

  return tableTop + LAYOUT.tableHeaderH;
}

// ─── Tablo satırı ────────────────────────────────────────────────────────────
// cells: [string]   altRow: boolean   → döndürür: rowY + rowHeight

function drawTableRow(doc, tableLeft, headers, cells, rowY, altRow) {
  const totalW = headers.reduce((s, c) => s + c.width, 0);
  const rh     = LAYOUT.rowHeight;

  // Alternatif satır arka planı
  if (altRow) {
    doc.rect(tableLeft, rowY, totalW, rh).fill(COLORS.tableRowAlt);
  }

  // İçerik – 9 pt regular koyu gri
  doc.font(FONTS.regular).fontSize(9).fillColor(COLORS.dark);
  let x = tableLeft;
  for (let i = 0; i < headers.length; i++) {
    const val = cells[i] !== undefined && cells[i] !== null ? String(cells[i]) : '';
    doc.text(val, x + 3, rowY + 5, { width: headers[i].width - 6, lineBreak: false });
    x += headers[i].width;
  }

  // Satır dış çerçevesi
  doc.rect(tableLeft, rowY, totalW, rh)
     .lineWidth(0.5).stroke(COLORS.tableBorder);

  // Sütun çizgileri
  x = tableLeft;
  for (let i = 0; i < headers.length - 1; i++) {
    x += headers[i].width;
    doc.moveTo(x, rowY).lineTo(x, rowY + rh)
       .lineWidth(0.5).stroke(COLORS.tableBorder);
  }

  return rowY + rh;
}

// ─── Grup başlığı çubuğu (turuncu) ──────────────────────────────────────────

function drawGroupHeader(doc, tableLeft, totalW, label, y) {
  doc.rect(tableLeft, y, totalW, LAYOUT.subHeaderH).fill(COLORS.accent);
  doc.font(FONTS.bold).fontSize(11).fillColor(COLORS.white)
     .text(turkishToAscii(label), tableLeft + 8, y + 5, { width: totalW - 16, lineBreak: false });
  return y + LAYOUT.subHeaderH;
}

// ─── Sayfa altbilgisi ────────────────────────────────────────────────────────

function drawPageFooter(doc) {
  const m = LAYOUT.margin;
  doc.font(FONTS.regular).fontSize(7).fillColor(COLORS.secondary)
     .text(
       `Olusturulma Tarihi: ${moment().format('DD.MM.YYYY HH:mm')}`,
       m,
       doc.page.height - m - 10,
       { width: doc.page.width - 2 * m, align: 'center' }
     );
}

// ─── İmza alanları ───────────────────────────────────────────────────────────

function drawSignatureArea(doc, coordinator, chairman, y) {
  const m             = LAYOUT.margin;
  const sigW          = 180;
  const usableW       = doc.page.width - 2 * m;
  const gap           = (usableW - 2 * sigW) / 3;

  const leftX  = m + gap;
  const rightX = m + 2 * gap + sigW;

  doc.font(FONTS.bold).fontSize(9).fillColor(COLORS.dark);

  // Sol – Koordinatör
  doc.text('Koordinator', leftX, y, { width: sigW, align: 'center' });
  doc.moveTo(leftX, y + 25).lineTo(leftX + sigW, y + 25)
     .lineWidth(0.5).stroke(COLORS.dark);
  if (coordinator) {
    doc.font(FONTS.regular).fontSize(8).fillColor(COLORS.dark)
       .text(turkishToAscii(coordinator), leftX, y + 30, { width: sigW, align: 'center' });
  }

  // Sağ – Kurul Başkanı
  doc.font(FONTS.bold).fontSize(9).fillColor(COLORS.dark);
  doc.text('Kurul Baskani', rightX, y, { width: sigW, align: 'center' });
  doc.moveTo(rightX, y + 25).lineTo(rightX + sigW, y + 25)
     .lineWidth(0.5).stroke(COLORS.dark);
  if (chairman) {
    doc.font(FONTS.regular).fontSize(8).fillColor(COLORS.dark)
       .text(turkishToAscii(chairman), rightX, y + 30, { width: sigW, align: 'center' });
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  COLORS,
  FONTS,
  LAYOUT,
  turkishToAscii,
  chooseLayout,
  createDoc,
  drawPageHeader,
  drawTableHeaders,
  drawTableRow,
  drawGroupHeader,
  drawPageFooter,
  drawSignatureArea,
};
