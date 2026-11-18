import AsyncStorage from '@react-native-async-storage/async-storage';

export const STORAGE_KEY_DEFAULT_TARGET_BOX_QTY = 'config_default_target_box_qty';
export const STORAGE_KEY_AUTO_COMPLETE_PALLET_ON_FULL = 'config_auto_complete_pallet_on_full';
export const FALLBACK_TARGET_BOX_QTY = 30;

/**
 * Lấy mục tiêu số thùng mặc định cho 1 Pallet từ AsyncStorage (mặc định là 30 nếu chưa cấu hình).
 */
export async function getDefaultTargetBoxQty(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_DEFAULT_TARGET_BOX_QTY);
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[AppSettings] Không thể đọc default_target_box_qty:', err);
  }
  return FALLBACK_TARGET_BOX_QTY;
}

/**
 * Lưu mục tiêu số thùng mặc định cho 1 Pallet vào AsyncStorage.
 */
export async function setDefaultTargetBoxQty(qty: number): Promise<number> {
  const safeQty = Math.max(1, Math.floor(qty || FALLBACK_TARGET_BOX_QTY));
  try {
    await AsyncStorage.setItem(STORAGE_KEY_DEFAULT_TARGET_BOX_QTY, String(safeQty));
  } catch (err) {
    console.warn('[AppSettings] Không thể lưu default_target_box_qty:', err);
  }
  return safeQty;
}

/**
 * Lấy cài đặt ghi nhớ: Có tự động chốt Pallet khi quét đủ số lượng thùng mục tiêu hay không.
 * Mặc định: true (khi người dùng bật dấu tích sẽ tự động chốt khi đủ số thùng).
 */
export async function getAutoCompletePalletOnFull(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_AUTO_COMPLETE_PALLET_ON_FULL);
    if (raw !== null) {
      return raw === 'true';
    }
  } catch (err) {
    console.warn('[AppSettings] Không thể đọc auto_complete_pallet_on_full:', err);
  }
  // Mặc định ban đầu bật true để tối ưu trải nghiệm công nhân
  return true;
}

/**
 * Lưu cài đặt ghi nhớ: Tự động chốt Pallet khi quét đủ số lượng thùng.
 */
export async function setAutoCompletePalletOnFull(enabled: boolean): Promise<boolean> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_AUTO_COMPLETE_PALLET_ON_FULL, enabled ? 'true' : 'false');
  } catch (err) {
    console.warn('[AppSettings] Không thể lưu auto_complete_pallet_on_full:', err);
  }
  return enabled;
}
