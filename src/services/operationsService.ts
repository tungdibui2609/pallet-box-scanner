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
    is_offline?: boolean;
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
  is_offline?: boolean;
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

// ── CÁC HẰNG SỐ & HÀNG ĐỢI OFFLINE STORAGE ─────────────────────────
const OP_CACHE_OPEN_SHIFTS_KEY = 'solieu_cache_open_shifts';
const OP_CACHE_PAST_SHIFTS_KEY = 'solieu_cache_past_shifts';
const OP_CACHE_JOURNALS_PREFIX = 'solieu_cache_journals_';
const OP_CACHE_SUB_SHIFTS_PREFIX = 'solieu_cache_sub_shifts_';
const OP_CACHE_PRODUCTS_KEY = 'solieu_cache_products';
const OP_CACHE_TEMPLATES_KEY = 'solieu_cache_job_templates';
const OP_CACHE_ORDER_TYPES_KEY = 'solieu_cache_order_types';
const OP_OFFLINE_QUEUE_KEY = 'solieu_offline_queue_v1';

// CỜ PHÁT HIỆN OFFLINE TỨC THÌ (FAST OFFLINE FLAG - 0MS LAG TRONG KHO ĐÔNG)
let isKnownOffline = false;
let lastOfflineDetectedAt = 0;
const OFFLINE_RECHECK_INTERVAL = 45000; // 45 giây sau mới thử lại mạng để tránh delay

export function setKnownOffline(offline: boolean) {
  isKnownOffline = offline;
  if (offline) {
    lastOfflineDetectedAt = Date.now();
  }
}

export function isOfflineDetected(): boolean {
  if (!isKnownOffline) return false;
  // Nếu đã qua 45 giây kể từ lúc phát hiện offline, cho phép thử lại mạng 1 lần
  if (Date.now() - lastOfflineDetectedAt > OFFLINE_RECHECK_INTERVAL) {
    isKnownOffline = false;
    return false;
  }
  return true;
}

export type OperationsActionType =
  | 'CREATE_SHIFT'
  | 'SUBMIT_JOURNAL'
  | 'UPDATE_JOURNAL'
  | 'DELETE_JOURNAL'
  | 'CLOSE_SHIFT'
  | 'REOPEN_SHIFT'
  | 'DELETE_SHIFT'
  | 'SYNC_PINNED';

export interface OperationsQueueAction {
  id: string;
  type: OperationsActionType;
  payload: any;
  timestamp: number;
  shiftId?: string;
  retryCount?: number;
}

// Helper bọc timeout cho các lệnh mạng để không bị treo khi vào kho lạnh (mặc định 1000ms siêu tốc)
async function withNetworkTimeout<T = any>(promise: Promise<T> | any, ms = 1000): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      setKnownOffline(true);
      reject(new Error('NETWORK_TIMEOUT_COLD_ROOM'));
    }, ms);
  });
  try {
    const res = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer);
    return res as T;
  } catch (err) {
    clearTimeout(timer);
    setKnownOffline(true);
    throw err;
  }
}

