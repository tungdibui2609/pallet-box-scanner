export interface Pallet {
  id: string;
  code: string;
  tag?: string | null;
  notes?: string | null;
  target_qty: number;
  scanned_qty: number;
  total_weight: number;
  system_code: string;
  status: 'active' | 'completed';
  sync_status: 'pending' | 'synced' | 'error';
  sync_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoxLabel {
  id: string;
  pallet_id: string;
  sku: string;
  lot_code: string;
  product_name: string;
  box_index: string;
  weight: number;
  unit: string;
  shift_group?: string;
  region?: string;
  production_date?: string;
  packaging_date?: string;
  raw_material_date?: string;
  supplier?: string;
  supplier_name?: string;
  spec?: string;
  raw_text?: string;
  scan_type?: 'label' | 'stamp';
  stamp_line1?: string;
  stamp_line2?: string;
  is_special_12?: boolean;
  special_12_code?: string;
  special_12_name?: string;
  sync_status: 'pending' | 'synced';
  created_at: string;
}

export interface DecodedStampDetails {
  // Ngoại lệ 12 số ưu tiên
  is_special_12?: boolean;
  special_12_code?: string;
  special_12_name?: string;

  // Dòng 1: Phân cấp sản phẩm
  fruit_type_code?: string;
  fruit_type_name?: string;
  freeze_style_code?: string;
  freeze_style_name?: string;
  variety_code?: string;
  variety_name?: string;
  product_grade_code?: string;
  product_grade_name?: string;
  package_spec_code?: string;
  package_spec_name?: string;
  freeze_method_code?: string;
  freeze_method_name?: string;
  customer_quality_code?: string;
  customer_quality_name?: string;

  // Dòng 2: Nguồn gốc & Truy xuất
  factory_code?: string;
  factory_name?: string;
  packaging_date?: string; // dd/mm
  inbound_date?: string;   // DD/MM/20YY
  raw_material_date?: string; // DD/MM/YYYY
  supplier_code?: string;
  supplier_name?: string;
  province_code?: string;
  province_name?: string;

  // Tóm tắt tiếng Việt
  product_name_full?: string;
  traceability_full?: string;
}

export interface StampDictionaryItem {
  category: string;
  code: string;
  name: string;
  description?: string | null;
  sort_order?: number;
}

export interface StampFieldConfig {
  key: string;
  name: string;
  shortName: string;
  start: number;
  length: number;
  type: 'dictionary' | 'date_ddmm' | 'date_ddmmyy' | 'supplier' | 'raw';
  dictCategory?: string;
  format?: string;
  color?: string;
  afterDelimiter?: boolean;
}

export interface StampLineConfig {
  title?: string;
  total_length: number;
  has_delimiter?: boolean;
  delimiter_char?: string;
  sample?: string;
  fields: StampFieldConfig[];
}

export interface StampFormat {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  is_default?: boolean;
  is_active?: boolean;
  line1_config: StampLineConfig;
  line2_config: StampLineConfig;
  updated_at?: string;
}

export interface ParsedStampData {
  stamp_line1: string;
  stamp_line2: string;
  raw_text: string;
  detected_lines: string[];
  decoded?: DecodedStampDetails;
}

export interface ParsedLabelData {
  sku: string;
  lot_code: string;
  product_name: string;
  box_index: string;
  weight: number;
  unit: string;
  shift_group: string;
  region: string;
  production_date: string;
  packaging_date: string;
  spec: string;
  raw_text: string;
}

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  systemCode: string;
  defaultTargetQty: number;
}

export interface CloudPallet {
  id: string;
  stt: string;
  lot_code: string | null;
  lot_id: string | null;
  boxes_count: number;
  total_weight: number;
  is_linked: boolean;
  status?: string | null;
  product_name?: string | null;
  sku?: string | null;
  product_aliases?: string | null;
  tag?: string | null;
  notes?: string | null;
  production_place?: string | null;
  material_zone?: string | null;
  packaging_date?: string | null;
  production_date?: string | null;
  location_code?: string | null;
  scan_type?: 'label' | 'stamp';
  is_special_12?: boolean;
  created_at: string;
}

export interface CloudFilterCriteria {
  productName?: string;
  productionPlace?: string;
  materialZone?: string;
  packagingDate?: string;
  productionDate?: string;
  locationCode?: string;
  statusFilter?: 'all' | 'linked' | 'unlinked' | 'exported';
}