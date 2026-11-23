/**
 * Chuẩn hóa văn bản nhận dạng giọng nói tiếng Việt cho nghiệp vụ Kiểm kê & Kho lạnh.
 * - Chuyển số đọc bằng chữ (0..999) sang chữ số khi đứng trước đơn vị kho hoặc cụm số lượng.
 * - Chuẩn hóa thuật ngữ chuyên ngành kho (Ri 6, Dona, Monthong, Musang King, LOT, pallet, STT, kg...).
 */

const VI_DIGITS: Record<string, number> = {
  không: 0,
  một: 1,
  mốt: 1,
  hai: 2,
  ba: 3,
  bốn: 4,
  tư: 4,
  năm: 5,
  lăm: 5,
  nhăm: 5,
  sáu: 6,
  bảy: 7,
  bẩy: 7,
  tám: 8,
  chín: 9,
};

function parseVietnameseNumberTokens(tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  let total = 0;
  let i = 0;

  const tramIdx = tokens.indexOf('trăm');
  if (tramIdx !== -1) {
    const hWord = tramIdx > 0 ? tokens[tramIdx - 1] : '';
    const hVal = VI_DIGITS[hWord];
    if (hVal === undefined) return null;
    total += hVal * 100;
    i = tramIdx + 1;
    if (tokens[i] === 'lẻ' || tokens[i] === 'linh') {
      i++;
      const uVal = VI_DIGITS[tokens[i] || ''];
      if (uVal !== undefined) {
        total += uVal;
        i++;
      }
      return i === tokens.length ? total : null;
    }
  }

  if (i < tokens.length) {
    if (tokens[i] === 'mười') {
      total += 10;
      i++;
      if (i < tokens.length) {
        const uVal = VI_DIGITS[tokens[i]];
        if (uVal === undefined) return null;
        total += uVal;
        i++;
      }
    } else if (i + 1 < tokens.length && tokens[i + 1] === 'mươi') {
      const tVal = VI_DIGITS[tokens[i]];
      if (tVal === undefined) return null;
      total += tVal * 10;
      i += 2;
      if (i < tokens.length) {
        const uVal = VI_DIGITS[tokens[i]];
        if (uVal === undefined) return null;
        total += uVal;
        i++;
      }
    } else if (tramIdx !== -1 && i < tokens.length) {
      return null;
    } else if (tokens.length === 1 && VI_DIGITS[tokens[0]] !== undefined) {
      total = VI_DIGITS[tokens[0]];
      i = 1;
    } else {
      return null;
    }
  }

  return i === tokens.length ? total : null;
}

const NUMBER_WORDS_SET = new Set([
  ...Object.keys(VI_DIGITS),
  'mười',
  'mươi',
  'trăm',
  'lẻ',
  'linh',
]);

const UNIT_TRIGGER_WORDS = new Set([
  'thùng',
  'kiện',
  'lot',
  'lót',
  'pallet',
  'kg',
  'ký',
  'cân',
  'bịch',
  'túi',
  'khay',
  'hộp',
  'cái',
  'ô',
  'tầng',
  'dãy',
  'vị',
]);

function convertSpokenNumbers(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let i = 0;

  while (i < words.length) {
    const lower = words[i].toLowerCase().replace(/[.,;:!?]+$/g, '');
    if (NUMBER_WORDS_SET.has(lower)) {
      let j = i;
      const numTokens: string[] = [];
      let trailingPunct = '';
      while (j < words.length) {
        const raw = words[j];
        const punctMatch = raw.match(/[.,;:!?]+$/);
        const clean = raw.toLowerCase().replace(/[.,;:!?]+$/g, '');
        if (!NUMBER_WORDS_SET.has(clean)) break;
        numTokens.push(clean);
        j++;
        if (punctMatch) {
          trailingPunct = punctMatch[0];
          break;
        }
      }

      const nextWord = (words[j] || '').toLowerCase().replace(/[.,;:!?]+$/g, '');
      const prevWord = (out[out.length - 1] || '').toLowerCase().replace(/[.,;:!?]+$/g, '');
      const isContextNumeric =
        numTokens.length >= 2 ||
        UNIT_TRIGGER_WORDS.has(nextWord) ||
        ['có', 'thiếu', 'dư', 'còn', 'tổng', 'số', 'tầng', 'ô', 'dãy', 'stt', 'mã', 'ri'].includes(
          prevWord
        );

      const parsed = isContextNumeric ? parseVietnameseNumberTokens(numTokens) : null;
      if (parsed !== null) {
        out.push(String(parsed) + trailingPunct);
        i = j;
        continue;
      }
    }
    out.push(words[i]);
    i++;
  }

  return out.join(' ');
}

export function normalizeWarehouseVoiceText(raw: string): string {
  if (!raw) return '';
  let text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return '';

  const replacements: [RegExp, string][] = [
    [/\b(?:ri|di|ghi|ry)\s*(?:sáu|6)\b/gi, 'Ri 6'],
    [/\b(?:ri6|di6)\b/gi, 'Ri 6'],
    [/\b(?:đô\s*na|dô\s*na|do\s*na|đôna)\b/gi, 'Dona'],
    [/\b(?:mô\s*thon|môn\s*thon|mông\s*thon|mon\s*thong)\b/gi, 'Monthong'],
    [/\b(?:mu\s*sang\s*kinh|mu\s*sang\s*king|mú\s*sang\s*king)\b/gi, 'Musang King'],
    [/\b(?:ba\s*lết|pa\s*lét|pa\s*lết|ba\s*lét|ba\s*let|pa\s*let)\b/gi, 'pallet'],
    [/\b(?:lót|lot)\b/gi, 'LOT'],
    [/\b(?:số\s*thứ\s*tự|ét\s*tê\s*tê)\b/gi, 'STT'],
    [/\b(?:ký\s*lô|ki\s*lô|ki\s*lo)\b/gi, 'kg'],
  ];

  for (const [pattern, rep] of replacements) {
    text = text.replace(pattern, rep);
  }

  text = convertSpokenNumbers(text);
  text = text.replace(/(\d+)\s*ký\b/gi, '$1 kg');
  text = text.charAt(0).toUpperCase() + text.slice(1);

  return text.trim();
}

export function appendWarehouseVoiceText(currentText: string, spokenText: string): string {
  const cleanSpoken = normalizeWarehouseVoiceText(spokenText);
  if (!cleanSpoken) return currentText;
  const cur = (currentText || '').trim();
  if (!cur) return cleanSpoken;
  const sep = /[,.;:\-]$/.test(cur) ? ' ' : ', ';
  return `${cur}${sep}${cleanSpoken}`;
}

export const WAREHOUSE_VOICE_CONTEXT_STRINGS = [
  'Ri 6',
  'Dona',
  'Monthong',
  'Musang King',
  'pallet',
  'LOT',
  'STT',
  'thùng',
  'kiện',
  'thực tế có',
  'thiếu',
  'dư',
  'trống',
  'sai vị trí',
  'nhầm mã',
  'rách thùng',
  'móp thùng',
  'múi',
  'cơm sầu riêng',
  'nguyên trái',
  'hàng hồi',
];
