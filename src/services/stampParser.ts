/**
 * Service nhận diện và bóc tách dãy số đóng dấu mực trên thùng carton (Ink Stamp Parser)
 * Cấu trúc quy chuẩn theo Tập đoàn Chánh Thu:
 *
 * DÒNG 1: Phân cấp sản phẩm (14 ký tự) - VD: 102010204001-0
 * - Ký tự 1: Chủng loại trái cây (1: Sầu riêng, 2: Mít, 3: Dưa hấu, 4: Nhãn)
 * - Ký tự 2,3: Hình thức cấp đông (01: Nguyên trái, 02: Múi)
 * - Ký tự 4,5: Giống trái cây (01: Monthong/Dona, 02: Ri-6)
 * - Ký tự 6,7: Phân loại thành phẩm (01: VIP, 02: Loại A, 03: Loại B, 04: Loại C)
 * - Ký tự 8,9: Quy cách đóng gói (01: 1 túi/thùng, 04: 4 túi/thùng)
 * - Ký tự 10,11,12: Phương pháp cấp đông (001: Hầm đông, 002: Nito, 003: IQF)
 * - Ký tự 13: Dấu gạch ngang (-)
 * - Ký tự 14: Chất lượng theo khách hàng (0: Không phân chia, 1, 2...)
 *
 * DÒNG 2: Truy xuất nguồn gốc (16 chữ số) - VD: 2120908092600166
 * - Ký tự 1 (F): Mã nhà máy (1: Bến Tre, 2: Đắk Lắk)
 * - Ký tự 2..5 (ddmm): Ngày - tháng đóng gói (1209 -> 12/09)
 * - Ký tự 6..11 (DDMMYY): Ngày - tháng - năm nhập nguyên liệu (080926 -> 08/09/2026)
 * - Ký tự 12..14 (XXX): Mã nhà cung cấp (001, 002, 047...)
 * - Ký tự 15..16 (ZZ): Mã vùng nguyên liệu / Tỉnh (66: Đắk Lắk, 71: Bến Tre...)
 */

import { ParsedStampData, DecodedStampDetails, StampFormat } from '../types';

