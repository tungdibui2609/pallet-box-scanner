import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabaseClient } from './supabase';
import { getProductsFromCache } from './database';

export interface ShiftProductItem {
  id: string;
  name: string;
  sku?: string | null;
  unit?: string | null;
  weight_kg?: number | null;
  aliases?: string | null;
  internal_code?: string | null;
  internal_name?: string | null;
  available_units?: string[];
}

export interface DeliveryShift {
  id: string;
  system_code: string;
  company_id?: string | null;
  status: 'open' | 'closed';
  opened_by?: string | null;
  opened_by_name?: string | null;
  opened_at: string;
  closed_by?: string | null;
  closed_by_name?: string | null;
  closed_at?: string | null;
  notes?: string | null;
  summary_data?: {
    job_name?: string;
    job_notes?: string | null;
    template_id?: string | null;
    pinned_products?: ShiftProductItem[];
    order_type_id?: string | null;
    order_type_name?: string | null;
    order_type_code?: string | null;
    products_summary?: Record<string, any>;
    units_summary?: Record<string, any>;
    [key: string]: any;
  } | null;
}

export interface SubShift {
  id: string;
  shift_id: string;
  system_code: string;
  company_id?: string | null;
  sub_shift_number: number;
  from_time: string;
  to_time: string;
  closed_by?: string | null;
  closed_by_name?: string | null;
  notes?: string | null;
  summary_data?: any;
}

export interface JournalRecord {
  id: string;
  delivery_code?: string | null;
  item_name: string;
  quantity_sent: number;
  unit: string;
  from_department: string;
  to_department: string;
  status: string;
  notes: string | null;
  sent_by_name: string | null;
  sent_at: string;
  system_code?: string | null;
}

export interface OrderTypeItem {
  id: string;
  code: string | null;
  name: string;
  scope?: string | null;
  system_code?: string | null;
  is_active?: boolean;
}

export interface JobTemplate {
  id: string;
  name: string;
  notes?: string | null;
  pinned_product_ids?: string[];
  company_id?: string | null;
  system_code?: string;
  order_index?: number;
}

export interface AggregatedProductJob {
  id: string;
  name: string;
  in_qty: number;
  out_qty: number;
}

export interface AggregatedProductItem {
  product_id?: string;
  sku?: string;
  product_name: string;
  unit: string;
  in_qty: number;
  out_qty: number;
  count: number;
  jobs: AggregatedProductJob[];
}

export interface AggregatedUnitItem {
  unit: string;
  in_qty: number;
  out_qty: number;
  count: number;
}

// Lấy system_code kho hiện tại
export async function getCurrentSystemCode(): Promise<string> {
  const code = await AsyncStorage.getItem('config_system_code');
  return code || 'KHO_DONG_LANH';
}

// Định danh phân hệ số liệu (ví dụ: KHO_DONG_LANH__solieu)
export function getShiftSystemCode(systemCode: string): string {
  return `${systemCode}__solieu`;
}

// 1. Tải danh sách công việc đang mở (Status: 'open')
export async function getOpenShifts(): Promise<DeliveryShift[]> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);

  const { data, error } = await supabase
    .from('delivery_shifts')
    .select('*')
    .eq('system_code', shiftSys)
    .eq('status', 'open')
    .order('opened_at', { ascending: false });

  if (error) {
    console.warn('Lỗi lấy danh sách ca đang mở:', error);
    return [];
  }
  return data || [];
}

// 2. Tải danh sách công việc đã đóng (Status: 'closed')
export async function getPastShifts(limit = 50): Promise<DeliveryShift[]> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);

  const { data, error } = await supabase
    .from('delivery_shifts')
    .select('*')
    .eq('system_code', shiftSys)
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('Lỗi lấy danh sách ca đã đóng:', error);
    return [];
  }
  return data || [];
}

// 3. Tải danh sách loại phiếu theo phân hệ
export async function getOrderTypes(): Promise<OrderTypeItem[]> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();

  const { data, error } = await supabase
    .from('order_types')
    .select('id, code, name, scope, system_code, is_active')
    .eq('system_code', baseSys)
    .eq('is_active', true)
    .order('code', { ascending: true });

  if (error) {
    console.warn('Lỗi lấy loại phiếu:', error);
    return [];
  }
  return data || [];
}

