import { getSupabaseClient, withTimeout } from './supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImageManipulator from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { decodeStamp, DEFAULT_STAMP_DICTIONARY } from './stampParser';
import { getStampDictionariesMap, getActiveStampFormat } from './database';

function deleteTempFileSafe(uri?: string | null): void {
  if (!uri || !uri.startsWith('file://')) return;
  try {
    const f = new File(uri);
    if (f.exists) {
      f.delete();
    }
  } catch {}
}

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
          deleteTempFileSafe(item.photoUri);
          deleteTempFileSafe(item.cropPhotoUri);

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
    deleteTempFileSafe(target.photoUri);
    deleteTempFileSafe(target.cropPhotoUri);

    return true;
  }
  return false;
}

/**
 * Chuẩn hóa URL ảnh Supabase Storage nếu chứa loopback localhost:64321
 */
export function normalizeStorageUrl(url?: string | null): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):64321/, 'https://api.chanhthu.click');
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
  const normalizedCrop = normalizeStorageUrl(cropUrl);
  if (normalizedCrop && !normalizedCrop.includes('drive.google.com/file/d/')) {
    return normalizedCrop;
  }
  if (fileId) {
    return `https://lh3.googleusercontent.com/d/${fileId}`;
  }
  const normalizedImg = normalizeStorageUrl(imgUrl);
  if (normalizedImg) {
    const m = normalizedImg.match(/\/d\/([a-zA-Z0-9_-]+)/) || normalizedImg.match(/id=([a-zA-Z0-9_-]+)/);
    if (m && m[1]) {
      return `https://lh3.googleusercontent.com/d/${m[1]}`;
    }
    return normalizedImg;
  }
  return null;
}

/**
 * Trả về ảnh xem toàn màn hình rõ nét nhất (ưu tiên ảnh gốc độ phân giải cao Google Drive)
 */