// Lấy danh sách hành động đang chờ đẩy lên Supabase
export async function getOfflineOperationsQueue(): Promise<OperationsQueueAction[]> {
  try {
    const raw = await AsyncStorage.getItem(OP_OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

// Lưu danh sách hàng đợi offline
export async function saveOfflineOperationsQueue(queue: OperationsQueueAction[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OP_OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn('Lỗi lưu hàng đợi offline số liệu:', e);
  }
}

// Thêm 1 hành động vào hàng đợi
export async function addToOfflineOperationsQueue(
  action: Omit<OperationsQueueAction, 'id' | 'timestamp'>
): Promise<OperationsQueueAction> {
  const queue = await getOfflineOperationsQueue();
  const newAction: OperationsQueueAction = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: Date.now(),
    retryCount: 0,
    ...action,
  };
  queue.push(newAction);
  await saveOfflineOperationsQueue(queue);
  return newAction;
}

// Lấy số lượng thao tác đang chờ đồng bộ lên máy chủ
export async function getPendingOperationsCount(): Promise<number> {
  const queue = await getOfflineOperationsQueue();
  return queue.length;
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

// Helper quản lý Cache Ca Đang Mở
async function getCachedOpenShifts(): Promise<DeliveryShift[]> {
  try {
    const raw = await AsyncStorage.getItem(OP_CACHE_OPEN_SHIFTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function setCachedOpenShifts(shifts: DeliveryShift[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OP_CACHE_OPEN_SHIFTS_KEY, JSON.stringify(shifts));
  } catch (e) {
    console.warn('Lỗi lưu cache open shifts:', e);
  }
}

// Helper quản lý Cache Ca Đã Hoàn Thành
async function getCachedPastShifts(): Promise<DeliveryShift[]> {
  try {
    const raw = await AsyncStorage.getItem(OP_CACHE_PAST_SHIFTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function setCachedPastShifts(shifts: DeliveryShift[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OP_CACHE_PAST_SHIFTS_KEY, JSON.stringify(shifts));
  } catch (e) {
    console.warn('Lỗi lưu cache past shifts:', e);
  }
}

// Helper quản lý Cache Nhật ký theo Ca
async function getCachedJournals(shiftId: string): Promise<JournalRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(`${OP_CACHE_JOURNALS_PREFIX}${shiftId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function setCachedJournals(shiftId: string, journals: JournalRecord[]): Promise<void> {
  try {
    await AsyncStorage.setItem(`${OP_CACHE_JOURNALS_PREFIX}${shiftId}`, JSON.stringify(journals));
  } catch (e) {
    console.warn('Lỗi lưu cache journals:', e);
  }
}

// Helper quản lý Cache Chốt Tạm (Sub-Shifts)
async function getCachedSubShifts(shiftId: string): Promise<SubShift[]> {
  try {
    const raw = await AsyncStorage.getItem(`${OP_CACHE_SUB_SHIFTS_PREFIX}${shiftId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function setCachedSubShifts(shiftId: string, subShifts: SubShift[]): Promise<void> {
  try {
    await AsyncStorage.setItem(`${OP_CACHE_SUB_SHIFTS_PREFIX}${shiftId}`, JSON.stringify(subShifts));
  } catch (e) {
    console.warn('Lỗi lưu cache sub-shifts:', e);
  }
}

// 1. Tải danh sách công việc đang mở (Status: 'open') - Offline-First
export async function getOpenShifts(): Promise<DeliveryShift[]> {
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);
  const cached = await getCachedOpenShifts();
  const queue = await getOfflineOperationsQueue();

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await withNetworkTimeout(
      supabase
        .from('delivery_shifts')
        .select('*')
        .eq('system_code', shiftSys)
        .eq('status', 'open')
        .order('opened_at', { ascending: false }),
      2500
    );

    if (!error && Array.isArray(data)) {
      // Merge với các ca tạo offline đang chờ sync trong queue
      const offlineCreatedShifts = queue
        .filter(q => q.type === 'CREATE_SHIFT' && q.payload?.offlineShift)
        .map(q => q.payload.offlineShift as DeliveryShift);

      // Lọc bỏ các ca đã bị chốt offline trong queue
      const offlineClosedShiftIds = new Set(
        queue.filter(q => q.type === 'CLOSE_SHIFT' || q.type === 'DELETE_SHIFT').map(q => q.shiftId)
      );

      const merged = [
        ...offlineCreatedShifts,
        ...data.filter(s => !offlineClosedShiftIds.has(s.id)),
      ];

      await setCachedOpenShifts(merged);
      return merged;
    }
  } catch (e) {
    console.warn('[Offline Mode] Không thể kết nối máy chủ, nạp danh sách ca đang mở từ bộ nhớ máy:', e);
  }

  // Fallback đọc từ cache nội bộ
  return cached;
}

// 2. Tải danh sách công việc đã đóng (Status: 'closed') - Offline-First
export async function getPastShifts(limit = 50): Promise<DeliveryShift[]> {
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);
  const cached = await getCachedPastShifts();

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await withNetworkTimeout(
      supabase
        .from('delivery_shifts')
        .select('*')
        .eq('system_code', shiftSys)
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
        .limit(limit),
      2500
    );

    if (!error && Array.isArray(data)) {
      await setCachedPastShifts(data);
      return data;
    }
  } catch (e) {
    console.warn('[Offline Mode] Không thể kết nối máy chủ, nạp ca đã hoàn thành từ bộ nhớ máy:', e);
  }

  return cached;
}

// 3. Tải danh sách loại phiếu theo phân hệ (Có cache)
export async function getOrderTypes(): Promise<OrderTypeItem[]> {
  const baseSys = await getCurrentSystemCode();

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await withNetworkTimeout(
      supabase
        .from('order_types')
        .select('id, code, name, scope, system_code, is_active')
        .eq('system_code', baseSys)
        .eq('is_active', true)
        .order('code', { ascending: true }),
      2000
    );

    if (!error && Array.isArray(data)) {
      await AsyncStorage.setItem(OP_CACHE_ORDER_TYPES_KEY, JSON.stringify(data));
      return data;
    }
  } catch (e) {
    console.warn('Lấy loại phiếu từ cache:', e);
  }

  try {
    const cached = await AsyncStorage.getItem(OP_CACHE_ORDER_TYPES_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
}

// 3.1 Tải danh sách công việc mẫu (Job Templates) (Có cache)
export async function getJobTemplates(): Promise<JobTemplate[]> {
  const baseSys = await getCurrentSystemCode();
  const cleanCode = baseSys ? baseSys.trim().replace(/__solieu$/, '') : 'COLD';

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await withNetworkTimeout(
      (supabase as any)
        .from('delivery_job_templates')
        .select('*')
        .eq('system_code', cleanCode)
        .order('order_index', { ascending: true })
        .order('created_at', { ascending: true }),
      2000
    );

    if (!error && Array.isArray(data)) {
      const parsed = data.map((row: any) => ({
        id: row.id,
        name: row.name,
        notes: row.notes,
        pinned_product_ids: Array.isArray(row.pinned_product_ids) ? row.pinned_product_ids : [],
        company_id: row.company_id,
        system_code: row.system_code,
        order_index: row.order_index,
      }));
      await AsyncStorage.setItem(OP_CACHE_TEMPLATES_KEY, JSON.stringify(parsed));
      return parsed;
    }
  } catch (e) {
    console.warn('Lấy công việc mẫu từ cache:', e);
  }

  try {
    const cached = await AsyncStorage.getItem(OP_CACHE_TEMPLATES_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
}

// 4. Mở ca công việc mới (Hỗ trợ mở ca ngay cả khi hoàn toàn mất mạng trong kho đông)
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
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);
  const openedAtIso = params.openedAt ? new Date(params.openedAt).toISOString() : new Date().toISOString();

  const payload = {
    system_code: shiftSys,
    company_id: params.user?.company_id || null,
    status: 'open' as const,
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

  // 1. Thử gọi Supabase trước (timeout 2500ms)
  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await withNetworkTimeout(
      supabase.from('delivery_shifts').insert([payload]).select().single(),
      2500
    );

    if (!error && data) {
      // Cập nhật vào danh sách ca đang mở cache
      const cached = await getCachedOpenShifts();
      await setCachedOpenShifts([data, ...cached.filter(s => s.id !== data.id)]);
      await setCachedJournals(data.id, []);
      return data;
    }
  } catch (netErr) {
    console.warn('[Offline Mode] Mất mạng khi mở ca, chuyển sang tạo ca ngoại tuyến:', netErr);
  }

  // 2. Chế độ Ngoại Tuyến (Offline trong kho đông)
  const tempShiftId = `offline_shift_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const offlineShift: DeliveryShift = {
    id: tempShiftId,
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
      is_offline: true,
    }
  };

  // Lưu vào cache
  const cached = await getCachedOpenShifts();
  await setCachedOpenShifts([offlineShift, ...cached]);
  await setCachedJournals(tempShiftId, []);

  // Đẩy vào hàng đợi đồng bộ
  await addToOfflineOperationsQueue({
    type: 'CREATE_SHIFT',
    payload: { params, offlineShift, tempShiftId },
    shiftId: tempShiftId,
  });

  return offlineShift;
}

// 5. Tải nhật ký số liệu của 1 ca (Offline-First siêu tốc 0ms lag)
export async function getShiftJournals(shiftId: string): Promise<JournalRecord[]> {
  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);
  const cached = await getCachedJournals(shiftId);
  const queue = await getOfflineOperationsQueue();

  // Danh sách các lượt ghi nhận offline của ca này trong queue
  const offlineJournalsInQueue = queue
    .filter(q => q.type === 'SUBMIT_JOURNAL' && (q.shiftId === shiftId || q.payload?.shiftId === shiftId))
    .map(q => q.payload?.offlineRecord as JournalRecord)
    .filter(Boolean);

  const deletedRecordIds = new Set(
    queue.filter(q => q.type === 'DELETE_JOURNAL').map(q => q.payload?.recordId)
  );

  const updatedRecordMap = new Map<string, any>(
    queue.filter(q => q.type === 'UPDATE_JOURNAL').map(q => [q.payload?.id, q.payload])
  );

  const buildOfflineMerged = () => {
    const combined = [...offlineJournalsInQueue, ...cached.filter(c => !offlineJournalsInQueue.some(o => o.id === c.id))];
    return combined
      .filter(r => !deletedRecordIds.has(r.id))
      .map(r => {
        const up = updatedRecordMap.get(r.id);
        return up ? { ...r, quantity_sent: up.quantity, unit: up.unit, notes: up.notes || r.notes } : r;
      });
  };

  // Nếu là ca offline hoặc hệ thống đã phát hiện mất mạng: đọc ngay từ bộ nhớ máy (0ms lag)
  if (shiftId.startsWith('offline_shift_') || isOfflineDetected()) {
    return buildOfflineMerged();
  }

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await withNetworkTimeout(
      supabase
        .from('delivery_journal')
        .select('*')
        .or(`system_code.eq.${shiftSys},system_code.eq.${baseSys}`)
        .ilike('notes', `%[CV_ID: ${shiftId}]%`)
        .order('sent_at', { ascending: false }),
      800
    );

    if (!error && Array.isArray(data)) {
      // Merge với các bản ghi offline
      const merged = [
        ...offlineJournalsInQueue,
        ...data.filter(d => !offlineJournalsInQueue.some(o => o.id === d.id)),
      ]
        .filter(r => !deletedRecordIds.has(r.id))
        .map(r => {
          const up = updatedRecordMap.get(r.id);
          return up ? { ...r, quantity_sent: up.quantity, unit: up.unit, notes: up.notes || r.notes } : r;
        });

      await setCachedJournals(shiftId, merged);
      return merged;
    }
  } catch (e) {
    setKnownOffline(true);
    console.warn('[Offline Mode] Mất mạng khi tải nhật ký, dùng cache nội bộ:', e);
  }

  return buildOfflineMerged();
}

// 6. Ghi nhận 1 lượt Nhập / Xuất (Offline-First: Phản hồi 0ms, không sợ rớt mạng)
export async function submitJournalEntry(params: {
  shift: DeliveryShift;
  product: ShiftProductItem;
  quantity: number;
  unit: string;
  type: 'in' | 'out';
  user: any;
  userNote?: string;
}): Promise<boolean> {
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

  const tempJournalId = `offline_jn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const localRecord: JournalRecord = {
    id: tempJournalId,
    delivery_code: payload.delivery_code,
    item_name: params.product.name,
    quantity_sent: params.quantity,
    unit: params.unit,
    from_department: payload.from_department,
    to_department: payload.to_department,
    status: payload.status,
    notes: notesTag,
    sent_by_name: params.user?.full_name || 'Nhân viên kho',
    sent_at: nowIso,
    system_code: shiftSys,
    is_offline: true,
  };

  // Cập nhật ngay vào cache nhật ký của ca để UI hiển thị số lượng tức thời
  const currentJournals = await getCachedJournals(params.shift.id);
  await setCachedJournals(params.shift.id, [localRecord, ...currentJournals]);

  // NẾU CA LÀ CA OFFLINE HOẶC HỆ THỐNG ĐÃ PHÁT HIỆN MẤT MẠNG TRONG KHO ĐÔNG:
  // LƯU OFFLINE VÀ TRẢ VỀ NGAY LẬP TỨC (0ms lag)!
  if (params.shift.id.startsWith('offline_shift_') || isOfflineDetected()) {
    await addToOfflineOperationsQueue({
      type: 'SUBMIT_JOURNAL',
      payload: { payload, offlineRecord: localRecord, shiftId: params.shift.id },
      shiftId: params.shift.id,
    });
    return true;
  }

  // Nếu chưa biết là offline, thử gửi online với timeout ngắn 700ms
  try {
    const supabase = await getSupabaseClient();
    const { error } = await withNetworkTimeout(
      supabase.from('delivery_journal').insert([payload]),
      700
    );

    if (!error) {
      return true;
    }
  } catch (e) {
    setKnownOffline(true);
    console.warn('[Offline Mode] Phát hiện mất mạng kho đông, chuyển sang lưu offline tức thời:', e);
  }

  // Đẩy vào hàng đợi offline
  await addToOfflineOperationsQueue({
    type: 'SUBMIT_JOURNAL',
    payload: { payload, offlineRecord: localRecord, shiftId: params.shift.id },
    shiftId: params.shift.id,
  });

  return true;
}

// 6.1 Cập nhật một dòng nhật ký (Sửa lượt bấm - Offline-First)
export async function updateJournalEntry(params: {
  id: string;
  quantity: number;
  unit: string;
  type: 'in' | 'out';
  notes?: string;
  shiftId: string;
}): Promise<boolean> {
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

  // Cập nhật cache local
  const currentJournals = await getCachedJournals(params.shiftId);
  const updatedList = currentJournals.map(j => {
    if (j.id === params.id) {
      return {
        ...j,
        quantity_sent: params.quantity,
        unit: params.unit,
        from_department: payload.from_department,
        to_department: payload.to_department,
        status: payload.status,
        notes: cleanNotes,
      };
    }
    return j;
  });
  await setCachedJournals(params.shiftId, updatedList);

  // Nếu là record offline chưa từng đẩy lên mạng, cập nhật payload trong queue
  if (params.id.startsWith('offline_jn_')) {
    const queue = await getOfflineOperationsQueue();
    const qItem = queue.find(q => q.type === 'SUBMIT_JOURNAL' && q.payload?.offlineRecord?.id === params.id);
    if (qItem) {
      qItem.payload.payload.quantity_sent = params.quantity;
      qItem.payload.payload.unit = params.unit;
      qItem.payload.payload.result_quantity = params.quantity;
      qItem.payload.payload.result_unit = params.unit;
      qItem.payload.offlineRecord.quantity_sent = params.quantity;
      qItem.payload.offlineRecord.unit = params.unit;
      await saveOfflineOperationsQueue(queue);
      return true;
    }
  }

  // Thử online
  try {
    const supabase = await getSupabaseClient();
    const { error } = await withNetworkTimeout(
      supabase.from('delivery_journal').update(payload).eq('id', params.id),
      2000
    );
    if (!error) return true;
  } catch (e) {
    console.warn('[Offline Mode] Mất mạng khi sửa nhật ký, lưu hàng đợi:', e);
  }

  await addToOfflineOperationsQueue({
    type: 'UPDATE_JOURNAL',
    payload: { id: params.id, payload, shiftId: params.shiftId },
    shiftId: params.shiftId,
  });

  return true;
}

// 6.2 Xóa một dòng nhật ký (Xóa lượt bấm nhầm - Offline-First)
export async function deleteJournalEntry(id: string, shiftId?: string): Promise<boolean> {
  // Cập nhật cache local nếu biết shiftId
  if (shiftId) {
    const currentJournals = await getCachedJournals(shiftId);
    await setCachedJournals(shiftId, currentJournals.filter(j => j.id !== id));
  }

  // Nếu là bản ghi offline trong queue, chỉ cần xóa khỏi queue
  if (id.startsWith('offline_jn_')) {
    const queue = await getOfflineOperationsQueue();
    const filtered = queue.filter(q => !(q.type === 'SUBMIT_JOURNAL' && q.payload?.offlineRecord?.id === id));
    await saveOfflineOperationsQueue(filtered);
    return true;
  }

  // Thử online
  try {
    const supabase = await getSupabaseClient();
    const { error } = await withNetworkTimeout(
      supabase.from('delivery_journal').delete().eq('id', id),
      2000
    );
    if (!error) return true;
  } catch (e) {
    console.warn('[Offline Mode] Mất mạng khi xóa nhật ký, lưu hàng đợi:', e);
  }

  await addToOfflineOperationsQueue({
    type: 'DELETE_JOURNAL',
    payload: { recordId: id, shiftId },
    shiftId,
  });

  return true;
}

// 7. Đồng bộ danh sách ghim lên ca công việc
export async function syncPinnedProducts(shiftId: string, currentSummary: any, pinned: ShiftProductItem[]): Promise<void> {
  const nextSummary = {
    ...(currentSummary || {}),
    pinned_products: pinned,
  };

  // Cập nhật cache local
  const openShifts = await getCachedOpenShifts();
  const updatedOpenShifts = openShifts.map(s => {
    if (s.id === shiftId) {
      return { ...s, summary_data: nextSummary };
    }
    return s;
  });
  await setCachedOpenShifts(updatedOpenShifts);

  if (shiftId.startsWith('offline_shift_')) {
    return;
  }

  try {
    const supabase = await getSupabaseClient();
    await withNetworkTimeout(
      supabase.from('delivery_shifts').update({ summary_data: nextSummary }).eq('id', shiftId),
      2000
    );
  } catch (e) {
    console.warn('[Offline Mode] Mất mạng khi lưu ghim:', e);
  }
}

// 8. Chốt sổ hoàn thành ca công việc (Offline-First)
export async function closeShift(params: {
  shiftId: string;
  jobName: string;
  closeNotes: string;
  orderTypeId?: string | null;
  orderTypeName?: string | null;
  orderTypeCode?: string | null;
  user: any;
}): Promise<boolean> {
  const closedAtIso = new Date().toISOString();

  // 1. Tính tổng các mặt hàng đã nhập xuất trong ca từ cache/dữ liệu local
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
    status: 'closed' as const,
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

  // Cập nhật chuyển ca từ open sang past trong cache
  const openShifts = await getCachedOpenShifts();
  const matchedShift = openShifts.find(s => s.id === params.shiftId);
  await setCachedOpenShifts(openShifts.filter(s => s.id !== params.shiftId));

  if (matchedShift) {
    const closedShift: DeliveryShift = {
      ...matchedShift,
      status: 'closed',
      closed_at: closedAtIso,
      closed_by: payload.closed_by,
      closed_by_name: payload.closed_by_name,
      notes: payload.notes,
      summary_data: {
        ...(matchedShift.summary_data || {}),
        ...payload.summary_data,
      }
    };
    const pastShifts = await getCachedPastShifts();
    await setCachedPastShifts([closedShift, ...pastShifts]);
  }

  // Nếu là ca offline chưa từng đẩy lên Supabase
  if (params.shiftId.startsWith('offline_shift_')) {
    await addToOfflineOperationsQueue({
      type: 'CLOSE_SHIFT',
      payload: { params, payload, shiftId: params.shiftId },
      shiftId: params.shiftId,
    });
    return true;
  }

  // Thử online
  try {
    const supabase = await getSupabaseClient();
    const { error } = await withNetworkTimeout(
      supabase.from('delivery_shifts').update(payload).eq('id', params.shiftId),
      2500
    );
    if (!error) return true;
  } catch (e) {
    console.warn('[Offline Mode] Mất mạng khi chốt ca, lưu hàng đợi:', e);
  }

  await addToOfflineOperationsQueue({
    type: 'CLOSE_SHIFT',
    payload: { params, payload, shiftId: params.shiftId },
    shiftId: params.shiftId,
  });

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

// 9. Lấy danh mục tất cả sản phẩm (Có cache offline)
export async function getWarehouseProducts(): Promise<ShiftProductItem[]> {
  const baseSys = await getCurrentSystemCode();

  try {
    const supabase = await getSupabaseClient();
    let productsQuery = (supabase as any)
      .from('products')
      .select('id, name, sku, unit, weight_kg, aliases, internal_code, internal_name')
      .order('name', { ascending: true });

    if (baseSys) {
      productsQuery = productsQuery.or(`system_code.eq.${baseSys},system_type.eq.${baseSys}`);
    }

    const [productsRes, unitsRes, prodUnitsRes] = await withNetworkTimeout(
      Promise.all([
        productsQuery.limit(2000),
        supabase.from('units').select('id, name').limit(1000),
        supabase.from('product_units').select('product_id, unit_id, conversion_rate').limit(5000),
      ]),
      3000
    );

    const products = productsRes.data || [];
    const unitsList = unitsRes.data || [];
    const prodUnitsList = prodUnitsRes.data || [];

    if (products.length > 0) {
      const mapped = products.map((product: any) => {
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

      // Lưu cache sản phẩm
      await AsyncStorage.setItem(OP_CACHE_PRODUCTS_KEY, JSON.stringify(mapped));
      return mapped;
    }
  } catch (e) {
    console.warn('Lỗi lấy danh mục sản phẩm từ Supabase, thử nạp từ cache:', e);
  }

  // 1. Fallback đọc từ AsyncStorage
  try {
    const raw = await AsyncStorage.getItem(OP_CACHE_PRODUCTS_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) return list;
    }
  } catch {}

  // 2. Fallback từ Cache SQLite nếu có
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

// ── TIẾN TRÌNH ĐỒNG BỘ TOÀN BỘ SỐ LIỆU OFFLINE LÊN MÁY CHỦ (SYNC ENGINE) ──
export async function syncOperationsOfflineQueue(): Promise<{
  success: boolean;
  syncedCount: number;
  message?: string;
}> {
  const queue = await getOfflineOperationsQueue();
  if (queue.length === 0) {
    return { success: true, syncedCount: 0, message: 'Không có dữ liệu chờ đồng bộ' };
  }

  const supabase = await getSupabaseClient();
  let syncedCount = 0;
  const tempShiftIdMap: Record<string, string> = {};
  const remainingQueue: OperationsQueueAction[] = [];

  for (let i = 0; i < queue.length; i++) {
    const action = queue[i];
    try {
      if (action.type === 'CREATE_SHIFT') {
        const { params, tempShiftId } = action.payload;
        const baseSys = await getCurrentSystemCode();
        const shiftSys = getShiftSystemCode(baseSys);
        const openedAtIso = params.openedAt ? new Date(params.openedAt).toISOString() : new Date().toISOString();

        const insertPayload = {
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

        const { data: realShift, error: createErr } = await supabase
          .from('delivery_shifts')
          .insert([insertPayload])
          .select()
          .single();

        if (createErr) throw createErr;

        if (realShift) {
          tempShiftIdMap[tempShiftId] = realShift.id;

          // Cập nhật lại cache open shifts với ID thật
          const openShifts = await getCachedOpenShifts();
          const replaced = openShifts.map(s => (s.id === tempShiftId ? realShift : s));
          await setCachedOpenShifts(replaced);

          // Chuyển cache nhật ký sang ID thật
          const jns = await getCachedJournals(tempShiftId);
          await setCachedJournals(realShift.id, jns);
          await AsyncStorage.removeItem(`${OP_CACHE_JOURNALS_PREFIX}${tempShiftId}`);

          syncedCount++;
        }
      } else if (action.type === 'SUBMIT_JOURNAL') {
        const { payload: origPayload, shiftId } = action.payload;
        const realShiftId = tempShiftIdMap[shiftId] || shiftId;

        // Thay thế CV_ID nếu ca này vừa được sync ID mới
        let finalNotes = origPayload.notes;
        if (finalNotes && finalNotes.includes(shiftId)) {
          finalNotes = finalNotes.replace(`[CV_ID: ${shiftId}]`, `[CV_ID: ${realShiftId}]`);
        }

        const journalPayload = {
          ...origPayload,
          notes: finalNotes,
        };

        const { error: jnErr } = await supabase.from('delivery_journal').insert([journalPayload]);
        if (jnErr) throw jnErr;
        syncedCount++;
      } else if (action.type === 'UPDATE_JOURNAL') {
        const { id, payload } = action.payload;
        const { error: upErr } = await supabase.from('delivery_journal').update(payload).eq('id', id);
        if (upErr) throw upErr;
        syncedCount++;
      } else if (action.type === 'DELETE_JOURNAL') {
        const { recordId } = action.payload;
        const { error: delErr } = await supabase.from('delivery_journal').delete().eq('id', recordId);
        if (delErr) throw delErr;
        syncedCount++;
      } else if (action.type === 'CLOSE_SHIFT') {
        const { payload, shiftId } = action.payload;
        const realShiftId = tempShiftIdMap[shiftId] || shiftId;

        const { error: closeErr } = await supabase
          .from('delivery_shifts')
          .update(payload)
          .eq('id', realShiftId);

        if (closeErr) throw closeErr;
        syncedCount++;
      }
    } catch (err: any) {
      console.warn(`[Sync Error] Không thể đồng bộ action ${action.type}:`, err?.message);
      remainingQueue.push({
        ...action,
        retryCount: (action.retryCount || 0) + 1,
      });
    }
  }

  await saveOfflineOperationsQueue(remainingQueue);

  // Nạp lại danh sách ca online mới nhất
  await getOpenShifts();
  await getPastShifts();

  return {
    success: remainingQueue.length === 0,
    syncedCount,
    message: remainingQueue.length === 0
      ? `Đã đồng bộ ${syncedCount} lượt số liệu lên máy chủ thành công!`
      : `Đã đồng bộ ${syncedCount} lượt, còn ${remainingQueue.length} lượt đang chờ thử lại`,
  };
}

// 10. Tải danh sách các đợt chốt tạm (Sub-Shifts - Siêu tốc có Cache & Offline)
export async function getSubShifts(shiftId: string): Promise<SubShift[]> {
  const cached = await getCachedSubShifts(shiftId);

  // Nếu là ca offline hoặc đã phát hiện mất mạng: đọc cache ngay lập tức (0ms lag)
  if (shiftId.startsWith('offline_shift_') || isOfflineDetected()) {
    return cached;
  }

  const baseSys = await getCurrentSystemCode();
  const shiftSys = getShiftSystemCode(baseSys);

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await withNetworkTimeout(
      supabase
        .from('delivery_sub_shifts')
        .select('*')
        .eq('shift_id', shiftId)
        .or(`system_code.eq.${shiftSys},system_code.eq.${baseSys}`)
        .order('sub_shift_number', { ascending: true }),
      800
    );

    if (!error && Array.isArray(data)) {
      await setCachedSubShifts(shiftId, data);
      return data;
    }
  } catch (error) {
    setKnownOffline(true);
    console.warn('Lỗi lấy danh sách chốt tạm từ mạng, dùng cache nội bộ:', error);
  }

  return cached;
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

