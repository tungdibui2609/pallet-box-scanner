import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabaseClient } from './supabase';

export type ProposalActionType = 'CLEAR' | 'SET_QTY' | 'MOVE';

export interface ProposalSubItem {
  product_id?: string | null;
  product_name: string;
  sku?: string | null;
  current_quantity: number;
  new_quantity: number;
  unit: string;
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

