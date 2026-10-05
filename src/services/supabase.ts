import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pallet, BoxLabel } from '../types';
import { markPalletSynced, markPalletSyncError, replacePalletBoxesFromCloud, saveStampDictionaries, saveStampFormats } from './database';

export const DEFAULT_SUPABASE_URL = 'https://api.chanhthu.click';
export const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

let supabaseInstance: any = null;

export function resetSupabaseClient() {
  supabaseInstance = null;
}

export async function getSupabaseClient() {
  if (supabaseInstance) return supabaseInstance;

  const storedUrl = await AsyncStorage.getItem('config_supabase_url');
  const storedKey = await AsyncStorage.getItem('config_supabase_key');

  const url = storedUrl || DEFAULT_SUPABASE_URL;
  const key = storedKey || DEFAULT_ANON_KEY;

  supabaseInstance = createClient(url, key, {
    auth: {
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    }
  });

  return supabaseInstance;
}

export async function testConnection(): Promise<{ success: boolean; message: string; latency?: number }> {
  const start = Date.now();
  try {
    const client = await getSupabaseClient();
    const { error } = await client.from('box_labels').select('id').limit(1);
    const latency = Date.now() - start;
    if (error) {
      return { success: false, message: 'Lỗi Supabase: ' + error.message, latency };
    }
    return { success: true, message: `Kết nối thành công! (${latency}ms)`, latency };
  } catch (err: any) {
    return { success: false, message: 'Không thể kết nối máy chủ: ' + err.message };
  }
}

import { encodeSTT, decodeSTT } from '../utils/numberUtils';

/**
 * Sync Pallet & Boxes into Supabase:
 * QUY TẮC NGHIÊM NGẶT:
 * 1. Lot là do Web Mẹ tạo, mỗi Lot có 1 STT (daily_seq).
 * 2. Khi điện thoại gửi STT lên:
 *    - Nếu tìm thấy Lot có STT khớp trên Web: KẾT NỐI ngay vào lot_id đó (status = 'linked').
 *    - Nếu KHÔNG tìm thấy Lot khớp STT: TUYỆT ĐỐI KHÔNG TỰ TẠO LOT!
 *      Thay vào đó lưu các thùng vào box_labels với lot_id = null, status = 'unlinked',
 *      và lưu thông tin STT vào metadata để nằm ở mục "Chưa kết nối" trên Web mẹ.
 */
