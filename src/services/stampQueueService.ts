import { getSupabaseClient, withTimeout } from './supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';

export interface SubmitStampQueueParams {
  photoUri: string;
  cropPhotoUri?: string | null;
  palletStt: string;
  palletTag?: string | null;
  palletNotes?: string | null;
  boxCount: number;
  boxWeight: number;
}

export interface StampQueueItemMobile {
  id: string;
  pallet_stt: string;
  pallet_tag?: string | null;
  pallet_notes?: string | null;
  box_count: number;
  box_weight: number;
  image_url: string;
  cropped_image_url?: string | null;
  drive_file_id?: string | null;
  drive_view_url?: string | null;
  status: 'pending' | 'decoded' | 'approved' | 'error';
  stamp_line1?: string | null;
  stamp_line2?: string | null;
  decoded_json?: any;
  created_at: string;
  created_by_name?: string | null;
  error_message?: string | null;
  approved_lot_code?: string | null;
}

const STAMP_OFFLINE_QUEUE_KEY = 'stamp_offline_queue_v1';
let isStampSyncing = false;

export interface StampQueueBackgroundItem {
  id: string;
  type: 'ai_queue' | 'box_stamp_photo';
  photoUri: string;
  cropPhotoUri?: string | null;
  palletStt: string;
  palletTag?: string | null;
  palletNotes?: string | null;
  boxCount?: number;
  boxWeight?: number;
  createdAt: string;
  retryCount?: number;
}

/**
 * Thêm ảnh con dấu vào hàng đợi đồng bộ ngầm (Thao tác 0ms - không làm đứng màn hình)
 */
export async function enqueueStampPhotoForBackgroundSync(
  params: SubmitStampQueueParams
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STAMP_OFFLINE_QUEUE_KEY);
    const queue: StampQueueBackgroundItem[] = raw ? JSON.parse(raw) : [];

    const newItem: StampQueueBackgroundItem = {
      id: 'st_bg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: 'ai_queue',
      photoUri: params.photoUri,
      cropPhotoUri: params.cropPhotoUri || null,
      palletStt: params.palletStt,
      palletTag: params.palletTag,
      palletNotes: params.palletNotes,
      boxCount: params.boxCount,
      boxWeight: params.boxWeight,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };

    queue.push(newItem);
    await AsyncStorage.setItem(STAMP_OFFLINE_QUEUE_KEY, JSON.stringify(queue));

    // Kích hoạt tiến trình đồng bộ ngầm ngay (không await để UI phản hồi tức thời)
    setTimeout(() => {
      processBackgroundStampQueue().catch(() => {});
    }, 100);
  } catch (err) {
    console.warn('[StampQueue] Lỗi đưa vào hàng đợi ngầm:', err);
  }
}

/**
 * Xử lý hàng đợi đồng bộ ngầm khi có mạng (Background Worker)
 */