// 3.1 Tải danh sách công việc mẫu (Job Templates)
export async function getJobTemplates(): Promise<JobTemplate[]> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const cleanCode = baseSys ? baseSys.trim().replace(/__solieu$/, '') : 'COLD';

  try {
    const { data, error } = await (supabase as any)
      .from('delivery_job_templates')
      .select('*')
      .eq('system_code', cleanCode)
      .order('order_index', { ascending: true })
      .order('created_at', { ascending: true });

    if (!error && Array.isArray(data)) {
      return data.map((row: any) => ({
        id: row.id,
        name: row.name,
        notes: row.notes,
        pinned_product_ids: Array.isArray(row.pinned_product_ids) ? row.pinned_product_ids : [],
        company_id: row.company_id,
        system_code: row.system_code,
        order_index: row.order_index,
      }));
    }
    if (error) {
      console.warn('Lỗi lấy công việc mẫu SQL:', error);
    }
  } catch (e) {
    console.warn('Lỗi query delivery_job_templates:', e);
  }
  return [];
}

// 4. Mở ca công việc mới
export async function createShift(params: {
  jobName: string;
  notes?: string;
  openedAt?: string;
  pinnedProducts?: ShiftProductItem[];
  orderTypeId?: string | null;
  orderTypeName?: string | null;
  orderTypeCode?: string | null;
  templateId?: string | null;
  user: any;
}): Promise<DeliveryShift | null> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);

  const openedAtIso = params.openedAt ? new Date(params.openedAt).toISOString() : new Date().toISOString();

  const payload = {
    system_code: shiftSys,
    company_id: params.user?.company_id || null,
    status: 'open',
    opened_by: params.user?.id || null,
    opened_by_name: params.user?.full_name || 'Nhân viên kho',
    opened_at: openedAtIso,
    notes: params.jobName.trim(),
    summary_data: {
      job_name: params.jobName.trim(),
      job_notes: params.notes?.trim() || null,
      template_id: params.templateId || null,
      pinned_products: params.pinnedProducts || [],
      order_type_id: params.orderTypeId || null,
      order_type_name: params.orderTypeName || null,
      order_type_code: params.orderTypeCode || null,
    }
  };

  const { data, error } = await supabase
    .from('delivery_shifts')
    .insert([payload])
    .select()
    .single();

  if (error) {
    console.error('Lỗi tạo ca mới:', error);
    throw error;
  }
  return data;
}

// 5. Tải nhật ký số liệu của 1 ca (Lọc nghiêm ngặt theo CV_ID)
export async function getShiftJournals(shiftId: string): Promise<JournalRecord[]> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);

  const { data, error } = await supabase
    .from('delivery_journal')
    .select('*')
    .or(`system_code.eq.${shiftSys},system_code.eq.${baseSys}`)
    .ilike('notes', `%[CV_ID: ${shiftId}]%`)
    .order('sent_at', { ascending: false });

  if (error) {
    console.warn('Lỗi tải nhật ký ca:', error);
    return [];
  }
  return data || [];
}

