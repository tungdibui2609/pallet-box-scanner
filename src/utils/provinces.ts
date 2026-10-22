export interface Province {
  code: string;
  name: string;
  shortName: string;
}

export const VIETNAM_PROVINCES: Province[] = [
  { code: '54', name: 'Tỉnh Phú Yên', shortName: 'Phú Yên' },
  { code: '56', name: 'Tỉnh Khánh Hòa', shortName: 'Khánh Hòa' },
  { code: '58', name: 'Tỉnh Ninh Thuận', shortName: 'Ninh Thuận' },
  { code: '60', name: 'Tỉnh Bình Thuận', shortName: 'Bình Thuận' },
  { code: '62', name: 'Tỉnh Kon Tum', shortName: 'Kon Tum' },
  { code: '64', name: 'Tỉnh Gia Lai', shortName: 'Gia Lai' },
  { code: '66', name: 'Tỉnh Đắk Lắk', shortName: 'Đắk Lắk' },
  { code: '67', name: 'Tỉnh Đắk Nông', shortName: 'Đắk Nông' },
  { code: '68', name: 'Tỉnh Lâm Đồng', shortName: 'Lâm Đồng' },
  { code: '70', name: 'Tỉnh Bình Phước', shortName: 'Bình Phước' },
  { code: '72', name: 'Tỉnh Tây Ninh', shortName: 'Tây Ninh' },
  { code: '74', name: 'Tỉnh Bình Dương', shortName: 'Bình Dương' },
  { code: '75', name: 'Tỉnh Đồng Nai', shortName: 'Đồng Nai' },
  { code: '77', name: 'Tỉnh Bà Rịa – Vũng Tàu', shortName: 'Bà Rịa – Vũng Tàu' },
  { code: '80', name: 'Tỉnh Long An', shortName: 'Long An' },
  { code: '82', name: 'Tỉnh Tiền Giang', shortName: 'Tiền Giang' },
  { code: '83', name: 'Tỉnh Bến Tre', shortName: 'Bến Tre' },
  { code: '84', name: 'Tỉnh Trà Vinh', shortName: 'Trà Vinh' },
  { code: '86', name: 'Tỉnh Vĩnh Long', shortName: 'Vĩnh Long' },
  { code: '87', name: 'Tỉnh Đồng Tháp', shortName: 'Đồng Tháp' },
  { code: '89', name: 'Tỉnh An Giang', shortName: 'An Giang' },
  { code: '91', name: 'Tỉnh Kiên Giang', shortName: 'Kiên Giang' },
  { code: '92', name: 'Thành phố Cần Thơ', shortName: 'Cần Thơ' },
  { code: '93', name: 'Tỉnh Hậu Giang', shortName: 'Hậu Giang' },
  { code: '94', name: 'Tỉnh Sóc Trăng', shortName: 'Sóc Trăng' }
];

export function findProvince(query: string): Province | undefined {
  if (!query) return undefined;
  const q = query.trim().toLowerCase();

  const byCode = VIETNAM_PROVINCES.find(p => p.code === q);
  if (byCode) return byCode;

  const byName = VIETNAM_PROVINCES.find(p =>
    p.name.toLowerCase() === q ||
    p.shortName.toLowerCase() === q ||
    q.includes(p.shortName.toLowerCase()) ||
    p.shortName.toLowerCase().includes(q)
  );
  return byName;
}

export function formatMaterialZoneProvince(zone: string): string {
  if (!zone) return '';
  const trimmed = zone.trim();
  if (!trimmed || trimmed === '---') return '';

  const p = findProvince(trimmed);
  if (p) return p.shortName;

  const cleaned = trimmed
    .replace(/^VN-?\d+-?\d*\s*[-–:]\s*/i, '')
    .replace(/^Vùng\s+trồng\s+/i, '')
    .replace(/^(Tỉnh|Thành phố)\s+/i, '')
    .trim();

  const pCleaned = findProvince(cleaned);
  if (pCleaned) return pCleaned.shortName;

  return cleaned || trimmed;
}

export function formatMaterialZoneList(rawMz: any): string {
  if (!rawMz) return '---';
  let list: string[] = [];
  if (Array.isArray(rawMz)) {
    list = rawMz;
  } else if (typeof rawMz === 'string') {
    list = rawMz.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  if (list.length === 0) return '---';

  const set = new Set<string>();
  list.forEach(item => {
    const prov = formatMaterialZoneProvince(item);
    if (prov && prov !== '---') set.add(prov);
  });

  const result = Array.from(set);
  return result.length > 0 ? result.join(', ') : '---';
}