export async function processBackgroundStampQueue(
  onProgress?: (remaining: number, justSyncedItem?: any) => void
): Promise<number> {
  if (isStampSyncing) return 0;
  isStampSyncing = true;

  try {
    const raw = await AsyncStorage.getItem(STAMP_OFFLINE_QUEUE_KEY);
    if (!raw) return 0;
    const queue: StampQueueBackgroundItem[] = JSON.parse(raw);
    if (!queue.length) return 0;

    const remaining: StampQueueBackgroundItem[] = [];
    let syncedCount = 0;

    for (const item of queue) {
      try {
        if (item.type === 'ai_queue') {
          const res = await submitStampPhotoToQueue({
            photoUri: item.photoUri,
            cropPhotoUri: item.cropPhotoUri,
            palletStt: item.palletStt,
            palletTag: item.palletTag,
            palletNotes: item.palletNotes,
            boxCount: item.boxCount || 30,
            boxWeight: item.boxWeight || 20,
          });
          syncedCount++;

          // Tự động xóa file ảnh tạm trên bộ nhớ điện thoại để tránh nặng máy
          try {
            if (item.photoUri && item.photoUri.startsWith('file://')) {
              await FileSystem.deleteAsync(item.photoUri, { idempotent: true });
            }
            if (item.cropPhotoUri && item.cropPhotoUri.startsWith('file://')) {
              await FileSystem.deleteAsync(item.cropPhotoUri, { idempotent: true });
            }
          } catch (delErr) {
            console.warn('[StampQueue] Dọn dẹp ảnh tạm sau đồng bộ ngầm:', delErr);
          }

          if (onProgress) {
            onProgress(queue.length - syncedCount, res.item);
          }
        }
      } catch (itemErr: any) {
        console.warn(`[StampQueue] Đồng bộ ngầm ảnh Pallet ${item.palletStt} tạm hoãn:`, itemErr?.message);
        remaining.push({
          ...item,
          retryCount: (item.retryCount || 0) + 1,
        });
      }
    }

    await AsyncStorage.setItem(STAMP_OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    return syncedCount;
  } catch (e) {
    console.warn('[StampQueue] Lỗi tiến trình đồng bộ ngầm:', e);
    return 0;
  } finally {
    isStampSyncing = false;
  }
}

/**
 * Lấy số lượng ảnh con dấu đang chờ đồng bộ ngầm
 */
export async function getPendingStampQueueCount(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(STAMP_OFFLINE_QUEUE_KEY);
    if (!raw) return 0;
    const queue: StampQueueBackgroundItem[] = JSON.parse(raw);
    return queue.length;
  } catch {
    return 0;
  }
}

/**
 * Lấy danh sách ảnh con dấu đang lưu tạm offline trên máy (chưa gửi được lên server)
 */