// 6. Ghi nhận 1 lượt Nhập / Xuất (Journal Entry)
export async function submitJournalEntry(params: {
  shift: DeliveryShift;
  product: ShiftProductItem;
  quantity: number;
  unit: string;
  type: 'in' | 'out';
  user: any;
  userNote?: string;
}): Promise<boolean> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);
  const isImport = params.type === 'in';
  const nowIso = new Date().toISOString();
  const jobName = params.shift.summary_data?.job_name || params.shift.notes || 'Công việc';

  const notesTag = `[CV_ID: ${params.shift.id}] [PID: ${params.product.id}] [SKU: ${params.product.sku || ''}] [CV: ${jobName}] ${isImport ? 'Nhập kho' : 'Xuất kho'}${params.userNote ? ` - ${params.userNote.trim()}` : ''}`;

  const companyId = params.user?.company_id || params.shift.company_id || null;

  const payload = {
    delivery_code: `SO-LIEU-${Date.now().toString().slice(-6)}`,
    company_id: companyId,
    system_code: shiftSys,
    item_name: params.product.name,
    quantity_sent: params.quantity,
    unit: params.unit,
    from_department: isImport ? 'Sản xuất' : 'Kho',
    to_department: isImport ? 'Kho' : 'Sản xuất',
    status: isImport ? 'received_by_warehouse' : 'received_by_production',
    notes: notesTag,

    sent_by: params.user?.id || null,
    sent_by_name: params.user?.full_name || 'Nhân viên kho',
    sent_at: nowIso,

    received_by_warehouse: isImport ? (params.user?.id || null) : null,
    received_by_warehouse_name: isImport ? (params.user?.full_name || 'Nhân viên kho') : null,
    received_by_warehouse_at: isImport ? nowIso : null,

    received_by_production: !isImport ? (params.user?.id || null) : null,
    received_by_production_name: !isImport ? (params.user?.full_name || 'Nhân viên kho') : null,
    received_by_production_at: !isImport ? nowIso : null,

    result_item_name: params.product.name,
    result_quantity: params.quantity,
    result_unit: params.unit,

    created_by: params.user?.id || null,
    created_by_name: params.user?.full_name || null,
  };

  const { error } = await supabase
    .from('delivery_journal')
    .insert([payload]);

  if (error) {
    console.error('Lỗi ghi nhật ký:', error);
    throw error;
  }
  return true;
}

// 6.1 Cập nhật một dòng nhật ký (Sửa lượt bấm)
export async function updateJournalEntry(params: {
  id: string;
  quantity: number;
  unit: string;
  type: 'in' | 'out';
  notes?: string;
  shiftId: string;
}): Promise<boolean> {
  const supabase = await getSupabaseClient();
  const isImport = params.type === 'in';
  const existingNotes = params.notes || '';
  const cvTag = `[CV_ID: ${params.shiftId}]`;
  const cleanNotes = existingNotes.includes(cvTag) ? existingNotes : `${cvTag} ${existingNotes}`.trim();

  const payload = {
    quantity_sent: params.quantity,
    unit: params.unit,
    result_quantity: params.quantity,
    result_unit: params.unit,
    from_department: isImport ? 'Sản xuất' : 'Kho',
    to_department: isImport ? 'Kho' : 'Sản xuất',
    status: isImport ? 'received_by_warehouse' : 'received_by_production',
    notes: cleanNotes,
  };

  const { error } = await supabase
    .from('delivery_journal')
    .update(payload)
    .eq('id', params.id);

  if (error) {
    console.error('Lỗi cập nhật dòng nhật ký:', error);
    throw error;
  }
  return true;
}

// 6.2 Xóa một dòng nhật ký (Xóa lượt bấm nhầm)
export async function deleteJournalEntry(id: string): Promise<boolean> {
  const supabase = await getSupabaseClient();
  const { error } = await supabase
    .from('delivery_journal')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Lỗi xóa lượt ghi nhận:', error);
    throw error;
  }
  return true;
}

// 7. Đồng bộ danh sách ghim lên ca công việc
export async function syncPinnedProducts(shiftId: string, currentSummary: any, pinned: ShiftProductItem[]): Promise<void> {
  const supabase = await getSupabaseClient();
  const nextSummary = {
    ...(currentSummary || {}),
    pinned_products: pinned,
  };
  await supabase
    .from('delivery_shifts')
    .update({ summary_data: nextSummary })
    .eq('id', shiftId);
}