export const DEFAULT_STAMP_DICTIONARY: Record<string, Record<string, string>> = {
  fruit_type: {
    '1': 'TP cấp đông sầu riêng',
    '2': 'TP cấp đông mít',
    '3': 'TP cấp đông dưa hấu',
    '4': 'TP cấp đông nhãn'
  },
  freeze_style: {
    '01': 'Cấp đông nguyên trái',
    '02': 'Cấp đông múi'
  },
  variety: {
    '01': 'Monthong (Dona)',
    '02': 'Ri-6',
    '03': 'Musang King',
    '04': 'Black Thorn'
  },
  product_grade: {
    '01': 'Loại VIP',
    '02': 'Loại A',
    '03': 'Loại B',
    '04': 'Loại C'
  },
  package_spec: {
    '01': '1 Túi/ thùng',
    '02': '2 Túi/ thùng',
    '04': '4 Túi/ thùng',
    '08': '8 Túi/ thùng'
  },
  freeze_method: {
    '001': 'Hầm đông',
    '002': 'Nitơ',
    '003': 'IQF'
  },
  customer_quality: {
    '0': 'Không phân chia',
    '1': 'Tiêu chuẩn khách hàng 1',
    '2': 'Tiêu chuẩn khách hàng 2'
  },
  factory: {
    '1': 'Nhà máy Bến Tre',
    '2': 'Nhà máy Đắk Lắk'
  },
  supplier: {
    // Để trống - bảo mật sản xuất, người dùng khai báo hoặc đồng bộ khi có danh sách
  },
  province: {
    '66': 'Đắk Lắk',
    '71': 'Bến Tre',
    '67': 'Đắk Nông',
    '68': 'Lâm Đồng',
    '64': 'Gia Lai',
    '62': 'Kon Tum',
    '77': 'Bà Rịa - Vũng Tàu',
    '79': 'Hồ Chí Minh',
    '80': 'Long An',
    '82': 'Tiền Giang',
    '84': 'Trà Vinh',
    '86': 'Vĩnh Long',
    '87': 'Đồng Tháp',
    '89': 'An Giang',
    '91': 'Kiên Giang',
    '92': 'Cần Thơ',
    '93': 'Hậu Giang',
    '94': 'Sóc Trăng',
    '95': 'Bạc Liêu',
    '96': 'Cà Mau',
    '60': 'Bình Thuận',
    '58': 'Ninh Thuận',
    '56': 'Khánh Hòa',
    '54': 'Phú Yên',
    '52': 'Bình Định'
  },
  special_12: {
    '101010202002': 'TP cấp đông sầu riêng trái ri 6 loại A - Nito',
    '101010202004': 'TP cấp đông sầu riêng trái ri 6 loại A - Hàng đóng thùng tạm',
    '101010402004': 'TP cấp đông sầu riêng trái Musaking loại A - Nito - Hàng đóng thùng tạm',
    '101010403004': 'TP cấp đông sầu riêng trái Musaking loại B - Nito - Hàng đóng thùng tạm',
    '102010201001': 'TP cấp đông sầu riêng múi monthong A (1 túi) - Hầm đông',
    '102010201002': 'TP cấp đông sầu riêng múi monthong A (1 túi) - Nito',
    '102010201004': 'TP cấp đông sầu riêng múi monthong A (1 túi) - múi to (>750gram) - Hầm đông',
    '102010201005': 'TP cấp đông sầu riêng múi monthong A (1 túi) - múi nhỏ (< 60 gram) - Hầm đông',
    '102010204001': 'TP cấp đông sầu riêng múi monthong A (4 túi) - Hầm đông',
    '102010301001': 'TP cấp đông sầu riêng múi monthong B (1 túi) - Hầm đông',
    '102010301002': 'TP cấp đông sầu riêng múi monthong B (1 túi) - Nito',
    '102010301004': 'TP cấp đông sầu riêng múi monthong B (1 túi) - múi to (>750gram) - Hầm đông',
    '102010301005': 'TP cấp đông sầu riêng múi monthong B (1 túi) - múi nhỏ (< 60 gram) - Hầm đông',
    '102010304001': 'TP cấp đông sầu riêng múi monthong B (4 túi) - Hầm đông',
    '102010401001': 'TP cấp đông sầu riêng múi monthong C - Hàng không hạt - Hầm đông',
    '102010402001': 'TP cấp đông sầu riêng múi monthong C - Hàng có hạt - Hầm đông',
    '102020201001': 'TP cấp đông sầu riêng múi ri 6 A (1 túi) - Hầm đông',
    '102020204001': 'TP cấp đông sầu riêng múi ri 6 A (4 túi) - Hầm đông',
    '102020301001': 'TP cấp đông sầu riêng múi ri 6 B (1 túi) - Hầm đông',
    '102020304001': 'TP cấp đông sầu riêng múi ri 6 B (4 túi) - Hầm đông',
    '102020401001': 'TP cấp đông sầu riêng múi ri 6 C - Hàng có hạt - Hầm đông',
    '102020402001': 'TP cấp đông sầu riêng múi ri 6 C - Hàng tách hạt - Hầm đông',
    '102020701000': 'TP cấp đông sầu riêng múi ri 6 khay (có hạt)',
    '202010100000': 'TP cấp đông múi mít đỏ loại A',
    '202010200000': 'TP cấp đông múi mít đỏ loại B',
    '202010300000': 'TP cấp đông múi mít đỏ loại C',
    '202010400000': 'TP cấp đông múi mít đỏ loại D',
    '201090200102': 'TP cấp đông xoài Keaw cắt má loại A (Thùng 10 Kg)',
    '201090200302': 'TP cấp đông xoài Keaw cắt má loại B (Thùng 10 Kg)',
    '201090200402': 'TP cấp đông xoài Keaw cắt má loại C (Thùng 10 Kg)',
    '201090200702': 'TP cấp đông xoài Keaw vụn (Thùng 10 Kg)',
    '201090300200': 'TP cấp đông xoài Keaw cắt dice 20x20mm',
    '301010400000': 'TP cấp đông thanh long đỏ 6x6mm',
    '301020200000': 'TP cấp đông thanh long trắng 15x15mm',
    '901010050000': 'TP cấp đông dứa queen (1/2 trái)',
    '901030050000': 'TP cấp đông dứa cayenne (1/2 trái)'
  }
};