export async function getPendingStampQueueList(): Promise<StampQueueBackgroundItem[]> {
  try {
    const raw = await AsyncStorage.getItem(STAMP_OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Xóa một item ảnh con dấu offline khỏi bộ nhớ máy
 */
export async function removePendingStampQueueItem(id: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STAMP_OFFLINE_QUEUE_KEY);
    if (!raw) return;
    const queue: StampQueueBackgroundItem[] = JSON.parse(raw);
    const updated = queue.filter(item => item.id !== id);
    await AsyncStorage.setItem(STAMP_OFFLINE_QUEUE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('[StampQueue] Lỗi xóa item offline:', err);
  }
}

/**
 * Thử gửi lại 1 item ảnh con dấu offline lên máy chủ
 */
export async function syncSingleStampBackgroundItem(id: string): Promise<boolean> {
  const raw = await AsyncStorage.getItem(STAMP_OFFLINE_QUEUE_KEY);
  if (!raw) return false;
  const queue: StampQueueBackgroundItem[] = JSON.parse(raw);
  const target = queue.find(i => i.id === id);
  if (!target) return false;

  const res = await submitStampPhotoToQueue({
    photoUri: target.photoUri,
    cropPhotoUri: target.cropPhotoUri,
    palletStt: target.palletStt,
    palletTag: target.palletTag,
    palletNotes: target.palletNotes,
    boxCount: target.boxCount || 30,
    boxWeight: target.boxWeight || 20,
  });

  if (res.success) {
    await removePendingStampQueueItem(id);

    // Tự động xóa file ảnh tạm trên bộ nhớ máy sau khi tải lên thành công
    try {
      if (target.photoUri && target.photoUri.startsWith('file://')) {
        await FileSystem.deleteAsync(target.photoUri, { idempotent: true });
      }
      if (target.cropPhotoUri && target.cropPhotoUri.startsWith('file://')) {
        await FileSystem.deleteAsync(target.cropPhotoUri, { idempotent: true });
      }
    } catch (delErr) {
      console.warn('[StampQueue] Lỗi xóa file tạm sau khi gửi:', delErr);
    }

    return true;
  }
  return false;
}

/**
 * Trả về link trực tiếp Google Drive CDN (lh3.googleusercontent.com) hoặc Supabase public URL
 * để hiển thị ảnh thumbnail mượt mà không bị lỗi CORS/Cookie
 */
export function getDirectDriveImage(
  imgUrl?: string | null,
  cropUrl?: string | null,
  fileId?: string | null
): string | null {
  if (cropUrl && !cropUrl.includes('drive.google.com/file/d/')) {
    return cropUrl;
  }
  if (fileId) {
    return `https://lh3.googleusercontent.com/d/${fileId}`;
  }
  if (imgUrl) {
    const m = imgUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || imgUrl.match(/id=([a-zA-Z0-9_-]+)/);
    if (m && m[1]) {
      return `https://lh3.googleusercontent.com/d/${m[1]}`;
    }
    return imgUrl;
  }
  return null;
}

/**
 * Lấy cấu hình Webhook Google Apps Script của phân hệ con dấu
 */
export async function getStampDriveWebhookUrl(): Promise<string | null> {
  try {
    const client = await getSupabaseClient();
    let companyId: string | null = null;
    try {
      const rawUser = await AsyncStorage.getItem('auth_user_profile');
      if (rawUser) {
        companyId = JSON.parse(rawUser)?.company_id || null;
      }
    } catch {}

    let q = client.from('company_ai_settings').select('drive_webhook_url').limit(1);
    if (companyId) q = q.eq('company_id', companyId);

    const { data } = await withTimeout(q.maybeSingle(), 5000, 'Lỗi lấy cấu hình Google Drive');
    if (data?.drive_webhook_url && String(data.drive_webhook_url).trim()) {
      return String(data.drive_webhook_url).trim();
    }
  } catch (e) {
    console.warn('[StampQueueService] Không đọc được drive_webhook_url:', e);
  }
  return null;
}

/**
 * Tải ảnh con dấu từ điện thoại lên Google Drive (Apps Script CON_DAU)
 * Hỗ trợ cả chế độ quét thường và chế độ gửi duyệt AI
 */
export async function uploadMobileStampImageToGoogleDrive(
  photoUri: string,
  palletStt: string
): Promise<{
  success: boolean;
  fileId?: string | null;
  viewUrl?: string | null;
  imageUrl?: string | null;
}> {
  try {
    const cleanStt = (palletStt || '').trim().toUpperCase() || 'PALLET';
    const client = await getSupabaseClient();

    // 1. Nén ảnh và chuyển sang Base64
    const manipulated = await ImageManipulator.manipulateAsync(
      photoUri,
      [{ resize: { width: 1400 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );

    const base64Data = manipulated.base64;
    if (!base64Data) {
      return { success: false };
    }

    // 2. Lấy Webhook URL
    const webhookUrl = await getStampDriveWebhookUrl();
    let finalImageUrl = '';
    let driveFileId: string | null = null;
    let driveViewUrl: string | null = null;

    if (webhookUrl) {
      try {
        const now = new Date();
        const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const filename = `STT_${cleanStt}_${Date.now()}.jpg`;

        const driveRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'upload',
            base64: base64Data,
            palletStt: cleanStt,
            yearMonth,
            filename,
            mimeType: 'image/jpeg',
          }),
        });

        if (driveRes.ok) {
          const driveData: any = await driveRes.json();
          if (driveData.success && driveData.fileId) {
            driveFileId = driveData.fileId;
            driveViewUrl = driveData.viewUrl || null;
            finalImageUrl = driveData.thumbnailUrl || driveData.viewUrl || `https://drive.google.com/thumbnail?id=${driveData.fileId}&sz=w1000`;
          }
        }
      } catch (driveErr) {
        console.warn('[StampDrive] Upload Google Drive lỗi, fallback sang Storage:', driveErr);
      }
    }

    // Fallback sang Supabase Storage nếu Drive lỗi hoặc chưa có webhook
    if (!finalImageUrl) {
      try {
        const rawBytes = decodeBase64ToArrayBuffer(base64Data);
        const filePath = `stamp-queue/${cleanStt}_${Date.now()}.jpg`;

        const { error: uploadErr } = await client.storage
          .from('operation-images')
          .upload(filePath, rawBytes, { contentType: 'image/jpeg', upsert: true });

        if (!uploadErr) {
          const { data: pubData } = client.storage
            .from('operation-images')
            .getPublicUrl(filePath);
          finalImageUrl = pubData?.publicUrl || '';
        }
      } catch {}
    }

    return {
      success: !!finalImageUrl,
      fileId: driveFileId,
      viewUrl: driveViewUrl || finalImageUrl,
      imageUrl: finalImageUrl,
    };
  } catch (e) {
    console.warn('[uploadMobileStampImageToGoogleDrive] Error:', e);
    return { success: false };
  }
}

/**
 * Tải ảnh lên Google Drive (Apps Script) hoặc Supabase Storage và lưu vào hàng đợi
 */
export async function submitStampPhotoToQueue(params: SubmitStampQueueParams): Promise<{
  success: boolean;
  message: string;
  isGoogleDrive: boolean;
  item?: any;
}> {
  const { photoUri, palletStt, palletTag, palletNotes, boxCount, boxWeight } = params;
  const cleanStt = (palletStt || '').trim().toUpperCase();
  if (!cleanStt) {
    throw new Error('Chưa có Số Thứ Tự (STT) Pallet');
  }

  const client = await getSupabaseClient();
  const storedSys = await AsyncStorage.getItem('config_system_code');
  const systemCode = storedSys || 'KHO_DONG_LANH';

  let userId: string | null = null;
  let userName: string = 'Kho Mobile';
  let companyId: string | null = null;
  try {
    const rawUser = await AsyncStorage.getItem('auth_user_profile');
    if (rawUser) {
      const u = JSON.parse(rawUser);
      userId = u.id || null;
      userName = u.full_name || u.name || 'Kho Mobile';
      companyId = u.company_id || null;
    }
  } catch {}

  // 1. Nén ảnh và chuyển sang Base64
  const manipulated = await ImageManipulator.manipulateAsync(
    photoUri,
    [{ resize: { width: 1400 } }],
    { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );

  const base64Data = manipulated.base64;
  if (!base64Data) {
    throw new Error('Không thể nén ảnh để gửi lên máy chủ');
  }

  // 2. Kiểm tra Google Apps Script Webhook
  const webhookUrl = await getStampDriveWebhookUrl();
  let finalImageUrl = '';
  let driveFileId: string | null = null;
  let driveViewUrl: string | null = null;

  // ƯU TIÊN: Đẩy thẳng lên Google Drive (CON_DAU/YYYY-MM/STT_...)
  if (webhookUrl) {
    try {
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const filename = `STT_${cleanStt}_${Date.now()}.jpg`;

      const driveRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'upload',
          base64: base64Data,
          palletStt: cleanStt,
          yearMonth,
          filename,
          mimeType: 'image/jpeg',
        }),
      });

      if (driveRes.ok) {
        const driveData: any = await driveRes.json();
        if (driveData.success && driveData.fileId) {
          driveFileId = driveData.fileId;
          driveViewUrl = driveData.viewUrl || null;
          finalImageUrl = driveData.thumbnailUrl || driveData.viewUrl || `https://drive.google.com/thumbnail?id=${driveData.fileId}&sz=w1000`;
        }
      }
    } catch (driveErr) {
      console.warn('[StampQueue] Upload Google Drive lỗi, fallback sang Storage:', driveErr);
    }
  }

  // FALLBACK: Lưu vào Supabase Storage bucket operation-images
  if (!finalImageUrl) {
    const rawBytes = decodeBase64ToArrayBuffer(base64Data);
    const filePath = `stamp-queue/${cleanStt}_${Date.now()}.jpg`;

    const { error: uploadErr } = await client.storage
      .from('operation-images')
      .upload(filePath, rawBytes, { contentType: 'image/jpeg', upsert: true });

    if (uploadErr) {
      throw new Error(`Lỗi tải ảnh lên máy chủ: ${uploadErr.message}`);
    }

    const { data: pubData } = client.storage
      .from('operation-images')
      .getPublicUrl(filePath);

    finalImageUrl = pubData?.publicUrl || '';
  }

  if (!finalImageUrl) {
    throw new Error('Không tạo được đường dẫn ảnh con dấu');
  }

  // Tải ảnh crop vùng con dấu lên máy chủ (nếu có) để AI đọc siêu nhanh (~0.5s)
  let finalCropUrl: string | null = null;
  if (params.cropPhotoUri) {
    try {
      const manipulatedCrop = await ImageManipulator.manipulateAsync(
        params.cropPhotoUri,
        [{ resize: { width: 1000 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (manipulatedCrop.base64) {
        const rawCropBytes = decodeBase64ToArrayBuffer(manipulatedCrop.base64);
        const cropFilePath = `stamp-queue/crops/${cleanStt}_${Date.now()}.jpg`;
        const { error: cropUpErr } = await client.storage
          .from('operation-images')
          .upload(cropFilePath, rawCropBytes, { contentType: 'image/jpeg', upsert: true });
        if (!cropUpErr) {
          const { data: cPub } = client.storage.from('operation-images').getPublicUrl(cropFilePath);
          finalCropUrl = cPub?.publicUrl || null;
        }
      }
    } catch (cropErr) {
      console.warn('[StampQueueMobile] Lỗi lưu ảnh crop:', cropErr);
    }
  }

  // 3. Insert vào bảng stamp_scan_queue
  const insertPayload: any = {
    system_code: systemCode,
    pallet_stt: cleanStt,
    pallet_tag: palletTag || null,
    pallet_notes: palletNotes || null,
    box_count: Math.max(1, boxCount || 30),
    box_weight: boxWeight || 20,
    image_url: finalImageUrl,
    cropped_image_url: finalCropUrl,
    drive_file_id: driveFileId,
    drive_view_url: driveViewUrl,
    status: 'pending',
    created_by: userId,
    created_by_name: userName,
  };

  if (companyId) {
    insertPayload.company_id = companyId;
  }

  const { data: inserted, error: insertErr } = await withTimeout(
    client.from('stamp_scan_queue').insert(insertPayload).select().single(),
    8000,
    'Hết thời gian lưu hàng đợi (8s)'
  );

  if (insertErr) {
    throw new Error(`Lỗi lưu hàng đợi CSDL: ${insertErr.message}`);
  }

  return {
    success: true,
    message: driveFileId
      ? `Đã lưu ảnh lên Google Drive (CON_DAU) và gửi Pallet ${cleanStt} thành công!`
      : `Đã gửi ảnh Pallet ${cleanStt} lên Web Mẹ thành công!`,
    isGoogleDrive: !!driveFileId,
    item: inserted,
  };
}

/**
 * Lấy danh sách các ảnh con dấu gửi gần đây của người dùng
 */
export async function fetchRecentStampQueue(): Promise<StampQueueItemMobile[]> {
  try {
    const client = await getSupabaseClient();
    const storedSys = await AsyncStorage.getItem('config_system_code');
    const systemCode = storedSys || 'KHO_DONG_LANH';

    const { data, error } = await client
      .from('stamp_scan_queue')
      .select('id, pallet_stt, pallet_tag, pallet_notes, box_count, box_weight, image_url, cropped_image_url, drive_file_id, drive_view_url, status, stamp_line1, stamp_line2, decoded_json, created_at, created_by_name, error_message, approved_lot_code')
      .eq('system_code', systemCode)
      .order('created_at', { ascending: false })
      .limit(60);

    if (error) throw error;
    return (data || []) as StampQueueItemMobile[];
  } catch (e) {
    console.warn('[StampQueue] Lỗi tải lịch sử hàng đợi:', e);
    return [];
  }
}

/**
 * Kích hoạt giải mã Gemini AI cho các pallet trong hàng đợi từ thiết bị
 */
export async function triggerDecodeStampFromApp(ids?: string[]): Promise<{
  success: boolean;
  message?: string;
  decodedCount?: number;
}> {
  try {
    const storedUrl = await AsyncStorage.getItem('config_web_api_url');
    let baseUrl = storedUrl || 'https://qlk.chanhthu.click';
    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

    const storedSys = await AsyncStorage.getItem('config_system_code');
    const systemCode = storedSys || 'KHO_DONG_LANH';

    const client = await getSupabaseClient();
    const { data: sessionData } = await client.auth.getSession();
    const token = sessionData?.session?.access_token || '';

    const res = await fetch(`${baseUrl}/api/stamp-queue/decode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ids, systemCode }),
    });

    const data = await res.json();
    return data;
  } catch (err: any) {
    return { success: false, message: err?.message || 'Không thể kết nối máy chủ AI' };
  }
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
