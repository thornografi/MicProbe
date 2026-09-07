/**
 * Download helpers - Blob'u dosya olarak indirme
 * DRY: DiagnosticReportBuilder / LogManager / ReportPdfExporter ortak kullanir.
 */

/**
 * Blob'u tarayici indirmesi olarak tetikler
 * @param {Blob} blob - Indirilecek veri
 * @param {string} filename - Dosya adi
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