// 8. Chốt sổ hoàn thành ca công việc
export async function closeShift(params: {
  shiftId: string;
  jobName: string;
  closeNotes: string;
  orderTypeId?: string | null;
  orderTypeName?: string | null;
  orderTypeCode?: string | null;
  user: any;
}): Promise<boolean> {
  const supabase = await getSupabaseClient();
  const closedAtIso = new Date().toISOString();

  // 1. Tính tổng các mặt hàng đã nhập xuất trong ca
  const journals = await getShiftJournals(params.shiftId);
  const productsSummary: Record<string, { product_name: string; unit: string; in_qty: number; out_qty: number }> = {};
  const unitsSummary: Record<string, { sent: number; received: number }> = {};

  journals.forEach(j => {
    const u = j.unit || 'Kg';
    const name = j.item_name;
    const isImport = j.to_department === 'Kho';
    const qty = Number(j.quantity_sent) || 0;

    if (!unitsSummary[u]) unitsSummary[u] = { sent: 0, received: 0 };
    if (isImport) unitsSummary[u].received += qty;
    else unitsSummary[u].sent += qty;

    const key = `${name}_${u}`;
    if (!productsSummary[key]) productsSummary[key] = { product_name: name, unit: u, in_qty: 0, out_qty: 0 };
    if (isImport) productsSummary[key].in_qty += qty;
    else productsSummary[key].out_qty += qty;
  });

  const payload = {
    status: 'closed',
    closed_by: params.user?.id || null,
    closed_by_name: params.user?.full_name || 'Nhân viên kho',
    closed_at: closedAtIso,
    notes: params.closeNotes ? `[CV: ${params.jobName}] ${params.closeNotes}` : `[CV: ${params.jobName}] Hoàn thành công việc`,
    summary_data: {
      job_name: params.jobName,
      from_time: journals.length > 0 ? journals[journals.length - 1].sent_at : closedAtIso,
      to_time: closedAtIso,
      total_records: journals.length,
      units_summary: unitsSummary,
      products_summary: productsSummary,
      order_type_id: params.orderTypeId || null,
      order_type_name: params.orderTypeName || null,
      order_type_code: params.orderTypeCode || null,
    }
  };

  const { error } = await supabase
    .from('delivery_shifts')
    .update(payload)
    .eq('id', params.shiftId);

  if (error) {
    console.error('Lỗi chốt ca:', error);
    throw error;
  }
  return true;
}

// Helper format hậu tố trọng lượng (Ví dụ: Thùng (20kg), Thùng (10kg))
export function formatUnitWeight(unitName: string | null | undefined, weight: number): string {
  if (!unitName) return '';
  const baseUnitName = unitName.split('(')[0].trim();
  const normBase = baseUnitName.toLowerCase();
  if (['kg', 'kilogram', 'kgs', 'kilo'].includes(normBase)) return baseUnitName;
  if (weight > 0) {
    const cleanWeight = Number(Number(weight).toFixed(4));
    return `${baseUnitName} (${cleanWeight}kg)`;
  }
  // Mặc định tiêu chuẩn kho đông cho đơn vị Thùng nếu chưa có trọng lượng cấu hình
  if (normBase.includes('thùng') || normBase.startsWith('thung')) {
    return `${baseUnitName} (20kg)`;
  }
  return baseUnitName;
}

// Helper loại bỏ hậu tố để so khớp linh hoạt giữa "Thùng (20kg)" và "Thùng"
export function normalizeUnitMatch(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\(\d+(?:[.,]\d+)?k?g?\)/g, '');
}

