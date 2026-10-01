export interface Pallet {
  id: string;
  code: string;
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
  spec?: string;
  raw_text?: string;
  sync_status: 'pending' | 'synced';
  created_at: string;
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