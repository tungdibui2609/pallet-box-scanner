import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabaseClient } from './supabase';
import { encodeSTT } from '../utils/numberUtils';

export type ProposalActionType = 'CLEAR' | 'SET_QTY' | 'MOVE' | 'ASSIGN_LOT' | 'NOTE';

export interface ProposalSubItem {
  product_id?: string | null;
  product_name: string;
  sku?: string | null;
  current_quantity: number;
  new_quantity: number;
  unit: string;
  is_new?: boolean;
}

export interface ProposalItem {
  id: string; // unique item id
  position_id: string;
  position_code: string;
  warehouse_name?: string;
  action_type: ProposalActionType;
  // Thông tin hàng hóa hiện tại
  lot_id?: string | null;
  lot_code?: string | null;
  lot_stt?: string | null;
  lot_found?: boolean;
  product_name?: string | null;
  sku?: string | null;
  current_quantity?: number | null;
  unit?: string | null;
  // Danh sách dòng con chi tiết (khi là pallet hỗn hợp nhiều sản phẩm)
  sub_items?: ProposalSubItem[];
  // Thông tin điều chỉnh mới
  new_quantity?: number | null;
  target_position_id?: string | null;
  target_position_code?: string | null;
  note?: string | null;
  updated_at: string;
}

export interface DraftProposal {
  title: string;
  notes: string;
  items: ProposalItem[];
  updated_at: string;
}

const STORAGE_KEYS = {
  CURRENT_DRAFT: '@warehouse_adjustment_draft_v1',
  OFFLINE_QUEUE: '@warehouse_adjustment_offline_queue_v1',
  SUBMITTED_CACHE_PREFIX: '@warehouse_adjustment_submitted_cache_v1_',
};

const TABLE_PRIMARY = 'warehouse_position_proposals';
const TABLE_FALLBACK = 'shift_tasks';

/**
 * Lấy bản nháp hiện tại đang lưu trên máy
 */
export async function getLocalDraftProposal(): Promise<DraftProposal> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_DRAFT);
    if (!raw) {
      return { title: '', notes: '', items: [], updated_at: new Date().toISOString() };
    }
    const parsed = JSON.parse(raw);
    return {
      title: parsed.title || '',
      notes: parsed.notes || '',
      items: Array.isArray(parsed.items) ? parsed.items : [],
      updated_at: parsed.updated_at || new Date().toISOString(),
    };
  } catch (err) {
    console.error('Lỗi đọc bản nháp điều chỉnh vị trí:', err);
    return { title: '', notes: '', items: [], updated_at: new Date().toISOString() };
  }
}

/**
 * Lưu bản nháp vào bộ nhớ máy
 */
export async function saveLocalDraftProposal(draft: DraftProposal): Promise<void> {
  try {
    const payload = {
      ...draft,
      updated_at: new Date().toISOString(),
    };
    await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_DRAFT, JSON.stringify(payload));
  } catch (err) {
    console.error('Lỗi lưu bản nháp điều chỉnh vị trí:', err);
  }
}

/**
 * Thêm hoặc cập nhật một vị trí vào bản nháp
 */
export async function upsertDraftItem(item: ProposalItem): Promise<DraftProposal> {
  const current = await getLocalDraftProposal();
  const existingIdx = current.items.findIndex(
    it => it.position_id === item.position_id || it.id === item.id
  );

  let newItems: ProposalItem[];
  if (existingIdx >= 0) {
    newItems = [...current.items];
    newItems[existingIdx] = { ...item, updated_at: new Date().toISOString() };
  } else {
    newItems = [item, ...current.items];
  }

  const updated: DraftProposal = {
    ...current,
    items: newItems,
    updated_at: new Date().toISOString(),
  };

  await saveLocalDraftProposal(updated);
  return updated;
}

/**
 * Xóa một vị trí khỏi bản nháp
 */
