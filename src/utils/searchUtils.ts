/**
 * Thuật toán tìm kiếm & tính điểm độ khớp (Search Score) từ Web Mẹ
 * Đồng bộ 100% logic với chanhthu.click (searchUtils.ts)
 */

export function normalizeSearchString(text: string, removeAccents = false): string {
  if (!text) return '';
  let normalized = text.toLowerCase().normalize('NFC');

  if (removeAccents) {
    normalized = normalized
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd');
  }

  return normalized.trim();
}

export function matchSearch(data: any, term: string): boolean {
  if (!term) return true;
  if (!data) return false;

  const normalizedTerm = normalizeSearchString(term);
  const unaccentedTerm = normalizeSearchString(term, true);
  if (!normalizedTerm) return true;

  let dynamicSearchString: string;
  let unaccentedDataString: string;

  if (typeof data === 'string') {
    dynamicSearchString = data.toLowerCase().normalize('NFC');
    unaccentedDataString = normalizeSearchString(dynamicSearchString, true);
  } else if (typeof data === 'object') {
    const rawAliases = data.aliases || data.short_name || data.alias;
    const aliasText = Array.isArray(rawAliases) ? rawAliases.join(' ') : String(rawAliases || '');
    const catName = data.categories?.name || '';
    const fields = [
      data.name, data.sku, data.code, data.internal_code, data.internal_name,
      data.label, aliasText, catName, data.barcode, data.batch_code,
      data.phone, data.email, data.address, data.notes, data.description
    ].filter(Boolean).join(' ');

    dynamicSearchString = fields
      ? fields.toLowerCase().normalize('NFC')
      : JSON.stringify(data).toLowerCase().normalize('NFC');
    unaccentedDataString = normalizeSearchString(dynamicSearchString, true);
  } else {
    dynamicSearchString = String(data).toLowerCase().normalize('NFC');
    unaccentedDataString = normalizeSearchString(dynamicSearchString, true);
  }

  // 1. Kiểm tra khớp chuỗi trực tiếp
  if (dynamicSearchString.includes(normalizedTerm) || unaccentedDataString.includes(unaccentedTerm)) {
    return true;
  }

  const checkKeyword = (text: string, k: string) => {
    if (!k || k === '-' || k === '+') return true;
    const cleanK = k.replace(/^[()[\]{}]+|[()[\]{}]+$/g, '');
    if (!cleanK) return true;

    if (cleanK.length <= 2) {
      const words = text.split(/[^a-z0-9\u00C0-\u024F\u1EA0-\u1EF9]+/i).filter(Boolean);
      return words.includes(cleanK);
    }
    return text.includes(cleanK);
  };

  // 2. Kiểm tra trực tiếp trên trường aliases / short_name nếu có
  if (typeof data === 'object' && data) {
    const rawAliases = data.aliases || data.short_name || data.alias;
    if (rawAliases) {
      const aliasList = Array.isArray(rawAliases)
        ? rawAliases.map((a: any) => String(a))
        : String(rawAliases).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);

      for (const alias of aliasList) {
        const normAlias = normalizeSearchString(alias);
        const unaccAlias = normalizeSearchString(alias, true);
        if (normAlias === normalizedTerm || unaccAlias === unaccentedTerm) return true;
        if (normAlias.includes(normalizedTerm) || unaccAlias.includes(unaccentedTerm)) return true;
        if (normAlias.length > 3 && (normalizedTerm.includes(normAlias) || unaccentedTerm.includes(unaccAlias))) {
          const aliasWords = normAlias.split(/\s+/).filter(Boolean);
          if (aliasWords.every(w => checkKeyword(normalizedTerm, w))) {
            return true;
          }
        }
      }
    }
  }

  // 3. Tìm kiếm theo từ khóa (Keywords)
  const keywords = normalizedTerm.split(/\s+/).filter(Boolean);
  const unaccentedKeywords = unaccentedTerm.split(/\s+/).filter(Boolean);

  if (keywords.length > 0) {
    const matchesAccented = keywords.every(k => checkKeyword(dynamicSearchString, k));
    const matchesUnaccented = unaccentedKeywords.every(k => checkKeyword(unaccentedDataString, k));
    if (matchesAccented || matchesUnaccented) return true;
  }

  return false;
}