// 9. Lấy danh mục tất cả sản phẩm
export async function getWarehouseProducts(): Promise<ShiftProductItem[]> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();

  try {
    let productsQuery = (supabase as any)
      .from('products')
      .select('id, name, sku, unit, weight_kg, aliases, internal_code, internal_name')
      .order('name', { ascending: true });

    if (baseSys) {
      productsQuery = productsQuery.or(`system_code.eq.${baseSys},system_type.eq.${baseSys}`);
    }

    const [productsRes, unitsRes, prodUnitsRes] = await Promise.all([
      productsQuery.limit(2000),
      supabase.from('units').select('id, name').limit(1000),
      supabase.from('product_units').select('product_id, unit_id, conversion_rate').limit(5000),
    ]);

    const products = productsRes.data || [];
    const unitsList = unitsRes.data || [];
    const prodUnitsList = prodUnitsRes.data || [];

    if (products.length > 0) {
      return products.map((product: any) => {
        const baseUnit = (product.unit || '').trim();
        let baseWeight = Number(product.weight_kg) || 0;
        const normBase = baseUnit.toLowerCase();
        if (baseWeight <= 0 && ['kg', 'kilogram'].includes(normBase)) {
          baseWeight = 1;
        }

        const availableUnitsSet = new Set<string>();
        const formattedBaseUnit = formatUnitWeight(baseUnit, baseWeight);
        if (baseUnit) availableUnitsSet.add(formattedBaseUnit);

        const pUnitsOfProduct = prodUnitsList.filter((pu: any) => pu.product_id === product.id);
        pUnitsOfProduct.forEach((pu: any) => {
          const u = unitsList.find((unit: any) => unit.id === pu.unit_id);
          if (u) {
            const normU = u.name.toLowerCase();
            if (normU === normBase) return;
            const weight = (Number(pu.conversion_rate) || 1) * (baseWeight || 1);
            const labelStr = formatUnitWeight(u.name, weight);
            availableUnitsSet.add(labelStr);
          }
        });

        const rawList = Array.from(availableUnitsSet);
        const sortedUnits = rawList.sort((a, b) => {
          const aIs = a.toLowerCase().includes('thùng') || a.toLowerCase().startsWith('thung');
          const bIs = b.toLowerCase().includes('thùng') || b.toLowerCase().startsWith('thung');
          if (aIs && !bIs) return -1;
          if (!aIs && bIs) return 1;
          return 0;
        });

        const thungOption = sortedUnits.find(u => u.toLowerCase().includes('thùng'));
        const finalUnit = thungOption || formattedBaseUnit || product.unit || 'Kg';

        return {
          id: product.id,
          name: product.name,
          sku: product.sku,
          unit: finalUnit,
          weight_kg: product.weight_kg,
          aliases: product.aliases,
          available_units: sortedUnits.length > 0 ? sortedUnits : [finalUnit, 'Kg'],
        };
      });
    }
  } catch (e) {
    console.warn('Lỗi lấy danh mục sản phẩm từ Supabase:', e);
  }

  // Fallback từ Cache SQLite nếu offline
  try {
    const cached = await getProductsFromCache();
    if (cached && cached.length > 0) {
      return cached.map((p: any) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        unit: 'Thùng (20kg)',
        weight_kg: p.weight_kg,
        aliases: p.aliases,
        available_units: ['Thùng (20kg)', 'Kg'],
      }));
    }
  } catch {}

  return [];
}

// 10. Tải danh sách các đợt chốt tạm (Sub-Shifts)
export async function getSubShifts(shiftId: string): Promise<SubShift[]> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);

  const { data, error } = await supabase
    .from('delivery_sub_shifts')
    .select('*')
    .eq('shift_id', shiftId)
    .or(`system_code.eq.${shiftSys},system_code.eq.${baseSys}`)
    .order('sub_shift_number', { ascending: true });

  if (error) {
    console.warn('Lỗi lấy danh sách chốt tạm:', error);
    return [];
  }
  return data || [];
}