export async function syncPalletToSupabase(pallet: Pallet, boxes: BoxLabel[]): Promise<{ success: boolean; message: string; isLinked?: boolean }> {
  try {
    const client = await getSupabaseClient();
    const sttCode = pallet.code.trim().toUpperCase();
    const encodedSeq = encodeSTT(sttCode);

    // Lấy thông tin tài khoản đang đăng nhập (để gán đúng company_id và created_by)
    let companyId: string | null = null;
    let userId: string | null = null;
    try {
      const rawUser = await AsyncStorage.getItem('auth_user_profile');
      if (rawUser) {
        const u = JSON.parse(rawUser);
        companyId = u.company_id || null;
        userId = u.id || null;
      }
    } catch {}

    // 1. Tìm kiếm Lô trên Web mẹ có STT trùng khớp
    let foundLot: any = null;

    // 1.1 Tìm theo STT (daily_seq) nếu sttCode chuyển đổi được thành số
    if (encodedSeq !== null) {
      let q = client
        .from('lots')
        .select('id, code, daily_seq, production_code, system_code')
        .eq('daily_seq', encodedSeq);
      if (companyId) q = q.eq('company_id', companyId);
      const { data } = await q.maybeSingle();
      if (data) foundLot = data;
    }

    // 1.2 Nếu chưa tìm thấy theo daily_seq, tìm theo code hoặc production_code
    if (!foundLot) {
      let q = client
        .from('lots')
        .select('id, code, daily_seq, production_code, system_code')
        .or(`code.ilike.%${sttCode}%,production_code.ilike.%${sttCode}%`);
      if (companyId) q = q.eq('company_id', companyId);
      const { data } = await q.maybeSingle();
      if (data) foundLot = data;
    }

    const totalWeight = boxes.reduce((s, b) => s + (Number(b.weight) || 20), 0);
    const isLinked = !!foundLot;
    const targetLotId = foundLot ? foundLot.id : null;
    const targetLotCode = foundLot ? foundLot.code : null;

    // Nếu Lô đã tồn tại, hủy liên kết các tem cũ của Lô này để chuẩn bị cập nhật danh sách mới
    if (targetLotId) {
      await (client.from('box_labels') as any)
        .update({ lot_id: null, status: 'unlinked' })
        .eq('lot_id', targetLotId);
    }

    // 2. Chuẩn bị danh sách tem thùng (box_labels)
    const boxRows = boxes.map(b => {
      const cleanSku = (b.sku || 'SKU').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const cleanLot = (b.lot_code || 'LOT').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const idxStr = String(b.box_index || '0').padStart(3, '0');
      
      let boxCode = `BOX-${cleanLot}-${cleanSku}-${idxStr}`;
      if (b.scan_type === 'stamp') {
        const cleanL1 = (b.stamp_line1 || cleanSku).replace(/[^a-zA-Z0-9]/g, '');
        const cleanL2 = (b.stamp_line2 || cleanLot).replace(/[^a-zA-Z0-9]/g, '');
        boxCode = `STAMP-${cleanL1}-${cleanL2}-${idxStr}`;
      }

      const row: any = {
        code: boxCode,
        lot_id: targetLotId, // Gán vào Lot nếu tìm thấy, hoặc null nếu chưa có Lot
        quantity: b.weight || 20,
        unit: b.unit || 'Kg',
        semi_finished_lot_code: b.scan_type === 'stamp' ? b.stamp_line2 : b.lot_code,
        finished_lot_code: b.scan_type === 'stamp' ? b.stamp_line2 : b.lot_code,
        system_code: pallet.system_code || 'KHO_DONG_LANH',
        status: isLinked ? 'linked' : 'unlinked',
        created_at: b.created_at,
        metadata: {
          pallet_stt: sttCode,
          pallet_local_id: pallet.id,
          scan_type: b.scan_type || 'label',
          stamp_line1: b.stamp_line1 || null,
          stamp_line2: b.stamp_line2 || null,
          box_index: b.box_index,
          sku: b.sku,
          product_name: b.product_name,
          spec: b.spec,
          shift_group: b.shift_group,
          region: b.region,
          production_date: b.production_date,
          packaging_date: b.packaging_date,
        }
      };
      if (companyId) row.company_id = companyId;
      if (userId) row.created_by = userId;

      return row;
    });

    // 3. Upsert vào bảng box_labels
    const { error: boxErr } = await (client.from('box_labels') as any)
      .upsert(boxRows, { onConflict: 'code' });

    if (boxErr) {
      throw new Error('Lỗi đồng bộ thùng: ' + boxErr.message);
    }

    // 4. Đánh dấu Pallet trên thiết bị là đã đồng bộ (TUYỆT ĐỐI không thay đổi thông tin ở bảng lots trên Web mẹ)
    await markPalletSynced(pallet.id);

    if (isLinked) {
      return {
        success: true,
        isLinked: true,
        message: `✅ Đã kết nối thành công ${boxes.length} thùng vào Lô "${targetLotCode}" (STT: ${sttCode}) trên Web mẹ!`
      };
    } else {
      return {
        success: true,
        isLinked: false,
        message: `ℹ️ Đã lưu ${boxes.length} thùng lên mục "Chưa kết nối". Trên Web mẹ chưa có Lô mang STT "${sttCode}". Khi Web tạo Lô, hệ thống sẽ tự động ghép nối!`
      };
    }
  } catch (err: any) {
    await markPalletSyncError(pallet.id, err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Pull updated boxes from Supabase for a pallet:
 * Đồng bộ hai chiều: Hỗ trợ kéo tem về điện thoại dù Pallet đã kết nối hay đang ở mục Chưa kết nối!
 */
export async function pullPalletFromSupabase(
  palletId: string,
  palletCode: string
): Promise<{ success: boolean; count: number; message: string }> {
  try {
    const client = await getSupabaseClient();
    const sttCode = palletCode.trim().toUpperCase();
    const encodedSeq = encodeSTT(sttCode);

    // 1. Kiểm tra xem Pallet này đã có Lot trên Web chưa
    let foundLot: any = null;
    if (encodedSeq !== null) {
      const { data } = await client.from('lots').select('id, code').eq('daily_seq', encodedSeq).maybeSingle();
      if (data) foundLot = data;
    }
    if (!foundLot) {
      const { data } = await client.from('lots').select('id, code').or(`code.ilike.%${sttCode}%,production_code.ilike.%${sttCode}%`).maybeSingle();
      if (data) foundLot = data;
    }

    let cloudBoxes: any[] = [];

    if (foundLot) {
      // 2A. Lấy theo lot_id
      const { data, error: boxErr } = await client
        .from('box_labels')
        .select(`
          id,
          code,
          quantity,
          unit,
          semi_finished_lot_code,
          finished_lot_code,
          metadata,
          created_at,
          products ( name, sku, internal_name )
        `)
        .eq('lot_id', foundLot.id)
        .order('code', { ascending: true });

      if (boxErr) throw boxErr;
      cloudBoxes = data || [];
    } else {
      // 2B. Lấy từ mục Chưa kết nối theo metadata->>pallet_stt
      const { data, error: boxErr } = await client
        .from('box_labels')
        .select(`
          id,
          code,
          quantity,
          unit,
          semi_finished_lot_code,
          finished_lot_code,
          metadata,
          created_at,
          products ( name, sku, internal_name )
        `)
        .filter('metadata->>pallet_stt', 'eq', sttCode)
        .order('code', { ascending: true });

      if (boxErr) throw boxErr;
      cloudBoxes = data || [];
    }

    if (cloudBoxes.length === 0) {
      return { success: false, count: 0, message: `Không tìm thấy dữ liệu thùng cho STT ${sttCode} trên máy chủ web.` };
    }

    await replacePalletBoxesFromCloud(palletId, cloudBoxes);

    return {
      success: true,
      count: cloudBoxes.length,
      message: `Đã tải ${cloudBoxes.length} thùng từ chanhthu.click về điện thoại thành công!`
    };
  } catch (err: any) {
    return { success: false, count: 0, message: 'Lỗi đồng bộ từ máy chủ: ' + err.message };
  }
}

/**
 * Xóa / Gỡ liên kết tem thùng trên Supabase khi người dùng xóa trên điện thoại
 */
export async function unlinkBoxOnSupabase(boxCode: string): Promise<{ success: boolean; message: string }> {
  try {
    const client = await getSupabaseClient();
    const { error } = await client
      .from('box_labels')
      .update({ lot_id: null, status: 'printed' })
      .eq('code', boxCode);

    if (error) throw error;
    return { success: true, message: 'Đã gỡ tem trên máy chủ' };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

/**
 * Tải toàn bộ danh mục quy tắc giải mã dấu đóng từ Supabase về SQLite máy con
 */
export async function syncStampDictionariesFromSupabase(): Promise<{ success: boolean; count: number; message: string }> {
  try {
    const client = await getSupabaseClient();
    const { data, error } = await client
      .from('stamp_dictionaries')
      .select('category, code, name, description, sort_order')
      .eq('is_active', true);

    if (error) throw error;
    if (!data || data.length === 0) {
      return { success: false, count: 0, message: 'Máy chủ chưa có quy tắc dấu đóng nào được kích hoạt.' };
    }

    const savedCount = await saveStampDictionaries(data as any);

    // Đồng bộ cấu hình mẫu định dạng dấu đóng động
    try {
      const { data: formatsData } = await client
        .from('stamp_formats')
        .select('*')
        .eq('is_active', true);
      if (formatsData && formatsData.length > 0) {
        await saveStampFormats(formatsData as any);
      }
    } catch (fmtErr) {
      console.warn('Lỗi tải stamp_formats:', fmtErr);
    }

    await AsyncStorage.setItem('last_stamp_sync_time', new Date().toISOString());

    return {
      success: true,
      count: savedCount,
      message: `Đã đồng bộ thành công ${savedCount} quy tắc và mẫu định dạng từ máy chủ!`
    };
  } catch (err: any) {
    console.error('Lỗi syncStampDictionariesFromSupabase:', err);
    return {
      success: false,
      count: 0,
      message: 'Lỗi tải quy tắc từ máy chủ: ' + (err.message || 'Không thể kết nối')
    };
  }
}

