import { zipSync, strToU8 } from 'fflate/browser';

/** Test helpers that build real PDF and DOCX files in memory. Not used by the app. */

const escapePdf = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * A minimal, valid PDF: one page per entry, each line drawn with Helvetica.
 * `extra` adds raw dictionary entries to the catalog (e.g. a JavaScript OpenAction).
 */
export function buildPdf(
  pages: readonly (readonly string[])[],
  options: { title?: string; author?: string; creationDate?: string; catalogExtra?: string } = {},
): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // Returns the 1-based object number.

  const catalog = add(''); // placeholder, filled below
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines
      .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${escapePdf(line)}) Tj ET`)
      .join('\n');
    const content = add(
      `<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R ${options.catalogExtra ?? ''}>>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const infoFields = [
    options.title && `/Title (${escapePdf(options.title)})`,
    options.author && `/Author (${escapePdf(options.author)})`,
    options.creationDate && `/CreationDate (${options.creationDate})`,
  ].filter(Boolean);
  const info = infoFields.length ? add(`<< ${infoFields.join(' ')} >>`) : 0;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A minimal .docx package. `bodyXml` is the content of `<w:body>`. */
export function buildDocx(
  bodyXml: string,
  core?: { title?: string; creator?: string; created?: string },
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`,
    ),
  };
  if (core) {
    files['docProps/core.xml'] = strToU8(
      `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">` +
        (core.title ? `<dc:title>${core.title}</dc:title>` : '') +
        (core.creator ? `<dc:creator>${core.creator}</dc:creator>` : '') +
        (core.created ? `<dcterms:created>${core.created}</dcterms:created>` : '') +
        '</cp:coreProperties>',
    );
  }
  return zipSync(files);
}

export const paragraph = (...runs: string[]) =>
  `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join('')}</w:p>`;