// 11. Thực hiện Chốt Ca Tạm (Interim Close / Sub-Shift)
export async function createSubShift(params: {
  shift: DeliveryShift;
  notes?: string;
  user: any;
}): Promise<SubShift | null> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);
  const companyId = params.user?.company_id || params.shift.company_id || null;

  // 1. Lấy danh sách các đợt chốt tạm hiện có
  const existingSubShifts = await getSubShifts(params.shift.id);
  const lastSub = existingSubShifts[existingSubShifts.length - 1];
  const fromTime = lastSub ? lastSub.to_time : params.shift.opened_at;
  const toTime = new Date().toISOString();
  const nextSubNumber = existingSubShifts.length + 1;

  // 2. Lấy các bản ghi trong đợt tạm này
  const { data: records } = await supabase
    .from('delivery_journal')
    .select('*')
    .eq('system_code', shiftSys)
    .ilike('notes', `%[CV_ID: ${params.shift.id}]%`)
    .gte('sent_at', fromTime)
    .lte('sent_at', toTime);

  const lines = records || [];
  const prodMap: Record<string, any> = {};
  const unitMap: Record<string, any> = {};

  lines.forEach((l: any) => {
    const u = l.unit || 'Kg';
    const name = l.item_name;
    const isImport = l.to_department === 'Kho';
    const qty = Number(l.quantity_sent || l.result_quantity) || 0;

    if (!unitMap[u]) unitMap[u] = { sent: 0, received: 0 };
    if (isImport) unitMap[u].received += qty;
    else unitMap[u].sent += qty;

    const key = `${name}_${u}`;
    if (!prodMap[key]) prodMap[key] = { product_name: name, unit: u, in_qty: 0, out_qty: 0, count: 0 };
    if (isImport) prodMap[key].in_qty += qty;
    else prodMap[key].out_qty += qty;
    prodMap[key].count += 1;
  });

  const payload = {
    shift_id: params.shift.id,
    system_code: shiftSys,
    company_id: companyId,
    sub_shift_number: nextSubNumber,
    from_time: fromTime,
    to_time: toTime,
    closed_by: params.user?.id || null,
    closed_by_name: params.user?.full_name || 'Nhân viên kho',
    notes: params.notes?.trim() || `Chốt đợt ${nextSubNumber}`,
    summary_data: {
      total_records: lines.length,
      products_summary: prodMap,
      units_summary: unitMap,
    },
  };

  const { data, error } = await supabase
    .from('delivery_sub_shifts')
    .insert([payload])
    .select()
    .single();

  if (error) {
    console.error('Lỗi tạo đợt chốt tạm:', error);
    throw error;
  }
  return data;
}

// 12. Mở lại ca đã hoàn thành (Reopen)
export async function reopenShift(shiftId: string): Promise<boolean> {
  const supabase = await getSupabaseClient();
  const { error } = await supabase
    .from('delivery_shifts')
    .update({ status: 'open', closed_at: null, closed_by: null, closed_by_name: null })
    .eq('id', shiftId);

  if (error) throw error;
  return true;
}

// 13. Xóa ca công việc và toàn bộ nhật ký liên quan
export async function deleteShift(shiftId: string): Promise<boolean> {
  const supabase = await getSupabaseClient();
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);

  await supabase.from('delivery_journal').delete().or(`system_code.eq.${shiftSys},system_code.eq.${baseSys}`).ilike('notes', `%[CV_ID: ${shiftId}]%`);
  await supabase.from('delivery_sub_shifts').delete().eq('shift_id', shiftId);
  const { error } = await supabase.from('delivery_shifts').delete().eq('id', shiftId);

  if (error) throw error;
  return true;
}

// 14. Tải nhật ký số liệu của nhiều ca (Dùng cho Báo cáo theo ngày & Báo cáo tùy chọn)
export async function getMultiShiftJournals(shiftIds: string[]): Promise<JournalRecord[]> {
  if (!shiftIds || shiftIds.length === 0) return [];
  try {
    const list = await Promise.all(shiftIds.map(id => getShiftJournals(id)));
    return list.flat();
  } catch (e) {
    console.warn('Lỗi getMultiShiftJournals:', e);
    return [];
  }
}

// Helper tổng hợp các dòng nhật ký của 1 ca
function summarizeShiftLines(
  lines: JournalRecord[],
  shift?: DeliveryShift,
  catalog?: ShiftProductItem[]
): {
  product_id?: string;
  sku?: string;
  product_name: string;
  unit: string;
  in_qty: number;
  out_qty: number;
  count: number;
}[] {
  const pinnedList: ShiftProductItem[] = shift?.summary_data?.pinned_products || [];
  const allProds: ShiftProductItem[] = catalog || [];
  const map: Record<string, {
    product_id?: string;
    sku?: string;
    product_name: string;
    unit: string;
    in_qty: number;
    out_qty: number;
    count: number;
  }> = {};

  lines.forEach(l => {
    // Trích xuất product_id từ tag [PID: ...] nếu có trong ghi chú
    const pidMatch = (l.notes || '').match(/\[PID:\s*([^\]]+)\]/i);
    const extractedPid = pidMatch ? pidMatch[1].trim() : undefined;

    // Đối soát trong pinned_products hoặc catalog
    const matched = (extractedPid ? pinnedList.find(p => p.id === extractedPid) : null) ||
      pinnedList.find(p => (p.name || '').trim().toLowerCase() === (l.item_name || '').trim().toLowerCase()) ||
      (extractedPid ? allProds.find(p => p.id === extractedPid) : null) ||
      allProds.find(p => (p.name || '').trim().toLowerCase() === (l.item_name || '').trim().toLowerCase());

    const finalPid = extractedPid || matched?.id;
    const finalSku = matched?.sku;
    const productName = matched?.name || l.item_name;

    const u = l.unit || 'ĐVT';
    const key = finalPid ? `${finalPid}___${u}` : `${l.item_name}___${u}`;
    if (!map[key]) {
      map[key] = {
        product_id: finalPid,
        sku: finalSku || undefined,
        product_name: productName,
        unit: u,
        in_qty: 0,
        out_qty: 0,
        count: 0,
      };
    }
    const qty = Number(l.quantity_sent) || 0;
    if (l.to_department === 'Kho') {
      map[key].in_qty += qty;
    } else {
      map[key].out_qty += qty;
    }
    map[key].count += 1;
  });

  return Object.values(map);
}

