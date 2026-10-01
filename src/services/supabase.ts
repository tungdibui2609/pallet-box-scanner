import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pallet, BoxLabel } from '../types';
import { markPalletSynced, markPalletSyncError } from './database';

export const DEFAULT_SUPABASE_URL = 'https://api.chanhthu.click';
export const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

export async function getSupabaseClient() {
  const storedUrl = await AsyncStorage.getItem('config_supabase_url');
  const storedKey = await AsyncStorage.getItem('config_supabase_key');

  const url = storedUrl || DEFAULT_SUPABASE_URL;
  const key = storedKey || DEFAULT_ANON_KEY;

  return createClient(url, key, {
    auth: {
      storage: AsyncStorage,
      persistSession: false,
      autoRefreshToken: false,
    }
  });
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

/**
 * Sync Pallet & Boxes into Supabase:
 * 1. Checks if a Lot/Pallet with this STT (e.g. F3500) already exists in 'lots' table
 * 2. If exists -> binds all box_labels to that lot_id!
 * 3. If not exists -> creates lot 'F3500' and binds all box_labels to it!
 */
export async function syncPalletToSupabase(pallet: Pallet, boxes: BoxLabel[]): Promise<{ success: boolean; message: string }> {
  try {
    const client = await getSupabaseClient();
    const sttCode = pallet.code.trim().toUpperCase();

    // 1. Check if lot exists by code or production_code
    let targetLotId: string | null = null;
    let targetLotCode = sttCode;

    const { data: foundLot } = await client
      .from('lots')
      .select('id, code, production_code, system_code')
      .or(`code.ilike.%${sttCode}%,production_code.ilike.%${sttCode}%`)
      .maybeSingle();

    if (foundLot) {
      targetLotId = foundLot.id;
      targetLotCode = foundLot.code;
    } else {
      // Create new lot in 'lots' table if not already created
      const { data: newLot, error: newLotErr } = await (client.from('lots') as any)
        .insert({
          code: sttCode,
          production_code: sttCode,
          system_code: pallet.system_code || 'KHO_DONG_LANH',
          status: 'active',
        })
        .select('id, code')
        .single();

      if (!newLotErr && newLot) {
        targetLotId = newLot.id;
        targetLotCode = newLot.code;
      }
    }

    // 1.5. RE-SCAN / UPDATE MODE: If lot already exists, unlink previous boxes that are not in this pallet
    if (targetLotId) {
      await (client.from('box_labels') as any)
        .update({ lot_id: null, status: 'printed' })
        .eq('lot_id', targetLotId);
    }

    // 2. Prepare Box Labels payload
    const boxRows = boxes.map(b => {
      const cleanSku = (b.sku || 'SKU').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const cleanLot = (b.lot_code || 'LOT').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const idxStr = String(b.box_index || '0').padStart(3, '0');
      const boxCode = `BOX-${cleanLot}-${cleanSku}-${idxStr}`;

      return {
        code: boxCode,
        lot_id: targetLotId, // Gán trực tiếp vào STT Pallet trên web
        quantity: b.weight || 20,
        unit: b.unit || 'Kg',
        semi_finished_lot_code: b.lot_code,
        finished_lot_code: b.lot_code,
        system_code: pallet.system_code || 'KHO_DONG_LANH',
        status: 'linked',
        created_at: b.created_at
      };
    });

    // 3. Upsert into box_labels
    const { error: boxErr } = await (client.from('box_labels') as any)
      .upsert(boxRows, { onConflict: 'code' });

    if (boxErr) {
      throw new Error('Lỗi đồng bộ thùng: ' + boxErr.message);
    }

    // 4. Mark locally as synced
    await markPalletSynced(pallet.id);
    return {
      success: true,
      message: targetLotId
        ? `Đã tìm thấy STT ${targetLotCode} và gán thành công ${boxes.length} thùng!`
        : `Đã lưu ${boxes.length} thùng cho STT ${sttCode} thành công!`
    };
  } catch (err: any) {
    await markPalletSyncError(pallet.id, err.message);
    return { success: false, message: err.message };
  }
}