// Minimal RFC 4180 CSV parser / serializer. No dependencies.
(function () {
  'use strict';

  // Parse CSV text into an array of rows (arrays of strings).
  // Handles quoted fields, escaped quotes, embedded newlines, CRLF and a UTF-8 BOM.
  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    // Drop fully empty lines
    return rows.filter(r => r.some(v => v.trim() !== ''));
  }

  // Parse CSV with a header row into { headers, records } where each record is an object.
  function parseObjects(text) {
    const rows = parse(text);
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map(h => h.trim());
    const records = rows.slice(1).map(r => {
      const o = {};
      headers.forEach((h, idx) => { o[h] = (r[idx] ?? '').trim(); });
      return o;
    });
    return { headers, records, rows: rows.slice(1) };
  }

  function escapeField(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Serialize an array of objects using the given column order.
  function stringify(columns, records) {
    const lines = [columns.map(escapeField).join(',')];
    for (const r of records) lines.push(columns.map(c => escapeField(r[c])).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  window.CSV = { parse, parseObjects, stringify };
})();