/**
 * Tính điểm khớp theo thứ tự ưu tiên:
 * 1. Aliases khớp chính xác / bắt đầu bằng / chứa từ khóa: score rất cao (1200 - 3500)
 * 2. Tên, SKU, mã nội bộ khớp chính xác / bắt đầu bằng: score cao (400 - 2000)
 * 3. Chuỗi ngắn hơn có điểm ưu tiên hơn chuỗi dài
 */
export function calculateSearchScore(data: any, term: string, extra?: Record<string, any>): number {
  if (!term || !data) return 0;

  const targetData = extra
    ? (typeof data === 'object' ? { ...data, ...extra } : { name: data, ...extra })
    : data;

  const normalizedTerm = normalizeSearchString(term);
  const unaccentedTerm = normalizeSearchString(term, true);
  if (!normalizedTerm) return 0;

  let score = 0;

  if (typeof targetData === 'object' && targetData) {
    // 1a. ĐẶC BIỆT ƯU TIÊN: Kiểm tra trường gõ tắt (aliases / short_name)
    const rawAliases = targetData.aliases || targetData.short_name || targetData.alias;
    if (rawAliases) {
      const aliasList = Array.isArray(rawAliases)
        ? rawAliases.map((a: any) => String(a))
        : String(rawAliases).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);

      for (const alias of aliasList) {
        const val = normalizeSearchString(alias);
        const unaccentedVal = normalizeSearchString(val, true);

        // Khớp chính xác tên gõ tắt -> Đẩy lên Top 1 tuyệt đối
        if (val === normalizedTerm || unaccentedVal === unaccentedTerm) {
          score += 3500;
          break;
        }
        // Bắt đầu bằng từ gõ tắt
        if (val.startsWith(normalizedTerm) || unaccentedVal.startsWith(unaccentedTerm)) {
          score += 2200;
          break;
        }
        // Chứa từ gõ tắt
        if (val.includes(normalizedTerm) || unaccentedVal.includes(unaccentedTerm)) {
          score += 1500;
          break;
        }
        // Hoặc từ tìm kiếm nằm trọn vẹn trong các từ của alias
        const termWords = normalizedTerm.split(/[\s,._-]+/).filter(Boolean);
        if (termWords.length > 0 && termWords.every(tw => val.includes(tw) || unaccentedVal.includes(tw))) {
          score += 1200;
          break;
        }
      }
    }

    const priorityFields = ['label', 'name', 'code', 'sku', 'internal_name', 'internal_code', 'aliases', 'short_name'];
    for (const field of priorityFields) {
      const valRaw = targetData[field];
      if (!valRaw) continue;

      const val = normalizeSearchString(String(valRaw));
      const unaccentedVal = normalizeSearchString(val, true);

      // Exact Match trên trường ưu tiên
      if (val === normalizedTerm) score += 2000;
      else if (unaccentedVal === unaccentedTerm) score += 1500;

      // Starts With trên trường ưu tiên
      if (val.startsWith(normalizedTerm)) score += 800;
      else if (unaccentedVal.startsWith(unaccentedTerm)) score += 600;

      // Word Starts With
      const fieldWords = val.split(/[\s,._-]+/);
      if (fieldWords.some(w => w.startsWith(normalizedTerm))) score += 400;

      // Contains
      if (val.includes(normalizedTerm)) score += 200;
      else if (unaccentedVal.includes(unaccentedTerm)) score += 100;
    }
  } else {
    const stringData = String(targetData || '');
    const normalizedData = stringData.toLowerCase().normalize('NFC');
    const unaccentedData = normalizeSearchString(normalizedData, true);

    if (normalizedData === normalizedTerm || unaccentedData === unaccentedTerm) score += 1000;
    else if (normalizedData.startsWith(normalizedTerm) || unaccentedData.startsWith(unaccentedTerm)) score += 500;
    else if (normalizedData.includes(normalizedTerm)) score += 100;
  }

  // Length penalty
  if (score > 0) {
    const textLen = typeof targetData === 'string' ? targetData.length : String(targetData?.name || '').length;
    const lengthPenalty = Math.min(textLen / 2, 50);
    score -= lengthPenalty;
  }

  return score;
}
