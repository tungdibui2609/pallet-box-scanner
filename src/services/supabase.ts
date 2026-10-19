import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pallet, BoxLabel, CloudPallet } from '../types';
import {
  markPalletSynced, markPalletSyncError, replacePalletBoxesFromCloud,
  saveStampDictionaries, saveStampFormats, saveCloudPalletsToCache,
  getCloudPalletsFromCache, saveProductsToCache, getProductsFromCache,
  saveCloudBoxesToCache, getCloudBoxesFromCache
} from './database';
import { DEFAULT_STAMP_DICTIONARY } from './stampParser';

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
 * QUY TẮC:
 * 1. Lot là do Web Mẹ tạo, mỗi Lot có 1 STT (daily_seq).
 * 2. Khi điện thoại gửi STT lên:
 *    - Nếu tìm thấy Lot có STT khớp trên Web: KẾT NỐI ngay vào lot_id đó (status = 'linked').
 *      (Server Database Trigger sẽ tự động cập nhật ngày sản xuất / ngày nguyên liệu vào bảng lots).
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

    // 1.2 Nếu chưa tìm thấy theo daily_seq, tìm theo code chính xác (TUYỆT ĐỐI KHÔNG dùng ilike %sttCode% vì sẽ match nhầm vào các mã Lô ngẫu nhiên như DL-LOT-HG23GA)
    if (!foundLot) {
      let q = client
        .from('lots')
        .select('id, code, daily_seq, production_code, system_code')
        .or(`code.eq.${sttCode},production_code.eq.${sttCode}`);
      if (companyId) q = q.eq('company_id', companyId);
      const { data } = await q.maybeSingle();
      if (data) foundLot = data;
    }

    // 1.3 Kiểm tra xem Lô này đã có thùng gắn vào chưa
    let hasExistingBoxes = false;
    let existingBoxCount = 0;
    if (foundLot) {
      try {
        const { count } = await client
          .from('box_labels')
          .select('id', { count: 'exact', head: true })
          .eq('lot_id', foundLot.id);
        existingBoxCount = count || 0;
        hasExistingBoxes = existingBoxCount > 0;
      } catch (cntErr) {
        console.warn('Lỗi kiểm tra thùng của lot:', cntErr);
      }
    }

    // Nếu Lô đã tồn tại VÀ đã có thùng bên trong -> ĐÂY LÀ ĐỢT QUÉT TRÙNG / QUÉT LẠI
    // Tuân thủ nguyên tắc: App không tự ý ghi đè/xóa tem cũ của Lô đã hoàn tất!
    // Gửi lên mục Chưa kết nối để Quản lý trên Web mẹ ra quyết định (Cập nhật, Tách LOT, hoặc Hủy)
    const isConflictDuplicate = !!(foundLot && hasExistingBoxes);
    const targetLotId = isConflictDuplicate ? null : (foundLot ? foundLot.id : null);
    const isLinked = !!targetLotId;
    const targetLotCode = foundLot ? foundLot.code : null;

    // Phân biệt mã thùng nếu là đợt quét trùng để bảo vệ tuyệt đối các thùng của Lô cũ không bị ghi đè
    const cleanStt = sttCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const batchSuffix = isConflictDuplicate ? `-${pallet.id.slice(-4)}` : '';

    // 2. Chuẩn bị danh sách tem thùng (box_labels)
    const boxRows = boxes.map(b => {
      const cleanSku = (b.sku || 'SKU').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const cleanLot = (b.lot_code || 'LOT').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const idxStr = String(b.box_index || '0').padStart(3, '0');
      
      // Bổ sung cleanStt (mã STT Pallet) và batchSuffix (nếu quét trùng) vào boxCode
      let boxCode = `BOX-${cleanLot}-${cleanSku}-${cleanStt}${batchSuffix}-${idxStr}`;
      if (b.scan_type === 'stamp') {
        const cleanL1 = (b.stamp_line1 || cleanSku).replace(/[^a-zA-Z0-9]/g, '');
        const cleanL2 = (b.stamp_line2 || cleanLot).replace(/[^a-zA-Z0-9]/g, '');
        boxCode = `STAMP-${cleanL1}-${cleanL2}-${cleanStt}${batchSuffix}-${idxStr}`;
      }

      const row: any = {
        code: boxCode,
        lot_id: targetLotId, // Gán vào Lot nếu an toàn, hoặc null nếu đợt quét trùng cần server quyết định
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
          tag: pallet.tag ? pallet.tag.trim().toUpperCase() : null,
          pallet_notes: pallet.notes ? pallet.notes.trim() : null,
          notes: pallet.notes ? pallet.notes.trim() : null,
          is_conflict_duplicate: isConflictDuplicate,
          conflict_lot_id: isConflictDuplicate ? foundLot.id : null,
          conflict_lot_code: isConflictDuplicate ? foundLot.code : null,
          conflict_lot_box_count: isConflictDuplicate ? existingBoxCount : null,
          scan_type: b.scan_type || 'label',
          stamp_line1: b.stamp_line1 || null,
          stamp_line2: b.stamp_line2 || null,
          box_index: b.box_index,
          sku: b.sku,
          product_name: b.product_name,
          spec: b.spec,
          shift_group: b.shift_group,
          production_place: b.shift_group || null,
          factory: b.shift_group || null,
          region: b.region,
          production_date: b.scan_type === 'stamp' ? null : (b.production_date || null),
          packaging_date: b.packaging_date || null,
          raw_material_date: b.scan_type === 'stamp' ? (b.raw_material_date || null) : null,
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

    // 3.1 Nếu Pallet có mã phụ (tag) và Lô đã tồn tại, đồng bộ vào bảng lot_tags của Web mẹ
    if (targetLotId && pallet.tag && pallet.tag.trim()) {
      const cleanTag = pallet.tag.trim().toUpperCase();
      try {
        const { data: existTag } = await client
          .from('lot_tags')
          .select('id')
          .eq('lot_id', targetLotId)
          .eq('tag', cleanTag)
          .maybeSingle();

        if (!existTag) {
          await client.from('lot_tags').insert({
            lot_id: targetLotId,
            tag: cleanTag,
            added_at: new Date().toISOString()
          });
        }
      } catch (tagErr) {
        console.warn('Lỗi ghi lot_tags:', tagErr);
      }
    }

    // 3.2 Nếu Pallet có ghi chú và Lô đã tồn tại nhưng chưa có ghi chú, cập nhật ghi chú cho Lô
    if (targetLotId && pallet.notes && pallet.notes.trim()) {
      try {
        const { data: currentLot } = await client
          .from('lots')
          .select('notes')
          .eq('id', targetLotId)
          .maybeSingle();

        if (currentLot && !currentLot.notes) {
          await client
            .from('lots')
            .update({ notes: pallet.notes.trim() })
            .eq('id', targetLotId);
        }
      } catch (noteErr) {
        console.warn('Lỗi cập nhật ghi chú lô:', noteErr);
      }
    }

    // 4. Đánh dấu Pallet trên thiết bị là đã đồng bộ
    await markPalletSynced(pallet.id);

    if (isConflictDuplicate) {
      return {
        success: true,
        isLinked: false,
        message: `ℹ️ Đã gửi ${boxes.length} thùng lên Web mẹ an toàn. STT "${sttCode}" đã có LOT "${targetLotCode}" (${existingBoxCount} thùng) trên hệ thống — Web mẹ sẽ hiển thị nhắc nhở để Quản lý phê duyệt phương án xử lý (Cập nhật, Tách LOT, hoặc Hủy)!`
      };
    } else if (isLinked) {
      return {
        success: true,
        isLinked: true,
        message: `✅ Đã kết nối thành công ${boxes.length} thùng vào LOT "${targetLotCode}" (STT: ${sttCode}) trên Web mẹ!`
      };
    } else {
      return {
        success: true,
        isLinked: false,
        message: `ℹ️ Đã lưu ${boxes.length} thùng lên mục "Chờ duyệt LOT". Trên Web mẹ chưa có LOT mang STT "${sttCode}". Khi Web tạo LOT, hệ thống sẽ tự động ghép nối!`
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
      const { data } = await client.from('lots').select('id, code').or(`code.eq.${sttCode},production_code.eq.${sttCode}`).maybeSingle();
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

/**
 * Xóa toàn bộ thùng của 1 Pallet trên Supabase khi người dùng xóa Pallet trên điện thoại
 */
export async function deletePalletFromSupabase(palletCode: string): Promise<{ success: boolean; message: string }> {
  try {
    const client = await getSupabaseClient();
    const sttCode = palletCode.trim().toUpperCase();
    
    // Xóa các thùng thuộc Pallet này (dựa vào metadata pallet_stt)
    const { error } = await client
      .from('box_labels')
      .delete()
      .filter('metadata->>pallet_stt', 'eq', sttCode);

    if (error) throw error;
    return { success: true, message: `Đã dọn dẹp dữ liệu của STT ${sttCode} trên máy chủ` };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

async function fetchAllPaginated<T>(
  client: any,
  table: string,
  selectQuery: string,
  applyFilter?: (q: any) => any,
  pageSize = 1000
): Promise<T[]> {
  let all: T[] = [];
  let from = 0;
  while (true) {
    let q = client.from(table).select(selectQuery).range(from, from + pageSize - 1);
    if (applyFilter) q = applyFilter(q);
    const { data, error } = await q;
    if (error) {
      console.error(`Error in fetchAllPaginated for ${table}:`, error);
      break;
    }
    if (!data || data.length === 0) break;
    all = [...all, ...data];
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/**
 * Tải toàn bộ danh sách Pallet/LOT từ Supabase (Web mẹ)
 * Bao gồm:
 * 1. Các LOT thực sự có tem thùng (box_labels!inner) - hỗ trợ phân trang tự động vượt qua 1000+ LOT
 * 2. Các Pallet ở mục Chưa kết nối (chờ duyệt LOT)
 */
export async function fetchCloudPallets(): Promise<{
  success: boolean;
  data: CloudPallet[];
  isFromCache?: boolean;
  message?: string;
}> {
  try {
    const client = await getSupabaseClient();
    const storedSys = await AsyncStorage.getItem('config_system_code');
    const systemCode = storedSys || 'KHO_DONG_LANH';

    // 1. Lấy danh sách các LOT có tem thùng (box_labels!inner) thuộc kho hiện tại
    // Tự động phân trang, không bị giới hạn 100 hay 1000 bản ghi
    const lots = await fetchAllPaginated<any>(
      client,
      'lots',
      `
        id,
        code,
        daily_seq,
        status,
        quantity,
        packaging_date,
        peeling_date,
        created_at,
        notes,
        metadata,
        system_code,
        products ( name, sku, aliases ),
        positions!positions_lot_id_fkey (
          code
        ),
        box_labels!inner (
          id,
          code,
          quantity,
          unit,
          metadata
        )
      `,
      q => q.eq('system_code', systemCode).order('created_at', { ascending: false })
    );

    // 2. Lấy danh sách các tem thùng ở mục Chưa kết nối (chờ duyệt LOT)
    const unlinkedBoxes = await fetchAllPaginated<any>(
      client,
      'box_labels',
      `
        id,
        code,
        quantity,
        unit,
        metadata,
        created_at,
        products ( name, sku, aliases )
      `,
      q => q.is('lot_id', null).order('created_at', { ascending: false })
    );

    const list: CloudPallet[] = [];
    const seenStts = new Set<string>();

    // Xử lý các Lô đã tạo trên Web
    (lots || []).forEach((l: any) => {
      const decoded = decodeSTT(l.daily_seq);
      const stt = decoded || l.metadata?.created_from_pallet_stt || l.code;
      if (!stt) return;
      
      const boxes = Array.isArray(l.box_labels) ? l.box_labels : [];
      const totalWeight = boxes.length > 0
        ? boxes.reduce((sum: number, b: any) => sum + (Number(b.quantity) || 0), 0)
        : (Number(l.quantity) * 20);

      // Trích xuất mã phụ tag nếu có trong box_labels metadata hoặc lot metadata
      let tag = l.metadata?.tag || null;
      if (!tag && boxes.length > 0) {
        for (const b of boxes) {
          if (b.metadata?.pallet_tag || b.metadata?.tag) {
            tag = b.metadata.pallet_tag || b.metadata.tag;
            break;
          }
        }
      }

      const firstBoxMeta = boxes[0]?.metadata || {};
      const productionPlace = l.metadata?.production_place || firstBoxMeta.production_place || firstBoxMeta.factory || firstBoxMeta.shift_group || null;
      const materialZone = l.metadata?.material_zone || firstBoxMeta.region || firstBoxMeta.province || null;
      const packagingDate = l.packaging_date || firstBoxMeta.packaging_date || null;
      const productionDate = l.peeling_date || firstBoxMeta.production_date || null;

      const isStamp = boxes.some((b: any) => 
        b.metadata?.scan_type === 'stamp' || 
        !!b.metadata?.stamp_line1 || 
        !!b.metadata?.stamp_line2 || 
        (b.code && b.code.startsWith('STAMP-'))
      );

      let isSpecial12 = false;
      const sampleL1 = firstBoxMeta.stamp_line1 || firstBoxMeta.sku || l.products?.sku || '';
      const c12 = sampleL1.replace(/[^0-9]/g, '').slice(0, 12);
      if (c12.length >= 12 && DEFAULT_STAMP_DICTIONARY.special_12?.[c12]) {
        isSpecial12 = true;
      }

      // Trích xuất vị trí kho (location / position)
      let locationCode: string | null = null;
      if (Array.isArray(l.positions) && l.positions.length > 0) {
        locationCode = l.positions.map((p: any) => p.code).filter(Boolean).join(', ');
      }
      if (!locationCode) {
        locationCode = l.metadata?.location_code || l.metadata?.location || l.metadata?.position || null;
      }

      list.push({
        id: l.id,
        stt: stt.trim().toUpperCase(),
        lot_code: l.code,
        lot_id: l.id,
        boxes_count: boxes.length > 0 ? boxes.length : (Number(l.quantity) || 0),
        total_weight: totalWeight,
        is_linked: true,
        status: l.status,
        product_name: l.products?.name || (firstBoxMeta.product_name ?? null),
        sku: l.products?.sku || (firstBoxMeta.sku ?? null),
        product_aliases: l.products?.aliases || firstBoxMeta.product_aliases || firstBoxMeta.aliases || null,
        tag,
        notes: l.notes || l.metadata?.notes || null,
        production_place: productionPlace,
        material_zone: materialZone,
        packaging_date: packagingDate,
        production_date: productionDate,
        location_code: locationCode,
        scan_type: isStamp ? 'stamp' : 'label',
        is_special_12: isSpecial12,
        created_at: l.created_at
      });
      seenStts.add(stt.trim().toUpperCase());
    });

    // Gom nhóm các tem chưa duyệt Lô theo pallet_stt
    const unlinkedMap = new Map<string, any[]>();
    (unlinkedBoxes || []).forEach((b: any) => {
      const rawStt = b.metadata?.pallet_stt;
      if (!rawStt) return;
      const cleanStt = String(rawStt).trim().toUpperCase();
      if (!unlinkedMap.has(cleanStt)) {
        unlinkedMap.set(cleanStt, []);
      }
      unlinkedMap.get(cleanStt)!.push(b);
    });

    unlinkedMap.forEach((boxes, stt) => {
      // Nếu STT này đã có trong Lots (ví dụ vừa được duyệt Lô), bỏ qua nhóm unlinked
      if (seenStts.has(stt)) return;

      const totalWeight = boxes.reduce((sum: number, b: any) => sum + (Number(b.quantity) || 0), 0);
      const firstMeta = boxes[0]?.metadata || {};
      const productionPlace = firstMeta.production_place || firstMeta.factory || firstMeta.shift_group || null;
      const materialZone = firstMeta.region || firstMeta.province || null;
      const packagingDate = firstMeta.packaging_date || null;
      const productionDate = firstMeta.production_date || null;
      const locationCode = firstMeta.location_code || firstMeta.location || firstMeta.position || null;

      const isStamp = boxes.some((b: any) => 
        b.metadata?.scan_type === 'stamp' || 
        !!b.metadata?.stamp_line1 || 
        !!b.metadata?.stamp_line2 || 
        (b.code && b.code.startsWith('STAMP-'))
      );
      let isSpecial12 = false;
      const sampleL1 = firstMeta.stamp_line1 || firstMeta.sku || boxes[0]?.products?.sku || '';
      const c12 = sampleL1.replace(/[^0-9]/g, '').slice(0, 12);
      if (c12.length >= 12 && DEFAULT_STAMP_DICTIONARY.special_12?.[c12]) {
        isSpecial12 = true;
      }

      list.push({
        id: 'unlinked_' + stt,
        stt,
        lot_code: null,
        lot_id: null,
        boxes_count: boxes.length,
        total_weight: totalWeight,
        is_linked: false,
        product_name: firstMeta.product_name || boxes[0]?.products?.name || null,
        sku: firstMeta.sku || boxes[0]?.products?.sku || null,
        product_aliases: boxes[0]?.products?.aliases || firstMeta.product_aliases || firstMeta.aliases || null,
        tag: firstMeta.pallet_tag || firstMeta.tag || null,
        notes: firstMeta.pallet_notes || firstMeta.notes || null,
        production_place: productionPlace,
        material_zone: materialZone,
        packaging_date: packagingDate,
        production_date: productionDate,
        location_code: locationCode,
        scan_type: isStamp ? 'stamp' : 'label',
        is_special_12: isSpecial12,
        created_at: boxes[0]?.created_at || new Date().toISOString()
      });
    });

    // Sắp xếp theo ngày tạo mới nhất lên đầu
    list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // Tự động lưu bản sao vào SQLite cache trên máy
    if (list.length > 0) {
      saveCloudPalletsToCache(list, true).catch(e => console.warn('Cache save error:', e));
      AsyncStorage.setItem('cloud_pallets_last_synced_at', new Date().toISOString());
      AsyncStorage.setItem('cloud_pallets_cached_count', String(list.length));
    }

    return { success: true, data: list, isFromCache: false };
  } catch (err: any) {
    console.warn('Lỗi fetchCloudPallets, tự động chuyển sang đọc từ SQLite Cache:', err.message);
    try {
      const cached = await getCloudPalletsFromCache();
      if (cached && cached.length > 0) {
        return {
          success: true,
          data: cached,
          isFromCache: true,
          message: 'Đang xem dữ liệu ngoại tuyến (Offline)'
        };
      }
    } catch {}
    return { success: false, data: [], message: err.message };
  }
}

/**
 * Tải chi tiết các thùng hàng của 1 Pallet trên Cloud (Supabase)
 * Tự động dự phòng đọc từ SQLite cache nếu mất mạng hoặc lỗi máy chủ (502/timeout)
 */
export async function fetchCloudPalletBoxes(
  stt: string,
  lotId?: string | null
): Promise<{ success: boolean; data: BoxLabel[]; message?: string; isFromCache?: boolean }> {
  const cleanStt = (stt || '').trim().toUpperCase();

  try {
    const client = await getSupabaseClient();
    let cloudBoxes: any[] = [];

    // 1. Nếu có lot_id: Truy vấn trực tiếp theo lot_id (dùng B-Tree Index, siêu nhanh, không bao giờ timeout/502)
    if (lotId) {
      const { data, error } = await client
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
        .eq('lot_id', lotId)
        .order('code', { ascending: true });

      if (error) throw error;
      cloudBoxes = data || [];
    }

    // 2. Nếu chưa có thùng (hoặc chưa gán lot_id), tìm theo metadata->>pallet_stt
    if (cloudBoxes.length === 0 && cleanStt) {
      const { data, error } = await client
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
        .filter('metadata->>pallet_stt', 'eq', cleanStt)
        .order('code', { ascending: true });

      if (!error && data) {
        cloudBoxes = data;
      }
    }

    const boxLabels: BoxLabel[] = cloudBoxes.map((b: any, idx: number) => {
      const meta = b.metadata || {};
      let boxIndex = String(meta.box_index || '');
      if (!boxIndex && b.code) {
        const parts = b.code.split('-');
        const last = parts[parts.length - 1];
        if (!isNaN(parseInt(last))) {
          boxIndex = parseInt(last, 10).toString();
        }
      }
      if (!boxIndex) boxIndex = String(idx + 1);

      let stampLine1 = meta.stamp_line1 || '';
      let stampLine2 = meta.stamp_line2 || b.finished_lot_code || b.semi_finished_lot_code || '';
      if (!stampLine1 && b.code?.startsWith('STAMP-')) {
        const parts = b.code.split('-');
        if (parts.length >= 3) {
          stampLine1 = parts[1] || '';
          stampLine2 = parts[2] || '';
        }
      }

      const isStamp = meta.scan_type === 'stamp' || !!stampLine1 || !!stampLine2 || (b.code && b.code.startsWith('STAMP-'));

      // Kiểm tra ngoại lệ 12 số trọn gói (special_12)
      let isSpecial12 = false;
      let special12Code = '';
      let special12Name = '';
      const rawL1 = stampLine1 || meta.sku || b.products?.sku || '';
      const c12 = rawL1.replace(/[^0-9]/g, '').slice(0, 12);
      if (c12.length >= 12 && DEFAULT_STAMP_DICTIONARY.special_12?.[c12]) {
        isSpecial12 = true;
        special12Code = c12;
        special12Name = DEFAULT_STAMP_DICTIONARY.special_12[c12];
      }

      // Giải mã Dòng 2 cho trường hợp con dấu (Ink Stamp)
      let factory = meta.shift_group || '';
      let packagingDate = meta.packaging_date || '';
      let rawMaterialDate = meta.raw_material_date || meta.production_date || '';
      let supplierCode = meta.supplier || meta.supplier_code || '';
      let supplierName = '';
      let province = meta.region || '';

      if (isStamp && stampLine2) {
        const cleanL2 = stampLine2.replace(/[^0-9]/g, '');
        if (cleanL2.length >= 1) {
          const fCode = cleanL2.substring(0, 1);
          if (!factory) factory = DEFAULT_STAMP_DICTIONARY.factory?.[fCode] || `Nhà máy ${fCode}`;
        }
        if (cleanL2.length >= 5 && !packagingDate) {
          packagingDate = `${cleanL2.substring(1, 3)}/${cleanL2.substring(3, 5)}`;
        }
        if (cleanL2.length >= 11 && !rawMaterialDate) {
          const DD = cleanL2.substring(5, 7);
          const MM = cleanL2.substring(7, 9);
          const YY = cleanL2.substring(9, 11);
          rawMaterialDate = `${DD}/${MM}/20${YY}`;
        }
        if (cleanL2.length >= 14 && !supplierCode) {
          supplierCode = cleanL2.substring(11, 14);
        }
        if (cleanL2.length >= 16 && !province) {
          const pCode = cleanL2.substring(14, 16);
          province = DEFAULT_STAMP_DICTIONARY.province?.[pCode] || `Tỉnh mã ${pCode}`;
        }
      }

      if (supplierCode) {
        supplierName = `Mã NCC ${supplierCode}`;
      }

      // Xác định quy cách chuẩn xác: nếu là ngoại lệ 12 số, ẩn phân đoạn 14 số chuẩn
      let specVal = meta.spec || '';
      if (isSpecial12 && special12Name) {
        const parts = special12Name.split(' - ').map((s: string) => s.trim());
        specVal = parts.length >= 2 ? `${parts[1]}${parts[2] ? ` (${parts[2]})` : ''}` : 'Ngoại lệ trọn gói';
      }

      return {
        id: b.id,
        pallet_id: 'cloud_' + cleanStt,
        sku: isSpecial12 ? special12Code : (meta.sku || b.products?.sku || 'SKU'),
        lot_code: b.finished_lot_code || b.semi_finished_lot_code || meta.lot_code || stampLine2 || 'LOT',
        product_name: isSpecial12 ? special12Name : (meta.product_name || b.products?.name || b.products?.internal_name || 'Hàng đông lạnh'),
        box_index: boxIndex,
        weight: Number(b.quantity) || 20,
        unit: b.unit || 'Kg',
        shift_group: factory,
        region: province,
        production_date: isStamp ? '' : (meta.production_date || ''),
        packaging_date: packagingDate,
        raw_material_date: isStamp ? rawMaterialDate : '',
        supplier: supplierCode,
        supplier_name: supplierName,
        spec: specVal,
        raw_text: meta.raw_text || '',
        scan_type: isStamp ? 'stamp' : (meta.scan_type || 'label'),
        stamp_line1: stampLine1 || null,
        stamp_line2: stampLine2 || null,
        is_special_12: isSpecial12,
        special_12_code: special12Code,
        special_12_name: special12Name,
        sync_status: 'synced',
        created_at: b.created_at
      };
    });

    // Sắp xếp theo box_index
    boxLabels.sort((a, b) => (parseInt(a.box_index, 10) || 0) - (parseInt(b.box_index, 10) || 0));

    // Lưu bản sao tem thùng vào SQLite cache trên máy
    if (boxLabels.length > 0) {
      saveCloudBoxesToCache(cleanStt, lotId, boxLabels).catch(e => console.warn('Cache boxes save error:', e));
    }

    return { success: true, data: boxLabels, isFromCache: false };
  } catch (err: any) {
    console.warn('Lỗi kết nối khi tải chi tiết thùng, tự động đọc từ SQLite cache:', err?.message);

    // Tự động dự phòng đọc từ SQLite cache trên máy
    try {
      const cached = await getCloudBoxesFromCache(cleanStt, lotId);
      if (cached && cached.length > 0) {
        return {
          success: true,
          data: cached,
          isFromCache: true,
          message: 'Đang xem dữ liệu thùng ngoại tuyến (Offline)'
        };
      }
    } catch {}

    return {
      success: false,
      data: [],
      message: 'Không thể kết nối máy chủ để tải thùng và máy chưa có bản lưu ngoại tuyến.'
    };
  }
}

export interface ProductSuggestion {
  id: string;
  name: string;
  sku: string;
  aliases?: string | null;
}

/**
 * Tải danh mục sản phẩm từ Web mẹ để gợi ý autocomplete khi người dùng tìm kiếm / gõ tắt
 */
export async function fetchProductsForSuggestions(): Promise<ProductSuggestion[]> {
  try {
    const client = await getSupabaseClient();
    const storedSys = await AsyncStorage.getItem('config_system_code');
    const systemCode = storedSys || 'KHO_DONG_LANH';

    const { data, error } = await client
      .from('products')
      .select('id, name, sku, aliases')
      .eq('system_type', systemCode)
      .order('name');

    let products = data;
    if (error || !products || products.length === 0) {
      const { data: allData } = await client
        .from('products')
        .select('id, name, sku, aliases')
        .order('name')
        .limit(500);
      products = allData || [];
    }

    if (products && products.length > 0) {
      saveProductsToCache(products).catch(e => console.warn('Cache products error:', e));
      return products;
    }

    return await getProductsFromCache();
  } catch (e) {
    console.warn('fetchProductsForSuggestions error, using cache:', e);
    return await getProductsFromCache();
  }
}

/**
 * Tải đồng bộ toàn bộ LOT và danh mục sản phẩm về SQLite để xem ngoại tuyến (Offline)
 */
export async function syncCloudPalletsOffline(options?: {
  forceFull?: boolean;
}): Promise<{ success: boolean; count: number; message: string; lastSyncedAt?: string }> {
  try {
    const palletRes = await fetchCloudPallets();
    const products = await fetchProductsForSuggestions();

    if (!palletRes.success && palletRes.data.length === 0) {
      return {
        success: false,
        count: 0,
        message: palletRes.message || 'Không thể kết nối máy chủ để tải dữ liệu'
      };
    }

    const now = new Date().toISOString();
    await AsyncStorage.setItem('cloud_pallets_last_synced_at', now);
    await AsyncStorage.setItem('cloud_pallets_cached_count', String(palletRes.data.length));

    return {
      success: true,
      count: palletRes.data.length,
      lastSyncedAt: now,
      message: `Đã lưu thành công ${palletRes.data.length} LOT vào máy để xem ngoại tuyến!`
    };
  } catch (err: any) {
    return { success: false, count: 0, message: err.message };
  }
}

/**
 * Lấy thông tin lần đồng bộ offline cuối
 */
export async function getLastOfflineSyncInfo(): Promise<{
  lastSyncedAt: string | null;
  count: number;
}> {
  try {
    const time = await AsyncStorage.getItem('cloud_pallets_last_synced_at');
    const countStr = await AsyncStorage.getItem('cloud_pallets_cached_count');
    return {
      lastSyncedAt: time,
      count: parseInt(countStr || '0', 10) || 0
    };
  } catch {
    return { lastSyncedAt: null, count: 0 };
  }
}

export interface WarehouseMapOfflineData {
  zones: any[];
  positions: any[];
  cachedAt: string;
  totalPositions: number;
  totalWarehouses: number;
}

/**
 * Tải đồng bộ toàn bộ Sơ Đồ Kho (Zones, Positions, Lots gán vị trí) về máy để xem ngoại tuyến (Offline)
 */
export async function syncWarehouseMapOffline(): Promise<{
  success: boolean;
  totalPositions: number;
  totalWarehouses: number;
  lastSyncedAt?: string;
  message: string;
}> {
  try {
    const client = await getSupabaseClient();

    // 1. Fetch Zones for Cold Storage
    const { data: zonesData, error: zonesErr } = await client
      .from('zones')
      .select('id, name, parent_id, system_type')
      .eq('system_type', 'KHO_DONG_LANH');

    if (zonesErr) throw zonesErr;
    const rawZones = zonesData || [];

    // 2. Fetch all positions & zone associations
    const [posRes, zpRes] = await Promise.all([
      client
        .from('positions')
        .select('id, code, lot_id, system_type')
        .eq('system_type', 'KHO_DONG_LANH'),
      client.from('zone_positions').select('position_id, zone_id')
    ]);

    if (posRes.error) throw posRes.error;

    const rawPositions = posRes.data || [];
    const zpList = zpRes.data || [];

    const zpMap = new Map<string, string[]>();
    zpList.forEach((item: any) => {
      const list = zpMap.get(item.position_id) || [];
      list.push(item.zone_id);
      zpMap.set(item.position_id, list);
    });

    // 3. Fetch Lots info for occupied positions in chunks of 100 (avoids HTTP 414 Request-URI Too Long)
    const occupiedLotIds = Array.from(new Set(rawPositions.map((p: any) => p.lot_id).filter(Boolean)));
    const lotMap = new Map<string, any>();

    if (occupiedLotIds.length > 0) {
      const CHUNK_SIZE = 100;
      const chunkPromises: Promise<any>[] = [];
      for (let i = 0; i < occupiedLotIds.length; i += CHUNK_SIZE) {
        const chunk = occupiedLotIds.slice(i, i + CHUNK_SIZE);
        chunkPromises.push(
          client
            .from('lots')
            .select(`
              id,
              code,
              daily_seq,
              packaging_date,
              inbound_date,
              quantity,
              products ( name, sku, unit, aliases ),
              lot_items ( quantity, unit, products ( name, sku, unit, aliases ) ),
              lot_tags ( tag )
            `)
            .in('id', chunk)
        );
      }

      const chunkResults = await Promise.all(chunkPromises);
      chunkResults.forEach((res: any) => {
        if (res.data) {
          res.data.forEach((l: any) => {
            const tags = (l.lot_tags || []).map((t: any) => t.tag).filter(Boolean);
            const tagsStr = tags.length > 0 ? tags.join(', ') : '';

            const allItems = l.lot_items || [];
            const allProdNames = [
              l.products?.name,
              ...allItems.map((it: any) => it.products?.name)
            ].filter(Boolean);
            const prodName = allProdNames.length > 0
              ? allProdNames.join(', ')
              : (tagsStr ? `Hàng ${tagsStr}` : 'Hàng đông lạnh');

            const allSkus = [
              l.products?.sku,
              ...allItems.map((it: any) => it.products?.sku)
            ].filter(Boolean);
            const sku = allSkus.length > 0 ? allSkus.join(', ') : (tags.length > 0 ? tags[0] : '---');

            const allAliases = [
              l.products?.aliases,
              ...allItems.map((it: any) => it.products?.aliases)
            ].filter(Boolean);
            const aliases = allAliases.length > 0 ? allAliases.join(', ') : null;

            const unit =
              l.products?.unit ||
              l.lot_items?.[0]?.unit ||
              'Thùng';

            lotMap.set(l.id, {
              code: l.code,
              stt: l.daily_seq ? decodeSTT(l.daily_seq) : null,
              product_name: prodName,
              sku,
              aliases,
              unit,
              tags,
              packaging_date: l.packaging_date ? String(l.packaging_date).split('T')[0] : null,
              inbound_date: l.inbound_date ? String(l.inbound_date).split('T')[0] : null,
              quantity: l.quantity || (l.lot_items?.[0]?.quantity ?? null)
            });
          });
        }
      });
    }

    // 4. Fetch pending assignments
    const { data: pendingData } = await client
      .from('pending_assignments')
      .select('position_id, lot_stt, production_date')
      .eq('system_code', 'KHO_DONG_LANH')
      .eq('status', 'pending');

    const pendingMap = new Map<string, any>();
    pendingData?.forEach((p: any) => {
      if (p.position_id) {
        pendingMap.set(p.position_id, {
          stt: decodeSTT(p.lot_stt),
          packaging_date: p.production_date
        });
      }
    });

    // 5. Combine into formatted positions
    const formattedPositions = rawPositions.map((p: any) => {
      const lotInfo = p.lot_id ? lotMap.get(p.lot_id) : null;
      const pendInfo = pendingMap.get(p.id);

      const stt = lotInfo?.stt || pendInfo?.stt || null;
      const lotCode = lotInfo?.code || (pendInfo ? 'Chờ duyệt LOT' : null);
      const productName = lotInfo?.product_name || (pendInfo ? 'Đang chờ gán LOT' : null);
      const sku = lotInfo?.sku || null;
      const aliases = lotInfo?.aliases || null;
      const unit = lotInfo?.unit || 'Thùng';
      const tags = lotInfo?.tags || [];
      const pkgDate = lotInfo?.packaging_date || pendInfo?.packaging_date || null;

      return {
        id: p.id,
        code: p.code,
        lot_id: p.lot_id || (pendInfo ? 'pending' : null),
        zone_ids: zpMap.get(p.id) || [],
        stt,
        lot_code: lotCode,
        product_name: productName,
        sku,
        aliases,
        unit,
        tags,
        packaging_date: pkgDate,
        inbound_date: lotInfo?.inbound_date || null,
        quantity: lotInfo?.quantity || null
      };
    });

    const now = new Date().toISOString();
    const warehousesCount = rawZones.filter((z: any) => !z.parent_id).length;

    const snapshot: WarehouseMapOfflineData = {
      zones: rawZones,
      positions: formattedPositions,
      cachedAt: now,
      totalPositions: formattedPositions.length,
      totalWarehouses: warehousesCount
    };

    await AsyncStorage.setItem('warehouse_map_offline_cache', JSON.stringify(snapshot));
    await AsyncStorage.setItem('warehouse_map_cached_at', now);
    await AsyncStorage.setItem('warehouse_map_cached_count', String(formattedPositions.length));
    await AsyncStorage.setItem('warehouse_map_cached_warehouses', String(warehousesCount));

    return {
      success: true,
      totalPositions: formattedPositions.length,
      totalWarehouses: warehousesCount,
      lastSyncedAt: now,
      message: `Đã lưu thành công ${formattedPositions.length} vị trí (${warehousesCount} kho) vào máy để xem ngoại tuyến!`
    };
  } catch (err: any) {
    return {
      success: false,
      totalPositions: 0,
      totalWarehouses: 0,
      message: err.message || 'Lỗi khi tải dữ liệu sơ đồ kho ngoại tuyến'
    };
  }
}

/**
 * Lấy dữ liệu Sơ Đồ Kho Offline đã lưu trong máy
 */
export async function getWarehouseMapOfflineData(): Promise<WarehouseMapOfflineData | null> {
  try {
    const raw = await AsyncStorage.getItem('warehouse_map_offline_cache');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lấy thông tin lần đồng bộ Sơ Đồ Kho Offline cuối
 */
export async function getLastWarehouseMapOfflineSyncInfo(): Promise<{
  lastSyncedAt: string | null;
  count: number;
  warehousesCount: number;
}> {
  try {
    const time = await AsyncStorage.getItem('warehouse_map_cached_at');
    const countStr = await AsyncStorage.getItem('warehouse_map_cached_count');
    const whCountStr = await AsyncStorage.getItem('warehouse_map_cached_warehouses');
    return {
      lastSyncedAt: time,
      count: parseInt(countStr || '0', 10) || 0,
      warehousesCount: parseInt(whCountStr || '0', 10) || 0
    };
  } catch {
    return { lastSyncedAt: null, count: 0, warehousesCount: 0 };
  }
}