export function getFullStampImage(
  imgUrl?: string | null,
  cropUrl?: string | null,
  fileId?: string | null
): string | null {
  if (fileId) {
    return `https://lh3.googleusercontent.com/d/${fileId}`;
  }
  const normalizedImg = normalizeStorageUrl(imgUrl);
  if (normalizedImg) {
    const m = normalizedImg.match(/\/d\/([a-zA-Z0-9_-]+)/) || normalizedImg.match(/id=([a-zA-Z0-9_-]+)/);
    if (m && m[1]) {
      return `https://lh3.googleusercontent.com/d/${m[1]}`;
    }
    return normalizedImg;
  }
  return normalizeStorageUrl(cropUrl) || null;
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

  // 2.5. Chuẩn bị ảnh crop vùng con dấu dạng Base64 gọn nhẹ (~15-25KB) để AI đọc siêu tốc & hiển thị thumbnail tức thì
  let finalCropUrl: string | null = null;
  if (params.cropPhotoUri) {
    try {
      const manipulatedCrop = await ImageManipulator.manipulateAsync(
        params.cropPhotoUri,
        [{ resize: { width: 900 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (manipulatedCrop.base64) {
        finalCropUrl = `data:image/jpeg;base64,${manipulatedCrop.base64}`;
      }
    } catch (cropErr) {
      console.warn('[StampQueueMobile] Lỗi tạo ảnh crop base64:', cropErr);
    }
  }

  // FALLBACK: Lưu vào Supabase Storage bucket operation-images hoặc dùng Base64 nếu chưa có Google Drive
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
        finalImageUrl = normalizeStorageUrl(pubData?.publicUrl) || '';
      }
    } catch (storageErr) {
      console.warn('[StampQueueMobile] Storage upload fallback sang Base64:', storageErr);
    }
  }

  if (!finalImageUrl) {
    finalImageUrl = finalCropUrl || `data:image/jpeg;base64,${base64Data}`;
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
    10000,
    'Hết thời gian lưu hàng đợi (10s)'
  );

  if (insertErr) {
    throw new Error(`Lỗi lưu hàng đợi CSDL: ${insertErr.message}`);
  }

  // 4. Tự động kích hoạt Gemini AI giải mã ngay lập tức trong nền!
  if (inserted?.id) {
    setTimeout(() => {
      triggerDecodeStampFromApp([inserted.id]).catch(e =>
        console.warn('[StampQueue] Tự động giải mã AI nền:', e)
      );
    }, 100);
  }

  return {
    success: true,
    message: driveFileId
      ? `Đã lưu ảnh lên Google Drive (CON_DAU) và gửi Pallet ${cleanStt} thành công!`
      : `Đã gửi ảnh Pallet ${cleanStt} lên hàng đợi giải mã AI thành công!`,
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

function parseMobileGeminiKeys(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(k => k.length > 10);
}

function cleanMobileStampLine(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[oO]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[^0-9\-]/g, '');
}

async function resolveImageToBase64Mobile(urlOrData: string): Promise<{ base64: string; mimeType: string }> {
  if (urlOrData.startsWith('data:')) {
    const m = urlOrData.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) {
      return { mimeType: m[1], base64: m[2] };
    }
  }
  const normalized = getDirectDriveImage(urlOrData, null, null) || normalizeStorageUrl(urlOrData) || urlOrData;
  const manip = await ImageManipulator.manipulateAsync(
    normalized,
    [{ resize: { width: 1000 } }],
    { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );
  if (!manip.base64) {
    throw new Error('Không thể đọc dữ liệu ảnh để giải mã');
  }
  return { mimeType: 'image/jpeg', base64: manip.base64 };
}

async function callGeminiStampOcrMobile(params: {
  imageBase64: string;
  mimeType: string;
  apiKeys: string[];
  model: string;
}): Promise<{ line1: string; line2: string }> {
  const { imageBase64, mimeType, apiKeys, model } = params;
  const candidateModels = Array.from(
    new Set([
      model,
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-flash-latest',
      'gemini-3.5-flash',
      'gemini-2.5-flash-lite',
    ])
  ).filter(Boolean);

  const prompt = [
    'Bạn là hệ thống OCR công nghiệp chuyên đọc dấu mực đóng trên thùng carton.',
    'Trong ảnh có 2 dòng chữ số đóng dấu mực gần nhau:',
    '- Dòng 1 (mã sản phẩm): thường gồm 12 chữ số, dấu gạch ngang "-", và 1 chữ số cuối (ví dụ: 102020301001-0 hoặc 102010402001-0).',
    '- Dòng 2 (dãy số truy xuất nguồn gốc): gồm 16 chữ số liền nhau (ví dụ: 2031103112600066 hoặc 2281021102600066).',
    'Hãy bỏ qua hoàn toàn các chữ/số watermark thời gian camera hoặc ký tự không thuộc dấu mực.',
    'Trả về JSON thuần theo đúng schema: {"line1": "...", "line2": "..."} (chỉ chứa chữ số 0-9 và dấu "-" ở line1, không giải thích thêm).',
  ].join('\n');

  let lastErr: any = null;

  for (let kIdx = 0; kIdx < apiKeys.length; kIdx++) {
    const key = apiKeys[kIdx];
    for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
      const activeModel = candidateModels[mIdx];
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(key)}`;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  { inlineData: { mimeType, data: imageBase64 } },
                ],
              },
            ],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          lastErr = new Error(`Gemini (${res.status}): ${errText.slice(0, 120)}`);
          if (res.status === 404 || res.status === 503) continue;
          if (res.status === 429 || res.status === 403) break;
          continue;
        }

        const json: any = await res.json();
        const textOut: string = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let parsed: any = {};
        try {
          parsed = JSON.parse(textOut);
        } catch {
          const match = textOut.match(/\{[\s\S]*\}/);
          if (match) parsed = JSON.parse(match[0]);
        }

        const line1 = cleanMobileStampLine(parsed?.line1 || '');
        const line2 = cleanMobileStampLine(parsed?.line2 || '').replace(/-/g, '');
        return { line1, line2 };
      } catch (e: any) {
        lastErr = e;
      }
    }
  }

  throw lastErr || new Error('Không thể gọi Gemini AI để đọc con dấu');
}

/**
 * Kích hoạt giải mã Gemini AI trực tiếp từ thiết bị qua cấu hình trên Supabase (api.chanhthu.click)
 */
export async function triggerDecodeStampFromApp(ids?: string[]): Promise<{
  success: boolean;
  message?: string;
  decodedCount?: number;
}> {
  try {
    const client = await getSupabaseClient();
    const storedSys = await AsyncStorage.getItem('config_system_code');
    const systemCode = storedSys || 'KHO_DONG_LANH';

    // 1. Lấy cấu hình Gemini API Key từ bảng company_ai_settings trên Supabase
    const { data: aiCfg } = await client
      .from('company_ai_settings')
      .select('gemini_api_key, gemini_model, is_enabled')
      .eq('is_enabled', true)
      .limit(1)
      .maybeSingle();

    const apiKeys = parseMobileGeminiKeys(aiCfg?.gemini_api_key || '');
    if (apiKeys.length === 0) {
      return {
        success: false,
        message: 'Chưa cấu hình Gemini API Key trên hệ thống.',
      };
    }
    const model = String(aiCfg?.gemini_model || 'gemini-3.5-flash-lite').trim();

    // 2. Lấy danh sách các bản ghi cần giải mã từ bảng stamp_scan_queue
    let query = client
      .from('stamp_scan_queue')
      .select('*')
      .order('created_at', { ascending: true });

    if (ids && ids.length > 0) {
      query = query.in('id', ids);
    } else {
      query = query.eq('system_code', systemCode).in('status', ['pending', 'error']).limit(20);
    }

    const { data: queueItems, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;
    if (!queueItems || queueItems.length === 0) {
      return { success: true, decodedCount: 0, message: 'Không có ảnh nào đang chờ giải mã.' };
    }

    // 3. Tải bộ từ điển con dấu để giải mã ra tên sản phẩm, ngày đóng gói, vùng miền
    let dictMap: Record<string, Record<string, string>> = { ...DEFAULT_STAMP_DICTIONARY };
    let activeFormat: any = null;
    try {
      const [localDict, localFmt] = await Promise.all([
        getStampDictionariesMap(),
        getActiveStampFormat(),
      ]);
      if (localDict && Object.keys(localDict).length > 0) dictMap = localDict;
      activeFormat = localFmt;

      const { data: cloudDict } = await client
        .from('stamp_dictionaries')
        .select('category, code, name')
        .eq('is_active', true);
      if (Array.isArray(cloudDict)) {
        cloudDict.forEach((row: any) => {
          const cat = String(row.category || '').trim();
          const code = String(row.code || '').trim();
          const name = String(row.name || '').trim();
          if (!cat || !code) return;
          if (!dictMap[cat]) dictMap[cat] = {};
          dictMap[cat][code] = name;
          if (cat === 'special_12') {
            const c12 = code.replace(/[^0-9]/g, '').slice(0, 12);
            if (c12.length === 12) dictMap[cat][c12] = name;
          }
        });
      }
    } catch {}

    let decodedCount = 0;

    for (const item of queueItems) {
      try {
        const targetImg = item.cropped_image_url || item.image_url;
        const imgData = await resolveImageToBase64Mobile(targetImg);
        const ocrRes = await callGeminiStampOcrMobile({
          imageBase64: imgData.base64,
          mimeType: imgData.mimeType,
          apiKeys,
          model,
        });

        const dec = decodeStamp(ocrRes.line1, ocrRes.line2, dictMap, activeFormat);
        const decodedPayload = {
          isStamp: true,
          stampLine1: ocrRes.line1,
          stampLine2: ocrRes.line2,
          isSpecial12: dec.is_special_12,
          special12Code: dec.special_12_code,
          special12Name: dec.special_12_name,
          productTitle: dec.product_name_full || dec.special_12_name || 'Sản phẩm con dấu',
          spec: dec.package_spec_name || (dec.is_special_12 ? 'Ngoại lệ trọn gói' : ''),
          factoryName: dec.factory_name || '',
          packagingDateStr: dec.packaging_date || '',
          rawMaterialDateStr: dec.raw_material_date || dec.inbound_date || '',
          supplierCode: dec.supplier_code || '',
          supplierName: dec.supplier_name || '',
          provinceName: dec.province_name || '',
        };

        await client
          .from('stamp_scan_queue')
          .update({
            stamp_line1: ocrRes.line1,
            stamp_line2: ocrRes.line2,
            decoded_json: decodedPayload,
            status: 'decoded',
            error_message: null,
          })
          .eq('id', item.id);

        decodedCount++;
      } catch (itemErr: any) {
        await client
          .from('stamp_scan_queue')
          .update({
            status: 'error',
            error_message: itemErr?.message || 'Lỗi đọc ảnh con dấu',
          })
          .eq('id', item.id);
      }
    }

    return {
      success: decodedCount > 0,
      decodedCount,
      message:
        decodedCount > 0
          ? `Đã giải mã thành công ${decodedCount}/${queueItems.length} con dấu!`
          : 'Không thể giải mã ảnh con dấu, vui lòng kiểm tra lại ảnh chụp.',
    };
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
