import AsyncStorage from '@react-native-async-storage/async-storage';
import { syncCloudPalletsOffline, syncStampDictionariesFromSupabase, syncWarehouseMapOffline, testConnection } from './supabase';
import { getSubmittedAdjustmentProposals, syncOfflineAdjustmentProposals } from './warehouseAdjustmentService';
import { getJobTemplates, getOrderTypes } from './operationsService';

const AUTO_SYNC_STORAGE_KEY = 'config_auto_sync_offline_v2';
const LAST_AUTO_SYNC_KEY = 'last_auto_sync_timestamp';

let isAutoSyncing = false;

/**
 * Kiểm tra người dùng có bật chế độ Tự động tải ngầm hay không
 * Mặc định: FALSE (Tắt tải ngầm để ưu tiên người dùng chủ động bấm tải trước mỗi ca làm việc, tránh lag & timeout trong kho đông)
 */
export async function isAutoSyncEnabled(): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(AUTO_SYNC_STORAGE_KEY);
    return val === 'true';
  } catch {
    return false;
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

  isAutoSyncing = true;
  try {
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

    // 1. Kiểm tra kết nối máy chủ thật
    const conn = await testConnection();
    if (!conn.success) {
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

/**
 * Đồng bộ toàn bộ dữ liệu kho All-in-One (Người dùng chủ động bấm):
 * 1. Sơ đồ kho (7.820 vị trí + Pallet có hàng)
 * 2. Dữ liệu LOT & Tem thùng
 * 3. Quy tắc dấu đóng & từ điển tem
 */
export async function syncAllWarehouseDataMaster(): Promise<{
  success: boolean;
  totalPositions: number;
  totalWarehouses: number;
  totalLots: number;
  totalProposals: number;
  message: string;
}> {
  try {
    const syncProposalsTask = async () => {
      await syncOfflineAdjustmentProposals().catch(() => 0);
      const list = await getSubmittedAdjustmentProposals('KHO_DONG_LANH');
      return list.length;
    };

    const [whMapRes, palletRes, stampRes, proposalCount, templatesList, orderTypesList] = await Promise.all([
      syncWarehouseMapOffline().catch(e => ({ success: false, totalPositions: 0, totalWarehouses: 0, message: e.message })),
      syncCloudPalletsOffline().catch(e => ({ success: false, count: 0, message: e.message })),
      syncStampDictionariesFromSupabase().catch(e => ({ success: false, count: 0, message: e.message })),
      syncProposalsTask().catch(() => 0),
      getJobTemplates().catch(() => []),
      getOrderTypes().catch(() => []),
    ]);

    const posCount = (whMapRes as any).success ? (whMapRes as any).totalPositions : 0;
    const whCount = (whMapRes as any).success ? (whMapRes as any).totalWarehouses : 0;
    const lotCount = palletRes.success ? palletRes.count : 0;
    const tplCount = Array.isArray(templatesList) ? templatesList.length : 0;

    const ok = (whMapRes as any).success || palletRes.success;

    return {
      success: ok,
      totalPositions: posCount,
      totalWarehouses: whCount,
      totalLots: lotCount,
      totalProposals: proposalCount,
      message: ok
        ? `Đã tải thành công ${posCount} vị trí (${whCount} kho), ${lotCount} LOT, ${proposalCount} phiếu nháp và ${tplCount} công việc mẫu. Dữ liệu đã sẵn sàng cho tất cả các tính năng!`
        : `Lỗi: ${(whMapRes as any).message || palletRes.message || 'Không thể kết nối máy chủ'}`
    };
  } catch (err: any) {
    return {
      success: false,
      totalPositions: 0,
      totalWarehouses: 0,
      totalLots: 0,
      totalProposals: 0,
      message: err.message || 'Lỗi không xác định'
    };
  }
}

