import AsyncStorage from '@react-native-async-storage/async-storage';

const WATERMARK_ENABLED_KEY = 'solieu_watermark_enabled';

export interface WatermarkPayload {
  uri: string;
  width?: number;
  height?: number;
  systemCode: string;
  jobName?: string | null;
  itemName?: string | null;
  quantity?: number | null;
  unit?: string | null;
  direction?: 'in' | 'out' | null;
  capturedByName?: string | null;
  capturedAt?: Date;
}

type WatermarkProcessor = (payload: WatermarkPayload) => Promise<string>;

let registeredProcessor: WatermarkProcessor | null = null;

export function registerWatermarkProcessor(processor: WatermarkProcessor | null): void {
  registeredProcessor = processor;
}

export async function getWatermarkEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(WATERMARK_ENABLED_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export async function setWatermarkEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(WATERMARK_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (err) {
    console.warn('setWatermarkEnabled error:', err);
  }
}

/**
 * Đóng dấu thông tin (ngày giờ, kho, công việc, sản phẩm, số lượng, người chụp) lên ảnh.
 * Nếu tắt watermark hoặc processor chưa sẵn sàng/lỗi thì trả về URI gốc an toàn.
 */
export async function applyOperationWatermark(payload: WatermarkPayload): Promise<string> {
  try {
    const enabled = await getWatermarkEnabled();
    if (!enabled || !registeredProcessor) {
      return payload.uri;
    }
    const stampedUri = await registeredProcessor(payload);
    return stampedUri || payload.uri;
  } catch (err) {
    console.warn('applyOperationWatermark fallback to original:', err);
    return payload.uri;
  }
}