export async function removeDraftItem(positionId: string): Promise<DraftProposal> {
  const current = await getLocalDraftProposal();
  const filtered = current.items.filter(it => it.position_id !== positionId && it.id !== positionId);
  const updated: DraftProposal = {
    ...current,
    items: filtered,
    updated_at: new Date().toISOString(),
  };
  await saveLocalDraftProposal(updated);
  return updated;
}

/**
 * Xóa sạch bản nháp (sau khi đã gửi thành công hoặc người dùng bấm hủy)
 */
export async function clearLocalDraftProposal(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEYS.CURRENT_DRAFT);
  } catch (err) {
    console.error('Lỗi xóa bản nháp điều chỉnh vị trí:', err);
  }
}

/**
 * Gửi phiếu đề xuất điều chỉnh vị trí kho lên máy chủ (có hỗ trợ Offline Queue)
 */
export async function submitAdjustmentProposalToServer(payload: {
  system_code: string;
  company_id?: string | null;
  title?: string;
  created_by?: string | null;
  created_by_name?: string | null;
  notes?: string | null;
  items: ProposalItem[];
}): Promise<{ success: boolean; isOfflineSaved?: boolean; error?: string }> {
  if (!payload.items || payload.items.length === 0) {
    return { success: false, error: 'Không có vị trí nào trong phiếu điều chỉnh' };
  }

  const client = await getSupabaseClient();
  const defaultTitle = payload.title || `Điều chỉnh vị trí kho (${payload.items.length} vị trí)`;

  // Nếu không có mạng / client = null -> lưu vào hàng đợi offline
  if (!client) {
    await pushToOfflineQueue({ ...payload, title: defaultTitle });
    await clearLocalDraftProposal();
    return { success: true, isOfflineSaved: true };
  }

  try {
    // 1. Thử ghi vào bảng chuyên dụng warehouse_position_proposals
    const primaryPayload = {
      system_code: payload.system_code,
      company_id: payload.company_id || null,
      title: defaultTitle,
      created_by: payload.created_by || null,
      created_by_name: payload.created_by_name || 'Nhân viên',
      notes: payload.notes || null,
      status: 'PENDING',
      total_positions: payload.items.length,
      items: payload.items,
    };

    const { error: primaryErr } = await (client as any)
      .from(TABLE_PRIMARY)
      .insert(primaryPayload);

    if (!primaryErr) {
      await clearLocalDraftProposal();
      return { success: true };
    }
  } catch {
    // ignore
  }

  // 2. Fallback sang shift_tasks (bảng có sẵn 100% trong DB)
  try {
    const now = new Date();
    const code = `DC-${now.getFullYear().toString().slice(2)}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}-${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;

    const contentPayload = JSON.stringify({
      notes: payload.notes || '',
      items: payload.items,
    });

    const fallbackPayload = {
      code,
      system_code: payload.system_code,
      company_id: payload.company_id || null,
      title: defaultTitle,
      content: contentPayload,
      priority: 'normal',
      status: 'pending',
      task_type: 'warehouse_adjustment',
      created_by: payload.created_by || null,
      created_by_name: payload.created_by_name || 'Nhân viên kho',
      images: [],
    };

    const { error: fallbackErr } = await (client as any)
      .from(TABLE_FALLBACK)
      .insert(fallbackPayload);

    if (fallbackErr) {
      throw fallbackErr;
    }

    await clearLocalDraftProposal();
    return { success: true };
  } catch (err: any) {
    console.warn('Lỗi gửi trực tiếp, lưu vào hàng đợi ngoại tuyến:', err?.message);
    await pushToOfflineQueue({ ...payload, title: defaultTitle });
    await clearLocalDraftProposal();
    return { success: true, isOfflineSaved: true };
  }
}

/**
 * Thêm vào hàng đợi Offline
 */
async function pushToOfflineQueue(proposal: any): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE);
    const list = raw ? JSON.parse(raw) : [];
    list.push({
      ...proposal,
      queued_at: new Date().toISOString(),
    });
    await AsyncStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(list));
  } catch (err) {
    console.error('Lỗi lưu vào hàng đợi offline:', err);
  }
}

/**
 * Đồng bộ các phiếu trong hàng đợi Offline khi có mạng
 */
export async function syncOfflineAdjustmentProposals(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE);
    if (!raw) return 0;
    const list: any[] = JSON.parse(raw);
    if (list.length === 0) return 0;

    const client = await getSupabaseClient();
    if (!client) return 0;

    let syncedCount = 0;
    const remaining: any[] = [];

    for (const item of list) {
      try {
        const res = await submitAdjustmentProposalToServer(item);
        if (res.success && !res.isOfflineSaved) {
          syncedCount++;
        } else {
          remaining.push(item);
        }
      } catch {
        remaining.push(item);
      }
    }

    await AsyncStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(remaining));
    return syncedCount;
  } catch (err) {
    console.error('Lỗi đồng bộ hàng đợi ngoại tuyến:', err);
    return 0;
  }
}

export interface SubmittedProposal {
  id: string;
  code: string;
  system_code: string;
  title: string;
  notes: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  total_positions: number;
  items: ProposalItem[];
  created_by?: string | null;
  created_by_name?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  review_notes?: string | null;
  created_at: string;
  isOfflinePending?: boolean;
}

/**
 * Đọc nhanh danh sách phiếu đã gửi từ bộ nhớ máy (0ms, không gọi mạng)
 * Dùng khi mở modal để tránh tự động tải ngầm gây lag máy
 */
export async function getCachedSubmittedProposals(
  systemCode: string = 'KHO_DONG_LANH'
): Promise<SubmittedProposal[]> {
  const results: SubmittedProposal[] = [];

  try {
    const rawOffline = await AsyncStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE);
    if (rawOffline) {
      const offlineList: any[] = JSON.parse(rawOffline);
      if (Array.isArray(offlineList)) {
        offlineList.forEach((item, idx) => {
          results.push({
            id: `offline-${idx}-${item.queued_at || Date.now()}`,
            code: 'CHỜ ĐỒNG BỘ',
            system_code: item.system_code || systemCode,
            title: item.title || `Điều chỉnh vị trí kho (${item.items?.length || 0} vị trí)`,
            notes: item.notes || '',
            status: 'PENDING',
            total_positions: Array.isArray(item.items) ? item.items.length : 0,
            items: Array.isArray(item.items) ? item.items : [],
            created_by: item.created_by,
            created_by_name: item.created_by_name || 'Bạn',
            created_at: item.queued_at || new Date().toISOString(),
            isOfflinePending: true,
          });
        });
      }
    }
  } catch {
    // ignore
  }

  try {
    const cacheKey = `${STORAGE_KEYS.SUBMITTED_CACHE_PREFIX}${systemCode || 'DEFAULT'}`;
    const rawCache = await AsyncStorage.getItem(cacheKey);
    if (rawCache) {
      const cachedList: SubmittedProposal[] = JSON.parse(rawCache);
      if (Array.isArray(cachedList)) {
        results.push(...cachedList);
      }
    }
  } catch {
    // ignore
  }

  return results;
}

/**
 * Lấy danh sách các phiếu nháp đã gửi lên máy chủ (kèm các phiếu đang chờ đồng bộ offline)
 */
export async function getSubmittedAdjustmentProposals(
  systemCode: string = 'KHO_DONG_LANH'
): Promise<SubmittedProposal[]> {
  const results: SubmittedProposal[] = [];

  // 1. Đọc các phiếu đang chờ đồng bộ trong hàng đợi Offline
  try {
    const rawOffline = await AsyncStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE);
    if (rawOffline) {
      const offlineList: any[] = JSON.parse(rawOffline);
      if (Array.isArray(offlineList)) {
        offlineList.forEach((item, idx) => {
          results.push({
            id: `offline-${idx}-${item.queued_at || Date.now()}`,
            code: 'CHỜ ĐỒNG BỘ',
            system_code: item.system_code || systemCode,
            title: item.title || `Điều chỉnh vị trí kho (${item.items?.length || 0} vị trí)`,
            notes: item.notes || '',
            status: 'PENDING',
            total_positions: Array.isArray(item.items) ? item.items.length : 0,
            items: Array.isArray(item.items) ? item.items : [],
            created_by: item.created_by,
            created_by_name: item.created_by_name || 'Bạn',
            created_at: item.queued_at || new Date().toISOString(),
            isOfflinePending: true,
          });
        });
      }
    }
  } catch {
    // ignore
  }

  // 2. Lấy danh sách từ Supabase (shift_tasks), có lưu cache để xem khi Offline
  const cacheKey = `${STORAGE_KEYS.SUBMITTED_CACHE_PREFIX}${systemCode || 'DEFAULT'}`;
  let loadedFromServer = false;
  const serverResults: SubmittedProposal[] = [];

  try {
    const client = await getSupabaseClient();
    if (client) {
      let query = (client as any)
        .from(TABLE_FALLBACK)
        .select('*')
        .eq('task_type', 'warehouse_adjustment')
        .order('created_at', { ascending: false })
        .limit(30);

      if (systemCode) {
        query = query.eq('system_code', systemCode);
      }

      const { data, error } = await query;
      if (!error && Array.isArray(data)) {
        loadedFromServer = true;
        for (const t of data) {
          let parsedItems: ProposalItem[] = [];
          let parsedNotes = t.content || '';
          try {
            if (t.content && typeof t.content === 'string' && t.content.startsWith('{')) {
              const parsed = JSON.parse(t.content);
              parsedItems = Array.isArray(parsed.items) ? parsed.items : [];
              parsedNotes = parsed.notes || '';
            }
          } catch {
            // ignore
          }

          const rawStatus = (t.status || '').toUpperCase();
          const status: 'PENDING' | 'APPROVED' | 'REJECTED' =
            rawStatus === 'COMPLETED'
              ? 'APPROVED'
              : rawStatus === 'CANCELLED'
              ? 'REJECTED'
              : 'PENDING';

          serverResults.push({
            id: t.id,
            code: t.code || 'DC',
            system_code: t.system_code || systemCode,
            title: t.title || 'Đề xuất điều chỉnh vị trí kho',
            notes: parsedNotes,
            status,
            total_positions: parsedItems.length,
            items: parsedItems,
            created_by: t.created_by,
            created_by_name: t.created_by_name || 'Nhân viên kho',
            approved_by_name: t.completed_by_name || null,
            approved_at: t.completed_at || null,
            review_notes: t.completion_notes || null,
            created_at: t.created_at,
            isOfflinePending: false,
          });
        }

        if (serverResults.length > 0) {
          await enrichAssignLotItems(client, serverResults, systemCode);
        }

        // Lưu bản cache mới nhất xuống máy để xem được cả khi Offline
        try {
          await AsyncStorage.setItem(cacheKey, JSON.stringify(serverResults));
        } catch {
          // ignore
        }

        results.push(...serverResults);
      }
    }
  } catch (err) {
    console.warn('Không thể tải phiếu từ máy chủ, dùng bản cache offline:', err);
  }

  // 3. Nếu đang Offline / mất kết nối -> đọc từ cache đã lưu trên máy
  if (!loadedFromServer) {
    try {
      const rawCache = await AsyncStorage.getItem(cacheKey);
      if (rawCache) {
        const cachedList: SubmittedProposal[] = JSON.parse(rawCache);
        if (Array.isArray(cachedList)) {
          results.push(...cachedList);
        }
      }
    } catch {
      // ignore
    }
  }

  return results;
}

/**
 * Tự động tra cứu thông tin Lot (tên SP, mã Lot, số lượng) từ STT (VD: G888)
 * để App hiển thị đầy đủ giống Web mẹ
 */
async function enrichAssignLotItems(
  client: any,
  proposals: SubmittedProposal[],
  systemCode: string
): Promise<void> {
  const seqSet = new Set<number>();
  const lotIdSet = new Set<string>();
  let hasAssignLot = false;

  for (const p of proposals) {
    for (const it of p.items) {
      if (it.action_type !== 'ASSIGN_LOT') continue;
      hasAssignLot = true;
      if (it.lot_id) lotIdSet.add(it.lot_id);
      const sttRaw = (it.lot_stt || '').trim().toUpperCase();
      if (sttRaw) {
        const seq = encodeSTT(sttRaw);
        if (seq !== null) seqSet.add(seq);
      }
    }
  }

  if (!hasAssignLot || (seqSet.size === 0 && lotIdSet.size === 0)) {
    return;
  }

  const bySeq = new Map<number, any>();
  const byId = new Map<string, any>();

  try {
    if (seqSet.size > 0) {
      const { data } = await client
        .from('lots')
        .select(
          `id, code, production_code, daily_seq, quantity,
           lot_items(id, quantity, unit, products(name, sku, unit))`
        )
        .eq('system_code', systemCode)
        .in('daily_seq', Array.from(seqSet));

      if (Array.isArray(data)) {
        for (const lot of data) {
          if (lot.daily_seq != null) bySeq.set(lot.daily_seq, lot);
          if (lot.id) byId.set(lot.id, lot);
        }
      }
    }

    const missingIds = Array.from(lotIdSet).filter((id) => !byId.has(id));
    if (missingIds.length > 0) {
      const { data } = await client
        .from('lots')
        .select(
          `id, code, production_code, daily_seq, quantity,
           lot_items(id, quantity, unit, products(name, sku, unit))`
        )
        .eq('system_code', systemCode)
        .in('id', missingIds);

      if (Array.isArray(data)) {
        for (const lot of data) {
          if (lot.daily_seq != null) bySeq.set(lot.daily_seq, lot);
          if (lot.id) byId.set(lot.id, lot);
        }
      }
    }
  } catch (err) {
    console.warn('Lỗi enrich thông tin Lot trên App:', err);
    return;
  }

  for (const p of proposals) {
    for (const it of p.items) {
      if (it.action_type !== 'ASSIGN_LOT') continue;
      const sttRaw = (it.lot_stt || '').trim().toUpperCase();
      const seq = sttRaw ? encodeSTT(sttRaw) : null;
      const lot =
        (seq !== null ? bySeq.get(seq) : null) ||
        (it.lot_id ? byId.get(it.lot_id) : null);

      if (!lot) {
        if (sttRaw) it.lot_found = false;
        continue;
      }

      it.lot_found = true;
      it.lot_id = lot.id;
      it.lot_code = lot.code || lot.production_code || it.lot_code;

      const itemsArr: any[] = Array.isArray(lot.lot_items) ? lot.lot_items : [];
      if (itemsArr.length > 0) {
        const names = itemsArr.map((li) => li.products?.name).filter(Boolean);
        const skus = itemsArr.map((li) => li.products?.sku).filter(Boolean);
        const totalQty = itemsArr.reduce(
          (s, li) => s + (Number(li.quantity) || 0),
          0
        );
        const firstUnit =
          itemsArr[0]?.unit || itemsArr[0]?.products?.unit || it.unit || 'Thùng';

        if (names.length > 0) {
          it.product_name = Array.from(new Set(names)).join(', ');
        }
        if (skus.length > 0) {
          it.sku = Array.from(new Set(skus)).join(', ');
        }
        it.new_quantity = totalQty || lot.quantity || it.new_quantity;
        it.unit = firstUnit;
      } else if (lot.quantity != null) {
        it.new_quantity = lot.quantity;
      }
    }
  }
}