/**
 * Làm sạch chuỗi ký tự nhận diện dấu đóng
 */
export function cleanStampNumericString(input: string): string {
  if (!input) return '';
  
  let s = input.trim();
  // Khắc phục lỗi đọc nhầm chữ cái phổ biến của OCR trên bìa carton kraft
  s = s.replace(/[oOQD]/g, '0');
  s = s.replace(/[Il|!]/g, '1');
  s = s.replace(/[Zz]/g, '2');
  s = s.replace(/[S]/g, '5');
  s = s.replace(/[bB]/g, '8');

  // Lọc chỉ giữ chữ số và dấu gạch ngang
  return s.replace(/[^0-9\-]/g, '');
}

/**
 * Giải mã chi tiết 2 dòng dấu đóng sang tiếng Việt
 */
export function decodeStamp(
  line1: string,
  line2: string,
  customDict?: Record<string, Record<string, string>>,
  template?: StampFormat | null
): DecodedStampDetails {
  const dict = customDict || DEFAULT_STAMP_DICTIONARY;
  const result: DecodedStampDetails = {};

  // 1. Giải mã Dòng 1 (Phân cấp sản phẩm)
  const cleanL1 = (line1 || '').trim().replace(/[^0-9\-]/g, '');
  const digitsOnlyL1 = cleanL1.replace(/-/g, '');
  const l1Config = template?.line1_config;

  // 0. KIỂM TRA TRƯỜNG HỢP NGOẠI LỆ ƯU TIÊN (12 KÝ TỰ ĐẦU TIÊN)
  let special12MatchName: string | undefined;
  if (digitsOnlyL1.length >= 12) {
    const code12 = digitsOnlyL1.substring(0, 12);
    const matched = dict.special_12?.[code12] || DEFAULT_STAMP_DICTIONARY.special_12?.[code12];
    if (matched) {
      result.is_special_12 = true;
      result.special_12_code = code12;
      special12MatchName = matched;
    }
  }

  if (l1Config && Array.isArray(l1Config.fields) && l1Config.fields.length > 0) {
    // Dynamic decoding theo cấu hình mẫu
    const delimiter = l1Config.delimiter_char || '-';
    const dashIdx = cleanL1.indexOf(delimiter);

    for (const f of l1Config.fields) {
      let raw = '';
      if (f.afterDelimiter && dashIdx !== -1) {
        raw = cleanL1.substring(dashIdx + 1, dashIdx + 1 + f.length);
      } else {
        raw = digitsOnlyL1.substring(f.start, f.start + f.length);
      }

      if (!raw) continue;

      if (f.key === 'fruit_type') {
        result.fruit_type_code = raw;
        result.fruit_type_name = dict.fruit_type?.[raw] || `Chủng loại ${raw}`;
      } else if (f.key === 'freeze_style') {
        result.freeze_style_code = raw;
        result.freeze_style_name = dict.freeze_style?.[raw] || `Hình thức ${raw}`;
      } else if (f.key === 'variety') {
        result.variety_code = raw;
        result.variety_name = dict.variety?.[raw] || `Giống ${raw}`;
      } else if (f.key === 'product_grade') {
        result.product_grade_code = raw;
        result.product_grade_name = dict.product_grade?.[raw] || `Loại ${raw}`;
      } else if (f.key === 'package_spec') {
        result.package_spec_code = raw;
        result.package_spec_name = dict.package_spec?.[raw] || `${raw} túi/thùng`;
      } else if (f.key === 'freeze_method') {
        result.freeze_method_code = raw;
        result.freeze_method_name = dict.freeze_method?.[raw] || `Phương pháp ${raw}`;
      } else if (f.key === 'customer_quality') {
        result.customer_quality_code = raw;
        result.customer_quality_name = dict.customer_quality?.[raw] || (raw === '0' ? 'Không phân chia' : `Tiêu chuẩn KH ${raw}`);
      }
    }

    result.product_name_full = [
      result.fruit_type_name,
      result.variety_name,
      result.freeze_style_name,
      result.product_grade_name
    ].filter(Boolean).join(' ');
  } else if (digitsOnlyL1.length >= 12) {
    // Fallback mặc định
    const cFruit = digitsOnlyL1.substring(0, 1);
    const cStyle = digitsOnlyL1.substring(1, 3);
    const cVariety = digitsOnlyL1.substring(3, 5);
    const cGrade = digitsOnlyL1.substring(5, 7);
    const cSpec = digitsOnlyL1.substring(7, 9);
    const cMethod = digitsOnlyL1.substring(9, 12);
    
    let cQuality = '0';
    if (cleanL1.includes('-')) {
      const parts = cleanL1.split('-');
      cQuality = parts[parts.length - 1] || '0';
    } else if (digitsOnlyL1.length >= 13) {
      cQuality = digitsOnlyL1.substring(12, 13);
    }

    result.fruit_type_code = cFruit;
    result.fruit_type_name = dict.fruit_type?.[cFruit] || `Chủng loại ${cFruit}`;

    result.freeze_style_code = cStyle;
    result.freeze_style_name = dict.freeze_style?.[cStyle] || `Hình thức ${cStyle}`;

    result.variety_code = cVariety;
    result.variety_name = dict.variety?.[cVariety] || `Giống ${cVariety}`;

    result.product_grade_code = cGrade;
    result.product_grade_name = dict.product_grade?.[cGrade] || `Loại ${cGrade}`;

    result.package_spec_code = cSpec;
    result.package_spec_name = dict.package_spec?.[cSpec] || `${cSpec} túi/thùng`;

    result.freeze_method_code = cMethod;
    result.freeze_method_name = dict.freeze_method?.[cMethod] || `Phương pháp ${cMethod}`;

    result.customer_quality_code = cQuality;
    result.customer_quality_name = dict.customer_quality?.[cQuality] || (cQuality === '0' ? 'Không phân chia' : `Tiêu chuẩn KH ${cQuality}`);

    result.product_name_full = `${result.fruit_type_name} ${result.variety_name} ${result.freeze_style_name} ${result.product_grade_name}`;
  }

  // ⭐ ƯU TIÊN TUYỆT ĐỐI QUY CÁCH NGOẠI LỆ (12 SỐ ĐẦU):
  // Ghi đè trực tiếp tên và quy cách sản phẩm trọn gói từ danh mục ngoại lệ (giống Web Mẹ)
  if (special12MatchName) {
    result.is_special_12 = true;
    result.special_12_name = special12MatchName;
    result.product_name_full = special12MatchName;

    // Phân tách quy cách sản phẩm và phương thức cấp đông từ chuỗi tên ngoại lệ trọn gói
    // VD: "TP cấp đông sầu riêng múi monthong C - Hàng có hạt - Hầm đông"
    // Part 1: "Hàng có hạt"
    // Part 2: "Hầm đông"
    const nameParts = special12MatchName.split(' - ').map((s: string) => s.trim());
    if (nameParts.length >= 3) {
      result.package_spec_name = nameParts[1];
      result.freeze_method_name = nameParts[2];
    } else if (nameParts.length === 2) {
      result.package_spec_name = nameParts[1];
      result.freeze_method_name = '';
    } else {
      result.package_spec_name = 'Ngoại lệ trọn gói';
      result.freeze_method_name = '';
    }
  }

  // 2. Giải mã Dòng 2 (Nguồn gốc & Truy xuất)
  const cleanL2 = (line2 || '').trim().replace(/[^0-9\-]/g, '');
  const digitsOnlyL2 = cleanL2.replace(/-/g, '');
  const l2Config = template?.line2_config;

  if (l2Config && Array.isArray(l2Config.fields) && l2Config.fields.length > 0) {
    // Dynamic decoding theo cấu hình mẫu
    const delimiter2 = l2Config.delimiter_char || '-';
    const dashIdx2 = cleanL2.indexOf(delimiter2);

    for (const f of l2Config.fields) {
      let raw = '';
      if (f.afterDelimiter && dashIdx2 !== -1) {
        raw = cleanL2.substring(dashIdx2 + 1, dashIdx2 + 1 + f.length);
      } else {
        raw = digitsOnlyL2.substring(f.start, f.start + f.length);
      }
      if (!raw) continue;

      if (f.key === 'factory') {
        result.factory_code = raw;
        result.factory_name = dict.factory?.[raw] || `Nhà máy ${raw}`;
      } else if (f.key === 'pkg_date' || f.key === 'packaging_date') {
        const dd = raw.substring(0, 2);
        const mm = raw.substring(2, 4);
        result.packaging_date = `${dd}/${mm}`;
      } else if (f.key === 'inbound_date') {
        const dd = raw.substring(0, 2);
        const mm = raw.substring(2, 4);
        const yy = raw.substring(4, 6);
        result.inbound_date = `${dd}/${mm}/20${yy}`;
        result.raw_material_date = result.inbound_date;
      } else if (f.key === 'supplier') {
        result.supplier_code = raw;
        const declaredSupplier = dict.supplier?.[raw];
        result.supplier_name = declaredSupplier
          ? `${raw} (${declaredSupplier})`
          : (raw ? `Mã NCC ${raw}` : '');
      } else if (f.key === 'province') {
        result.province_code = raw;
        result.province_name = dict.province?.[raw] || `Tỉnh mã ${raw}`;
      }
    }

    result.traceability_full = [
      result.factory_name,
      result.packaging_date ? `ĐG: ${result.packaging_date}` : '',
      result.inbound_date ? `Nhập NL: ${result.inbound_date}` : '',
      result.supplier_name ? `NCC: ${result.supplier_name}` : '',
      result.province_name ? `Vùng: ${result.province_name}` : ''
    ].filter(Boolean).join(' • ');
  } else if (cleanL2.length >= 16) {
    // Fallback mặc định
    const cFactory = cleanL2.substring(0, 1);
    const dd = cleanL2.substring(1, 3);
    const mm = cleanL2.substring(3, 5);
    const DD = cleanL2.substring(5, 7);
    const MM = cleanL2.substring(7, 9);
    const YY = cleanL2.substring(9, 11);
    const cSupplier = cleanL2.substring(11, 14);
    const cProvince = cleanL2.substring(14, 16);

    result.factory_code = cFactory;
    result.factory_name = dict.factory?.[cFactory] || `Nhà máy ${cFactory}`;

    result.packaging_date = `${dd}/${mm}`;
    result.inbound_date = `${DD}/${MM}/20${YY}`;
    result.raw_material_date = `${DD}/${MM}/20${YY}`;

    result.supplier_code = cSupplier;
    const declaredSupplier = dict.supplier?.[cSupplier];
    result.supplier_name = declaredSupplier
      ? `${cSupplier} (${declaredSupplier})`
      : (cSupplier ? `Mã NCC ${cSupplier}` : '');

    result.province_code = cProvince;
    result.province_name = dict.province?.[cProvince] || `Tỉnh mã ${cProvince}`;

    result.traceability_full = `${result.factory_name} • ĐG: ${result.packaging_date} • Nhập NL: ${result.inbound_date} • NCC: ${result.supplier_name} • Vùng: ${result.province_name}`;
  }

  return result;
}