// 15. Hàm gom số liệu mặt hàng tổng hợp từ nhiều công việc (Chuẩn xác 100% như Web)
export function aggregateShiftsProducts(
  shifts: DeliveryShift[],
  lines: JournalRecord[],
  allProducts?: ShiftProductItem[]
): AggregatedProductItem[] {
  const prodMap: Record<string, AggregatedProductItem> = {};

  shifts.forEach((s, sIdx) => {
    const jobName = s.summary_data?.job_name ||
      s.notes?.replace(/\[CV:[^\]]*\]/g, '').replace(/\[CV_ID:[^\]]*\]/g, '').trim() ||
      `Công việc #${sIdx + 1}`;

    const sLines = lines.filter(l => (l.notes || '').includes(`[CV_ID: ${s.id}]`));
    const rawProds = sLines.length > 0
      ? summarizeShiftLines(sLines, s, allProducts)
      : Object.values(s.summary_data?.products_summary || {}).map((p: any) => ({
          product_id: p.product_id,
          sku: p.sku || '',
          product_name: p.product_name,
          unit: p.unit,
          in_qty: Number(p.in_qty) || 0,
          out_qty: Number(p.out_qty) || 0,
          count: (Number(p.in_count) || 0) + (Number(p.out_count) || 0),
        }));

    rawProds.forEach(p => {
      const u = p.unit || 'ĐVT';
      const key = `${(p.product_name || '').trim()}___${u}`;
      const inQ = Number(p.in_qty) || 0;
      const outQ = Number(p.out_qty) || 0;

      if (!prodMap[key]) {
        prodMap[key] = {
          product_id: p.product_id,
          sku: p.sku || '',
          product_name: p.product_name,
          unit: u,
          in_qty: 0,
          out_qty: 0,
          count: 0,
          jobs: [],
        };
      }
      prodMap[key].in_qty += inQ;
      prodMap[key].out_qty += outQ;
      prodMap[key].count += Number(p.count) || 1;

      // Ghi nhận tên công việc chứa sản phẩm này
      const existingJob = prodMap[key].jobs.find(j => j.id === s.id);
      if (!existingJob) {
        prodMap[key].jobs.push({
          id: s.id,
          name: jobName,
          in_qty: inQ,
          out_qty: outQ,
        });
      } else {
        existingJob.in_qty += inQ;
        existingJob.out_qty += outQ;
      }
    });
  });

  return Object.values(prodMap);
}

// 16. Gom nhóm tổng hợp theo ĐVT
export function aggregateShiftsUnits(products: AggregatedProductItem[]): AggregatedUnitItem[] {
  const unitMap: Record<string, AggregatedUnitItem> = {};
  products.forEach(r => {
    const u = r.unit || 'ĐVT';
    if (!unitMap[u]) {
      unitMap[u] = { unit: u, in_qty: 0, out_qty: 0, count: 0 };
    }
    unitMap[u].in_qty += r.in_qty;
    unitMap[u].out_qty += r.out_qty;
    unitMap[u].count += r.count;
  });
  return Object.values(unitMap);
}

