import { ParsedLabelData } from '../types';

/**
 * Checks if the text has signatures of a real fruit warehouse carton box label.
 * Must match at least 2 distinct label markers to prevent false positives (sky, wall, etc.)
 */
export function isBoxLabel(cleanText: string): boolean {
  if (!cleanText || cleanText.trim().length < 10) return false;

  const t = cleanText.toLowerCase();
  let score = 0;

  // Marker 1: SKU or Product keywords
  if (/sku|tp10|sầu riêng|sau rieng|monthong|ri6|cấp đông|cap dong/i.test(t)) score++;

  // Marker 2: Lot indicators
  if (/lot|lô\s*:|d009|tn08|tn18/i.test(t)) score++;

  // Marker 3: STT / Index
  if (/stt|index|thùng|túi/i.test(t)) score++;

  // Marker 4: Spec & Weight
  if (/spec|weight|khối lượng|khoi luong|20kg|20\s*kg/i.test(t)) score++;

  // Marker 5: Dates or Region
  if (/ngày sx|ngay sx|ngày đg|ngay dg|nsx|ndg|tây nguyên|tay nguyen/i.test(t)) score++;

  // Must have at least 2 markers to be considered a real label!
  return score >= 2;
}

/**
 * Intelligent parser specifically tuned for Fruit / Cold Warehouse labels:
 * Rejects non-label text (sky, walls, etc.) and strictly validates STT/Index.
 */
export function parseBoxLabelText(cleanText: string): ParsedLabelData | null {
  const clean = (cleanText || '').replace(/\r/g, '');
  
  // 0. Strict validation: If not a label, DO NOT PARSE!
  if (!isBoxLabel(clean)) {
    return null;
  }

  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);

  let sku = '';
  let lot_code = '';
  let product_name = 'TP cấp đông sầu riêng múi monthong C - Hàng có hạt';
  let box_index = '';
  let weight = 20;
  let unit = 'Kg';
  let shift_group = 'Nguyên';
  let region = 'Tây Nguyên';
  let production_date = '';
  let packaging_date = '';
  let spec = 'Thùng/túi: 20kg';

  // 1. SKU Extraction
  const skuMatch = clean.match(/(?:M[aã]\s*SKU|SKU)[\s:]*([A-Z0-9._-]+)/i) ||
                   clean.match(/(TP[0-9]{6,12}(?:\.[0-9]+)?)/i);
  if (skuMatch) {
    sku = skuMatch[1].trim().toUpperCase();
  }

  // 2. Lot Extraction
  const lotMatch = clean.match(/(?:Lot|L[oô])[:\s]*([A-Z0-9]+)/i) ||
                   clean.match(/([D|L][0-9O]{2,4}[A-Z0-9]{4,10})/i);
  if (lotMatch) {
    lot_code = lotMatch[1].trim().toUpperCase()
      .replace(/^DOO/, 'D00')
      .replace(/^DO0/, 'D00')
      .replace(/^D0O/, 'D00');
  }

  // 3. Weight Extraction
  const weightMatch = clean.match(/(?:KH[OÔỐ]I\s*L[UƯỢ]NG|WEIGHT)[\s\/:x]*([0-9]{1,3}(?:[.,][0-9]+)?)\s*(?:kg)?/i) ||
                      clean.match(/([0-9]{1,3})\s*kg/i);
  if (weightMatch) {
    weight = parseFloat(weightMatch[1].replace(',', '.'));
  }

  // 4. Dates (NSX & NĐG)
  const nsxMatch = clean.match(/(?:Ng[aà]y\s*SX|NSX)[\s:]*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i);
  if (nsxMatch) {
    production_date = nsxMatch[1].trim();
  }

  const ndgMatch = clean.match(/(?:Ng[aà]y\s*[DĐ]G|N[DĐ]G)[\s:]*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/i);
  if (ndgMatch) {
    packaging_date = ndgMatch[1].trim();
  } else if (production_date) {
    packaging_date = production_date;
  }

  // 5. Region
  const regionMatch = clean.match(/(?:V[UÙ]NG\s*NGUY[EÊ]N\s*LI[EỆ]U)[\s:]*([^\n\r]+)/i);
  if (regionMatch) {
    region = regionMatch[1].replace(/Ng[aà]y\s*SX.*/i, '').trim();
  }

  // 6. Spec
  const specMatch = clean.match(/(?:Quy\s*C[aá]ch|SPEC)[\s\/:]*([^\n\r]+)/i);
  if (specMatch) {
    spec = specMatch[1].replace(/KH[OÔỐ]I.*/i, '').trim();
  }

  // 7. Shift / Group
  const shiftMatch = clean.match(/(?:T[OỔ]\s*\/\s*NH[OÓ]M)[\s:]*([^\n\r]+)/i);
  if (shiftMatch) {
    shift_group = shiftMatch[1].replace(/STT.*/i, '').trim();
  }

  // 8. STT / INDEX Extraction (STRICT & NO ZERO)
  // Pattern A: STT / INDEX followed by 1 to 4 digits
  const directIndexMatch = clean.match(/(?:STT\s*\/\s*INDEX|INDEX|STT)[^0-9\n]{0,20}(\b[0-9]{1,4}\b)/i);
  if (directIndexMatch) {
    box_index = directIndexMatch[1].trim();
  }

  // Pattern B: Search on lines around STT/INDEX
  if (!box_index) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/STT|INDEX/i.test(line)) {
        const numsInLine = line.match(/\b([0-9]{1,4})\b/g);
        if (numsInLine && numsInLine.length > 0) {
          box_index = numsInLine[numsInLine.length - 1];
          break;
        }
        if (i + 1 < lines.length) {
          const nextNums = lines[i + 1].match(/\b([0-9]{1,4})\b/g);
          if (nextNums && nextNums.length > 0) {
            box_index = nextNums[nextNums.length - 1];
            break;
          }
        }
      }
    }
  }

    // 9. Product Name Full (including grade & classification like 'C - Hàng có hạt')
  const prodLine = lines.find(l => /sầu riêng|sau rieng|monthong|ri6|cấp đông|cap dong/i.test(l));
  if (prodLine) {
    product_name = prodLine;
    const pIdx = lines.indexOf(prodLine);
    if (pIdx >= 0 && pIdx + 1 < lines.length && /hàng|loại|hạt|cấp|d009/i.test(lines[pIdx + 1]) && !/quy cách|spec|kg/i.test(lines[pIdx + 1])) {
      product_name += ' ' + lines[pIdx + 1].trim();
    }
  }

  // CRITICAL: A warehouse box index must be a positive integer! NEVER 0, never empty!
  if (!box_index || box_index === '0' || parseInt(box_index, 10) <= 0) {
    return null;
  }

  return {
    sku: sku || 'TP101020104.002',
    lot_code: lot_code || 'D009TN08096',
    product_name,
    box_index,
    weight: weight || 20,
    unit,
    shift_group: shift_group || 'Nguyên',
    region: region || 'Tây Nguyên',
    production_date: production_date || '',
    packaging_date: packaging_date || '',
    spec: spec || 'Thùng/túi: 20kg',
    raw_text: cleanText
  };
}