/**
 * Bóc tách 2 dãy số đóng dấu từ văn bản OCR thô và tự động giải mã
 */
export function parseStampText(
  rawText: string,
  customDict?: Record<string, Record<string, string>>,
  template?: StampFormat | null
): ParsedStampData | null {
  if (!rawText) return null;
  const dict = customDict || DEFAULT_STAMP_DICTIONARY;

  const rawLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const numericLines: string[] = [];

  for (const line of rawLines) {
    const cleaned = cleanStampNumericString(line);
    // Giữ các dòng có độ dài đáng kể (tối thiểu 8 ký tự số)
    if (cleaned.replace(/-/g, '').length >= 8) {
      numericLines.push(cleaned);
    }
  }

  // Nếu gom 2 dãy số trên cùng 1 dòng
  const l1Total = template?.line1_config?.total_length || 14;
  if (numericLines.length === 1 && numericLines[0].replace(/-/g, '').length >= 26) {
    const full = numericLines[0];
    const fullDigits = full.replace(/[^0-9]/g, '');
    const isHeadSpecial12 = fullDigits.length >= 12 && !!(dict.special_12?.[fullDigits.substring(0, 12)] || DEFAULT_STAMP_DICTIONARY.special_12?.[fullDigits.substring(0, 12)]);
    
    let l1Cut = l1Total;
    if (isHeadSpecial12) {
      if (full.length > 12 && full[12] === '-') {
        l1Cut = 14; // Có gạch nối và ký tự thứ 14
      } else if (fullDigits.length === 28) {
        l1Cut = 12; // 12 ký tự dòng 1 + 16 ký tự dòng 2
      }
    }

    const l1 = full.slice(0, l1Cut);
    const l2 = full.slice(l1Cut);
    const decoded = decodeStamp(l1, l2, customDict, template);
    return {
      stamp_line1: l1,
      stamp_line2: l2,
      raw_text: rawText,
      detected_lines: [l1, l2],
      decoded
    };
  }

  if (numericLines.length === 0) {
    return null;
  }

  let line1 = '';
  let line2 = '';

  if (numericLines.length >= 2) {
    const d0 = numericLines[0].replace(/[^0-9]/g, '');
    const d1 = numericLines[1].replace(/[^0-9]/g, '');
    const d0IsSpecial = d0.length >= 12 && !!(dict.special_12?.[d0.substring(0, 12)] || DEFAULT_STAMP_DICTIONARY.special_12?.[d0.substring(0, 12)]);
    const d1IsSpecial = d1.length >= 12 && !!(dict.special_12?.[d1.substring(0, 12)] || DEFAULT_STAMP_DICTIONARY.special_12?.[d1.substring(0, 12)]);

    // Đảo ngược vị trí nếu OCR đọc ngược Dòng 2 trước Dòng 1
    if (!d0IsSpecial && d1IsSpecial) {
      line1 = numericLines[1];
      line2 = numericLines[0];
    } else {
      line1 = numericLines[0];
      line2 = numericLines[1];
    }
  } else {
    // Nếu chỉ đọc được 1 dòng, xem nó giống dòng 1 hay dòng 2
    const single = numericLines[0];
    const singleDigits = single.replace(/[^0-9]/g, '');
    const isSpecial12Single = singleDigits.length >= 12 && !!(dict.special_12?.[singleDigits.substring(0, 12)] || DEFAULT_STAMP_DICTIONARY.special_12?.[singleDigits.substring(0, 12)]);
    
    if (isSpecial12Single) {
      line1 = single;
    } else if (single.length >= 15) {
      line2 = single;
    } else {
      line1 = single;
    }
  }

  const decoded = decodeStamp(line1, line2, customDict, template);

  return {
    stamp_line1: line1,
    stamp_line2: line2,
    raw_text: rawText,
    detected_lines: numericLines,
    decoded
  };
}

/**
 * Kiểm tra xem văn bản có chứa dấu đóng hay không
 */
export function isStampContent(rawText: string): boolean {
  if (!rawText) return false;
  const lines = rawText.split('\n');
  for (const line of lines) {
    const cleaned = cleanStampNumericString(line);
    if (cleaned.replace(/-/g, '').length >= 10) {
      return true;
    }
  }
  return false;
}
