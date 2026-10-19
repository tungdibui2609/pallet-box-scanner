import AsyncStorage from '@react-native-async-storage/async-storage';
import { syncCloudPalletsOffline, syncStampDictionariesFromSupabase, syncWarehouseMapOffline, testConnection } from './supabase';

const AUTO_SYNC_STORAGE_KEY = 'config_auto_sync_offline';
const LAST_AUTO_SYNC_KEY = 'last_auto_sync_timestamp';

let isAutoSyncing = false;

/**
 * Kiểm tra người dùng có bật chế độ Tự động tải ngầm hay không (Mặc định: true)
 */
export async function isAutoSyncEnabled(): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(AUTO_SYNC_STORAGE_KEY);
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

/**
 * Cập nhật trạng thái Bật / Tắt chế độ Tự động tải ngầm
 */
export async function setAutoSyncEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(AUTO_SYNC_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch (e) {
    console.warn('Lỗi lưu cấu hình AutoSync:', e);
  }
}

/**
 * Kích hoạt chạy đồng bộ ngầm toàn bộ dữ liệu LOT & Quy tắc dấu đóng
 * - Không làm lag hay đơ giao diện người dùng
 * - Tự động bỏ qua nếu đang chạy hoặc vừa đồng bộ gần đây (tránh tốn pin & mạng)
 */
export async function triggerBackgroundAutoSync(options?: {
  reason?: string;
  force?: boolean;
  minIntervalMinutes?: number;
}): Promise<{ executed: boolean; message?: string }> {
  if (isAutoSyncing) {
    return { executed: false, message: 'Đang có tiến trình đồng bộ ngầm khác' };
  }

  const enabled = await isAutoSyncEnabled();
  if (!enabled && !options?.force) {
    return { executed: false, message: 'Chế độ tự động tải ngầm đang tắt' };
  }

  const minInterval = (options?.minIntervalMinutes ?? 10) * 60 * 1000;
  if (!options?.force) {
    try {
      const lastStr = await AsyncStorage.getItem(LAST_AUTO_SYNC_KEY);
      if (lastStr) {
        const last = parseInt(lastStr, 10);
        if (Date.now() - last < minInterval) {
          return { executed: false, message: 'Dữ liệu còn mới, bỏ qua tự động tải' };
        }
      }
    } catch {}
  }

  isAutoSyncing = true;
  try {
    // 1. Kiểm tra kết nối máy chủ thật
    const conn = await testConnection();
    if (!conn.success) {
      isAutoSyncing = false;
      return { executed: false, message: 'Không thể kết nối máy chủ' };
    }

    console.log(`[AutoSync] Bắt đầu tải ngầm tự động (${options?.reason || 'Định kỳ'})...`);

    // 2. Tải ngầm danh sách LOT, Quy tắc & Sơ đồ kho tuần tự
    const palletRes = await syncCloudPalletsOffline().catch(e => ({ success: false, count: 0, message: e.message }));
    const stampRes = await syncStampDictionariesFromSupabase().catch(e => ({ success: false, count: 0, message: e.message }));
    const whMapRes = await syncWarehouseMapOffline().catch(e => ({ success: false, totalPositions: 0, message: e.message }));

    await AsyncStorage.setItem(LAST_AUTO_SYNC_KEY, String(Date.now()));

    let palletCount = palletRes.success ? palletRes.count : 0;
    let whPosCount = whMapRes.success ? whMapRes.totalPositions : 0;

    console.log(`[AutoSync] Hoàn tất tải ngầm thành công: ${palletCount} LOT, ${whPosCount} vị trí kho.`);
    return {
      executed: true,
      message: `Đã tự động tải ngầm ${palletCount} LOT và ${whPosCount} vị trí kho thành công`
    };
  } catch (err: any) {
    console.warn('[AutoSync] Lỗi trong quá trình tải ngầm:', err?.message);
    return { executed: false, message: err?.message };
  } finally {
    isAutoSyncing = false;
  }
}
