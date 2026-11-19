import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Alert, ActivityIndicator, Modal, ScrollView, TextInput,
  KeyboardAvoidingView, Platform, RefreshControl, Image
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Pallet, BoxLabel, CloudPallet, CloudFilterCriteria } from '../types';
import {
  getAllPallets, getBoxesByPallet, deletePallet,
  deleteBox, cloneBoxToPallet,
  getCloudPalletsFromCache, getProductsFromCache
} from '../services/database';
import {
  syncPalletToSupabase, testConnection,
  fetchCloudPallets, fetchCloudPalletBoxes,
  fetchProductsForSuggestions, ProductSuggestion,
  syncCloudPalletsOffline, getLastOfflineSyncInfo,
  getSupabaseClient
} from '../services/supabase';
import {
  fetchRecentStampQueue, triggerDecodeStampFromApp,
  StampQueueItemMobile, StampQueueBackgroundItem,
  getPendingStampQueueList, removePendingStampQueueItem,
  syncSingleStampBackgroundItem, getDirectDriveImage,
  getFullStampImage, processBackgroundStampQueue,
  enqueueStampPhotoForBackgroundSync
} from '../services/stampQueueService';
import { calculateSearchScore, matchSearch, normalizeSearchString } from '../utils/searchUtils';

function normalizeText(text?: string | null): string {
  return normalizeSearchString(text || '', true);
}

function matchDate(dateStr?: string | null, filterStr?: string | null): boolean {
  if (!filterStr || !filterStr.trim()) return true;
  if (!dateStr || !dateStr.trim()) return false;

  const dNorm = normalizeText(dateStr);
  const fNorm = normalizeText(filterStr);

  if (dNorm.includes(fNorm)) return true;

  // Filter format YYYY-MM-DD -> check DD/MM/YYYY và DD-MM-YYYY
  const ymdMatch = filterStr.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    const mPad = m.padStart(2, '0');
    const dPad = d.padStart(2, '0');
    const dmySlash = `${dPad}/${mPad}/${y}`;
    const dmyDash = `${dPad}-${mPad}-${y}`;
    const ymdDash = `${y}-${mPad}-${dPad}`;
    if (
      dNorm.includes(normalizeText(dmySlash)) ||
      dNorm.includes(normalizeText(dmyDash)) ||
      dNorm.includes(normalizeText(ymdDash))
    ) {
      return true;
    }
  }

  // Filter format DD/MM/YYYY -> check YYYY-MM-DD
  const dmyMatch = filterStr.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const mPad = m.padStart(2, '0');
    const dPad = d.padStart(2, '0');
    const ymdDash = `${y}-${mPad}-${dPad}`;
    if (dNorm.includes(normalizeText(ymdDash))) {
      return true;
    }
  }

  return false;
}

export interface ProductSuggestionItem {
  product: ProductSuggestion;
  score: number;
  fillValue: string;
  displayTitle: string;
  displaySubtitle?: string;
  badgeType?: 'alias' | 'sku';
  badgeText?: string;
}

export default function PalletListScreen({
  onBackToScanner,
  isActive,
  scannerMode = 'stamp_scanner'
}: {
  onBackToScanner: () => void;
  isActive?: boolean;
  scannerMode?: 'stamp_scanner' | 'scanner';
}) {
  // 4 Tabs: 'pending' (Chờ đẩy) vs 'stamp_pending' (Chờ giải mã) vs 'stamp_decoded' (Đã giải mã) vs 'cloud' (Đã duyệt)
  const [activeTab, setActiveTab] = useState<'pending' | 'stamp_pending' | 'stamp_decoded' | 'cloud'>('pending');

  // Local pending pallets
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [isSyncingAll, setIsSyncingAll] = useState(false);

  // Stamp queue states (Chờ giải mã & Đã giải mã)
  const [stampQueueItems, setStampQueueItems] = useState<StampQueueItemMobile[]>([]);
  const [offlineStampItems, setOfflineStampItems] = useState<StampQueueBackgroundItem[]>([]);
  const [syncingOfflineStampId, setSyncingOfflineStampId] = useState<string | null>(null);
  const [loadingStampQueue, setLoadingStampQueue] = useState(false);
  const [decodingQueueId, setDecodingQueueId] = useState<string | null>(null);
  const [isDecodingAllQueue, setIsDecodingAllQueue] = useState(false);

  // Cloud pallets (Web mẹ)
  const [cloudPallets, setCloudPallets] = useState<CloudPallet[]>([]);
  const [loadingCloud, setLoadingCloud] = useState(false);
  const [cloudSearchQuery, setCloudSearchQuery] = useState('');

  // Offline cache & sync states
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [lastSyncTimeText, setLastSyncTimeText] = useState<string | null>(null);
  const [isSyncingOffline, setIsSyncingOffline] = useState(false);

  // Gợi ý autocomplete sản phẩm (tên, mã SKU, tên viết tắt, gõ tắt)
  const [availableProducts, setAvailableProducts] = useState<ProductSuggestion[]>([]);
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);
  const [showModalProductSuggestions, setShowModalProductSuggestions] = useState(false);

  // Lịch chọn ngày (Calendar DatePicker)
  const [calendarTargetField, setCalendarTargetField] = useState<'packagingDate' | 'productionDate' | null>(null);
  const [calendarYear, setCalendarYear] = useState<number>(new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState<number>(new Date().getMonth());

  // Connection status
  const [connectionStatus, setConnectionStatus] = useState<string>('Đang kiểm tra...');

  // Detail Modal
  const [selectedPallet, setSelectedPallet] = useState<Pallet | null>(null);
  const [selectedCloudPallet, setSelectedCloudPallet] = useState<CloudPallet | null>(null);
  const [selectedBoxes, setSelectedBoxes] = useState<BoxLabel[]>([]);
  const [isLoadingBoxes, setIsLoadingBoxes] = useState(false);

  // Modal xem ảnh phóng to full-screen
  const [previewModalImageUri, setPreviewModalImageUri] = useState<string | null>(null);
  const [previewModalTitle, setPreviewModalTitle] = useState<string>('');

  const openPreviewImage = (uri?: string | null, title?: string) => {
    if (!uri) return;
    setPreviewModalTitle(title || 'Ảnh con dấu');
    setPreviewModalImageUri(uri);
  };

  const palletsLengthRef = useRef(0);
  useEffect(() => {
    palletsLengthRef.current = pallets.length;
  }, [pallets.length]);

  async function loadStampQueue(isSilent = false) {
    // 1. Nạp tức thì danh sách offline từ bộ nhớ máy (0ms - không chờ mạng)
    try {
      const fastOffline = await getPendingStampQueueList();
      setOfflineStampItems(fastOffline);
    } catch {}

    if (!isSilent) setLoadingStampQueue(true);
    try {
      // 2. Fetch danh sách online kèm timeout 2.5s (tránh bị treo 10-15s khi offline/mất mạng)
      const fetchWithTimeout = Promise.race([
        fetchRecentStampQueue(),
        new Promise<StampQueueItemMobile[]>((resolve) => setTimeout(() => resolve([]), 2500))
      ]);

      const [list, offlineList] = await Promise.all([
        fetchWithTimeout,
        getPendingStampQueueList(),
      ]);

      if (list && list.length > 0) {
        setStampQueueItems(list);
      }
      setOfflineStampItems(offlineList);

      // Nếu còn item offline chưa đẩy lên được, tự động thử đẩy ngầm & giải mã AI
      if (offlineList.length > 0) {
        processBackgroundStampQueue(() => {
          void Promise.all([
            fetchRecentStampQueue(),
            getPendingStampQueueList(),
          ]).then(([newList, newOffline]) => {
            if (newList && newList.length > 0) setStampQueueItems(newList);
            setOfflineStampItems(newOffline);
          }).catch(() => {});
        }).catch(() => {});
      }
    } catch (e: any) {
      console.warn('loadStampQueue error:', e);
    } finally {
      if (!isSilent) setLoadingStampQueue(false);
    }
  }

  async function handleSyncSingleOfflineStamp(item: StampQueueBackgroundItem) {
    setSyncingOfflineStampId(item.id);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const ok = await syncSingleStampBackgroundItem(item.id);
      if (ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Thành công', `Đã tải ảnh Pallet ${item.palletStt} lên Server và đưa vào hàng đợi giải mã!`);
        await loadStampQueue(true);
      } else {
        Alert.alert('Chưa gửi được', 'Vui lòng kiểm tra lại kết nối mạng hoặc thử lại sau.');
      }
    } catch (err: any) {
      Alert.alert('Lỗi gửi', err?.message || 'Có lỗi xảy ra khi gửi ảnh');
    } finally {
      setSyncingOfflineStampId(null);
    }
  }

  async function handleDeleteOfflineStamp(item: StampQueueBackgroundItem) {
    Alert.alert(
      `Xóa ảnh Pallet ${item.palletStt}?`,
      'Ảnh con dấu này đang lưu tạm trên máy chưa gửi lên. Bạn có chắc muốn xóa không?',
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa',
          style: 'destructive',
          onPress: async () => {
            await removePendingStampQueueItem(item.id);
            const updated = await getPendingStampQueueList();
            setOfflineStampItems(updated);
          },
        },
      ]
    );
  }

  async function handleSyncGroupOfflineStamp(group: { palletStt: string; totalBoxes: number; items: StampQueueBackgroundItem[] }) {
    setSyncingOfflineStampId(group.items[0]?.id || 'group');
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      let okCount = 0;
      for (const it of group.items) {
        const ok = await syncSingleStampBackgroundItem(it.id);
        if (ok) okCount++;
      }
      if (okCount > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          'Thành công',
          `🎉 Đã tải thành công ${okCount} / ${group.items.length} đợt ảnh của Pallet STT ${group.palletStt} (${group.totalBoxes} thùng) lên Server!`
        );
        await loadStampQueue(true);
      } else {
        Alert.alert('Chưa gửi được', 'Vui lòng kiểm tra lại kết nối mạng hoặc thử lại sau.');
      }
    } catch (err: any) {
      Alert.alert('Lỗi gửi', err?.message || 'Có lỗi xảy ra khi gửi ảnh');
    } finally {
      setSyncingOfflineStampId(null);
    }
  }

  async function handleDeleteGroupOfflineStamp(group: { palletStt: string; totalBoxes: number; items: StampQueueBackgroundItem[] }) {
    Alert.alert(
      `Xóa Pallet ${group.palletStt}?`,
      `Pallet này gồm ${group.items.length} đợt con dấu (${group.totalBoxes} thùng) đang lưu tạm trên máy. Bạn có chắc muốn xóa toàn bộ không?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa toàn bộ',
          style: 'destructive',
          onPress: async () => {
            for (const it of group.items) {
              await removePendingStampQueueItem(it.id);
            }
            const updated = await getPendingStampQueueList();
            setOfflineStampItems(updated);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          },
        },
      ]
    );
  }

  async function handleDecodeItem(ids: string | string[]) {
    const idList = Array.isArray(ids) ? ids : [ids];
    if (idList.length === 0) return;
    const repId = idList[0];
    setDecodingQueueId(repId);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const res = await triggerDecodeStampFromApp(idList);
      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Thành công', `Đã giải mã xong ${res.decodedCount || idList.length} con dấu bằng AI!`);
        await loadStampQueue(true);
      } else {
        Alert.alert('Không thể giải mã', res.message || 'Lỗi khi giải mã con dấu');
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setDecodingQueueId(null);
    }
  }

  async function handleDecodeAllPending() {
    const pendingIds = stampQueueItems
      .filter(i => i.status === 'pending' || i.status === 'error')
      .map(i => i.id);
    if (pendingIds.length === 0) return;

    setIsDecodingAllQueue(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const res = await triggerDecodeStampFromApp(pendingIds);
      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Thành công', `Đã giải mã xong ${res.decodedCount || pendingIds.length} pallet!`);
        await loadStampQueue(true);
      } else {
        Alert.alert('Lỗi giải mã', res.message || 'Không thể giải mã');
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setIsDecodingAllQueue(false);
    }
  }

  useEffect(() => {
    (async () => {
      const hasCachedCloud = await loadCacheFirst();
      void loadLocalPallets();
      void loadStampQueue(true);
      // Chỉ tự tải từ máy chủ nếu máy chưa từng có dữ liệu lưu sẵn (lần đầu cài app).
      // Nếu đã có dữ liệu trong máy, mở tức thì 0ms và để người dùng chủ động bấm nút "Tải dữ liệu" mỗi ca làm việc.
      if (!hasCachedCloud) {
        void loadCloudPallets();
      }
      void checkNetwork();
      void refreshSyncInfo();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lắng nghe Realtime bảng stamp_scan_queue để tự động nhảy số khi AI đọc xong hoặc Web Mẹ duyệt
  useEffect(() => {
    let channel: any = null;
    (async () => {
      try {
        const client = await getSupabaseClient();
        const storedSys = await AsyncStorage.getItem('config_system_code');
        const systemCode = storedSys || 'KHO_DONG_LANH';
        channel = client
          .channel('mobile_stamp_queue_realtime_tab')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'stamp_scan_queue', filter: `system_code=eq.${systemCode}` },
            () => {
              void loadStampQueue(true);
            }
          )
          .subscribe();
      } catch (err) {
        console.warn('Lỗi đăng ký Realtime stamp_scan_queue:', err);
      }
    })();

    return () => {
      if (channel) {
        void getSupabaseClient().then(c => c.removeChannel(channel)).catch(() => {});
      }
    };
  }, []);

  // Tự động làm mới danh sách Pallet từ SQLite ngay lập tức khi người dùng chuyển sang tab Pallet Kho
  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(() => {
      void loadLocalPallets(palletsLengthRef.current > 0);
      void loadStampQueue(true);
      void checkNetwork();
    }, 0);
    return () => clearTimeout(timer);
  }, [isActive]);

  async function refreshSyncInfo() {
    try {
      const info = await getLastOfflineSyncInfo();
      if (info.lastSyncedAt) {
        const d = new Date(info.lastSyncedAt);
        const dateStr = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        setLastSyncTimeText(`${dateStr} (${info.count} LOT)`);
      }
    } catch {}
  }

  async function loadCacheFirst(): Promise<boolean> {
    let hasCached = false;
    try {
      const cached = await getCloudPalletsFromCache();
      if (cached && cached.length > 0) {
        setCloudPallets(cached);
        hasCached = true;
      }
      const cachedProds = await getProductsFromCache();
      if (cachedProds && cachedProds.length > 0) {
        setAvailableProducts(cachedProds);
      }
    } catch (e) {
      console.warn('loadCacheFirst error:', e);
    }
    return hasCached;
  }

  async function checkNetwork() {
    const res = await testConnection();
    setConnectionStatus(res.success ? '🟢 api.chanhthu.click (Đã kết nối)' : '🔴 Mất kết nối máy chủ');
  }

  async function loadLocalPallets(isSilent = false) {
    if (!isSilent) setLoading(true);
    try {
      const data = await getAllPallets();
      setPallets(data);
    } catch (e: any) {
      Alert.alert('Lỗi', e.message);
    } finally {
      if (!isSilent) setLoading(false);
    }
  }

  async function loadCloudPallets() {
    setLoadingCloud(true);
    try {
      const res = await fetchCloudPallets();
      const prods = await fetchProductsForSuggestions();
      if (res.success) {
        setCloudPallets(res.data);
        setIsOfflineMode(!!(res as any).isFromCache);
      } else {
        console.warn('Lỗi tải danh sách từ Web mẹ:', res.message);
      }
      if (prods && prods.length > 0) {
        setAvailableProducts(prods);
      }
      await refreshSyncInfo();
    } catch (e: any) {
      console.warn('Lỗi fetchCloudPallets:', e);
    } finally {
      setLoadingCloud(false);
    }
  }

  async function handleSyncOffline() {
    setIsSyncingOffline(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await syncCloudPalletsOffline();
      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setIsOfflineMode(false);
        await loadCloudPallets();
        await refreshSyncInfo();
        Alert.alert('Thành công', res.message);
      } else {
        Alert.alert('Không thể tải', res.message);
      }
    } catch (e: any) {
      Alert.alert('Lỗi', e.message || 'Không thể đồng bộ ngoại tuyến');
    } finally {
      setIsSyncingOffline(false);
    }
  }

  async function handleRefreshAll() {
    checkNetwork();
    await Promise.all([
      loadLocalPallets(),
      loadStampQueue(),
      loadCloudPallets(),
    ]);
  }

  // ── SYNC ACTIONS (TAB 1) ──────────────────────────────────
  async function handleSyncSingle(pallet: Pallet) {
    setSyncingId(pallet.id);
    try {
      const boxes = await getBoxesByPallet(pallet.id);
      if (boxes.length === 0) {
        Alert.alert('Cảnh báo', 'Pallet này chưa có thùng nào để đồng bộ');
        return;
      }
      const res = await syncPalletToSupabase(pallet, boxes);
      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Tải lại ngay danh sách Pallet cục bộ trên máy để hiển thị đã đồng bộ
        await loadLocalPallets();
        // Tắt ngay loading của nút để người dùng không phải chờ
        setSyncingId(null);
        Alert.alert('Thành công', res.message);
        // Cho phép load danh sách đám mây chạy ngầm ở nền, không chặn giao diện người dùng
        loadCloudPallets().catch(err => console.warn('Lỗi tải ngầm cloud pallets:', err));
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Lỗi đồng bộ', res.message);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setSyncingId(null);
    }
  }

  async function handleSyncAll() {
    const pending = pallets.filter(p => p.sync_status !== 'synced');
    if (pending.length === 0) {
      Alert.alert('Thông báo', 'Tất cả Pallet đều đã được đồng bộ!');
      return;
    }

    setIsSyncingAll(true);
    let successCount = 0;
    try {
      for (const p of pending) {
        const boxes = await getBoxesByPallet(p.id);
        const res = await syncPalletToSupabase(p, boxes);
        if (res.success) successCount++;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadLocalPallets();
      setIsSyncingAll(false);
      Alert.alert('Đồng bộ xong', `Đã đồng bộ thành công ${successCount} / ${pending.length} Pallet lên Server!`);
      loadCloudPallets().catch(err => console.warn('Lỗi tải ngầm cloud pallets:', err));
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setIsSyncingAll(false);
    }
  }

  // ── CHUYỂN PALLET TỪ CHỜ ĐẨY SANG CHỜ GIẢI MÃ ──
  async function handleMoveToDecode(pallet: Pallet) {
    try {
      const boxList = await getBoxesByPallet(pallet.id);
      if (boxList.length === 0) {
        Alert.alert('Không có dữ liệu', 'Pallet này không có thùng nào để chuyển.');
        return;
      }

      // Tìm ảnh con dấu từ các thùng trong Pallet
      let photoUri = '';
      let cropPhotoUri: string | null = null;

      for (const b of boxList) {
        if (b.stamp_image_url) {
          photoUri = b.stamp_image_url;
        }
        if (b.drive_view_url && !photoUri) {
          photoUri = b.drive_view_url;
        }
        if (b.raw_text) {
          try {
            const parsed = JSON.parse(b.raw_text);
            if (parsed.photo_uri || parsed.photoUri) {
              photoUri = parsed.photo_uri || parsed.photoUri;
              cropPhotoUri = parsed.crop_uri || parsed.cropPhotoUri || null;
              break;
            }
          } catch {}
        }
        if (photoUri) break;
      }

      // Nếu chưa có ảnh nhưng Pallet có dữ liệu số con dấu đã quét (Dòng 1 / Dòng 2)
      let sampleStampBox: any = null;
      if (!photoUri) {
        sampleStampBox = boxList.find(b => b.stamp_line1 || b.stamp_line2 || b.scan_type === 'stamp' || b.lot_code === 'STAMP');
        if (sampleStampBox) {
          const l1 = sampleStampBox.stamp_line1 || '';
          const l2 = sampleStampBox.stamp_line2 || sampleStampBox.lot_code || '';
          const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="100%" height="100%" fill="%230f172a" rx="16"/><rect x="12" y="12" width="376" height="196" fill="%231e293b" rx="12" stroke="%23f59e0b" stroke-width="2" stroke-dasharray="6,4"/><text x="50%" y="45" fill="%2338bdf8" font-size="16" font-family="sans-serif" font-weight="bold" text-anchor="middle">PALLET ${pallet.code}</text><text x="50%" y="95" fill="%23facc15" font-size="15" font-family="monospace" font-weight="bold" text-anchor="middle">D1: ${l1 || '---'}</text><text x="50%" y="135" fill="%234ade80" font-size="15" font-family="monospace" font-weight="bold" text-anchor="middle">D2: ${l2 || '---'}</text><text x="50%" y="180" fill="%2394a3b8" font-size="12" font-family="sans-serif" text-anchor="middle">Chuyển từ mục Chờ đẩy</text></svg>`;
          photoUri = `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;
          cropPhotoUri = photoUri;
        }
      }

      if (!photoUri) {
        Alert.alert(
          'Không thể chuyển giải mã',
          `Pallet "${pallet.code}" không phải là Pallet đóng dấu hoặc không có dữ liệu số đóng dấu để chuyển.`
        );
        return;
      }

      const hasDirectInfo = sampleStampBox?.stamp_line1 ? ` (D1: ${sampleStampBox.stamp_line1})` : '';
      Alert.alert(
        'Chuyển sang Chờ giải mã',
        `Bạn có chắc muốn chuyển Pallet "${pallet.code}" (${boxList.length} thùng)${hasDirectInfo} sang hàng đợi Chờ giải mã không?\n\nPallet sẽ được rút khỏi mục Chờ đẩy và chuyển vào tab Chờ giải mã để Server duyệt tạo LOT.`,
        [
          { text: 'Hủy', style: 'cancel' },
          {
            text: 'Chuyển ngay',
            style: 'default',
            onPress: async () => {
              try {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

                // Đưa vào hàng đợi giải mã nền (lưu an toàn vào SQLite/AsyncStorage)
                await enqueueStampPhotoForBackgroundSync({
                  photoUri,
                  cropPhotoUri,
                  palletStt: pallet.code,
                  palletTag: pallet.tag || null,
                  palletNotes: pallet.notes || null,
                  boxCount: boxList.length,
                  boxWeight: boxList[0]?.weight || 20,
                  stamp_line1: sampleStampBox?.stamp_line1 || null,
                  stamp_line2: sampleStampBox?.stamp_line2 || null,
                });

                // Xóa pallet khỏi SQLite bảng pallets & boxes
                await deletePallet(pallet.id);

                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                await loadLocalPallets();
                await loadStampQueue(false);

                // Đóng modal chi tiết nếu đang mở
                setSelectedPallet(null);

                // Tự động chuyển sang Tab Chờ giải mã
                setActiveTab('stamp_pending');

                Alert.alert(
                  'Thành công',
                  `🎉 Đã chuyển Pallet "${pallet.code}" (${boxList.length} thùng) sang hàng đợi Chờ giải mã!`
                );
              } catch (err: any) {
                Alert.alert('Lỗi chuyển giải mã', err?.message || 'Có lỗi xảy ra');
              }
            }
          }
        ]
      );
    } catch (e: any) {
      Alert.alert('Lỗi', e?.message || 'Không thể lấy thông tin thùng');
    }
  }

  // ── DELETE LOCAL PALLET ──
  async function handleDelete(pallet: Pallet) {
    const isSynced = pallet.sync_status === 'synced';

    Alert.alert(
      isSynced ? 'Xóa Pallet đã đồng bộ khỏi máy' : 'Xóa Pallet chưa đồng bộ',
      isSynced
        ? `Pallet ${pallet.code} (${pallet.scanned_qty} thùng) đã từng được đẩy lên Server.\n\nBạn có muốn xóa Pallet này khỏi bộ nhớ máy con để dọn dẹp hoặc quét lại không? (Thao tác này chỉ xóa trên điện thoại, không ảnh hưởng tới dữ liệu trên Server).`
        : `Bạn có chắc muốn xóa Pallet ${pallet.code} cùng ${pallet.scanned_qty} thùng bên trong khỏi máy?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: isSynced ? 'Xóa khỏi máy' : 'Xóa ngay',
          style: 'destructive',
          onPress: async () => {
            await deletePallet(pallet.id);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            await loadLocalPallets();
          }
        }
      ]
    );
  }

  // ── BOX ACTIONS IN DETAIL MODAL ───────────────────────────
  async function handleOpenLocalDetail(pallet: Pallet) {
    setSelectedPallet(pallet);
    setSelectedCloudPallet(null);
    setIsLoadingBoxes(true);
    try {
      const boxList = await getBoxesByPallet(pallet.id);
      setSelectedBoxes(boxList);
    } finally {
      setIsLoadingBoxes(false);
    }
  }

  async function handleOpenCloudDetail(cp: CloudPallet) {
    setSelectedCloudPallet(cp);
    setSelectedPallet(null);
    setIsLoadingBoxes(true);
    try {
      const res = await fetchCloudPalletBoxes(cp.stt, cp.lot_id);
      if (res.success) {
        setSelectedBoxes(res.data);
      } else {
        setSelectedBoxes([]);
        Alert.alert('Thông báo', res.message || 'Không thể tải danh sách thùng từ Server.');
      }
    } finally {
      setIsLoadingBoxes(false);
    }
  }

  async function handleDeleteBox(box: BoxLabel) {
    if (!selectedPallet) return;
    if (selectedPallet.sync_status === 'synced' || selectedCloudPallet) {
      Alert.alert('Không thể xóa', 'Dữ liệu đã đồng bộ lên Server không được phép chỉnh sửa hoặc xóa từ điện thoại.');
      return;
    }

    Alert.alert(
      'Xóa thùng này',
      `Bạn có chắc muốn xóa Thùng #${box.box_index} (${box.sku}) khỏi Pallet ${selectedPallet.code}?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa ngay',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteBox(box.id, selectedPallet.id);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              const updatedBoxes = await getBoxesByPallet(selectedPallet.id);
              setSelectedBoxes(updatedBoxes);
              await loadLocalPallets();
              const updatedPallets = await getAllPallets();
              const cur = updatedPallets.find(p => p.id === selectedPallet.id);
              if (cur) setSelectedPallet(cur);
            } catch (err: any) {
              Alert.alert('Lỗi khi xóa', err.message);
            }
          }
        }
      ]
    );
  }

  async function handleCloneBox(box: BoxLabel) {
    if (!selectedPallet) return;
    if (selectedPallet.sync_status === 'synced' || selectedCloudPallet) {
      Alert.alert('Không thể nhân bản', 'Dữ liệu đã đồng bộ lên Server không được phép nhân bản.');
      return;
    }

    const remaining = Math.max(1, selectedPallet.target_qty - selectedBoxes.length);
    Alert.alert(
      'Nhân bản thùng hàng',
      `Sao chép thùng #${box.box_index} (${box.sku}) sang ${remaining} thùng tiếp theo trên Pallet ${selectedPallet.code}?\n\n(Hệ thống sẽ cấp số STT INDEX mới liên tiếp, giữ nguyên thông tin sản phẩm và ngày tháng)`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: `Nhân bản +1 thùng`,
          onPress: async () => {
            await executeClone(box, 1);
          }
        },
        {
          text: `Điền đủ +${remaining} thùng`,
          onPress: async () => {
            await executeClone(box, remaining);
          }
        }
      ]
    );
  }

  async function executeClone(box: BoxLabel, count: number) {
    if (!selectedPallet) return;
    try {
      const res = await cloneBoxToPallet(selectedPallet.id, box, count);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const updatedBoxes = await getBoxesByPallet(selectedPallet.id);
      setSelectedBoxes(updatedBoxes);
      await loadLocalPallets();
      const updatedPallets = await getAllPallets();
      const cur = updatedPallets.find(p => p.id === selectedPallet.id);
      if (cur) setSelectedPallet(cur);
      Alert.alert('Thành công', `Đã nhân bản thêm ${res.addedCount} thùng vào Pallet ${selectedPallet.code}!`);
    } catch (e: any) {
      Alert.alert('Lỗi nhân bản', e.message);
    }
  }

  // Filter lists (Chỉ hiển thị các Pallet có thùng thường thực tế, loại bỏ Pallet 0 thùng hoặc đang chờ giải mã AI)
  const pendingPallets = pallets.filter(
    p => p.sync_status !== 'synced' && p.scanned_qty > 0 && p.stamp_line1 !== 'CHỜ GIẢI MÃ AI'
  );
  const pendingCount = pendingPallets.length;

  // Advanced Filter state for Cloud Pallets
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [filterCriteria, setFilterCriteria] = useState<CloudFilterCriteria>({
    statusFilter: 'all',
  });
  const [draftFilter, setDraftFilter] = useState<CloudFilterCriteria>({
    statusFilter: 'all',
  });

  const CLOUD_PAGE_SIZE = 50;
  const [cloudCurrentPage, setCloudCurrentPage] = useState(1);
  const cloudFlatListRef = useRef<FlatList>(null);

  // Tổng hợp sản phẩm từ bảng products trên Supabase VÀ từ các LOT đang tải về
  const allProductSuggestions = useMemo(() => {
    const map = new Map<string, ProductSuggestion>();

    // 1. Từ Supabase products
    for (const p of availableProducts) {
      if (p.name && p.name.trim()) {
        map.set(p.name.trim(), { ...p });
      }
    }

    // 2. Trích xuất từ các LOT đang hiển thị
    for (const cp of cloudPallets) {
      if (cp.product_name && cp.product_name.trim()) {
        const key = cp.product_name.trim();
        if (!map.has(key)) {
          map.set(key, {
            id: cp.id,
            name: key,
            sku: cp.sku || '',
            aliases: cp.product_aliases || null,
          });
        } else {
          const item = map.get(key)!;
          if (!item.aliases && cp.product_aliases) {
            item.aliases = cp.product_aliases;
          }
          if (!item.sku && cp.sku) {
            item.sku = cp.sku;
          }
        }
      }
    }

    return Array.from(map.values());
  }, [availableProducts, cloudPallets]);

  function getProductSuggestions(term: string, products: ProductSuggestion[]): ProductSuggestionItem[] {
    const cleanTerm = term.trim();
    if (!cleanTerm || products.length === 0) return [];

    const list: ProductSuggestionItem[] = [];

    for (const p of products) {
      const score = calculateSearchScore(p, cleanTerm);
      if (score > 0) {
        let badgeText: string | undefined;
        let badgeType: 'alias' | 'sku' | undefined;
        let fillValue = p.name;

        if (p.aliases) {
          const aliasItems = String(p.aliases).split(/[,;\n]/).map((a: string) => a.trim()).filter(Boolean);
          const found = aliasItems.find((a: string) => matchSearch(a, cleanTerm));
          if (found) {
            badgeType = 'alias';
            badgeText = `⚡ ${found}`;
            fillValue = p.name;
          }
        }

        if (!badgeType) {
          if (p.sku && matchSearch(p.sku, cleanTerm)) {
            badgeType = 'sku';
            badgeText = `SKU: ${p.sku}`;
            fillValue = p.sku;
          }
        }

        list.push({
          product: p,
          score,
          fillValue,
          displayTitle: p.name,
          displaySubtitle: p.sku ? `SKU: ${p.sku}` : undefined,
          badgeType,
          badgeText,
        });
      }
    }

    return list
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  // Gợi ý cho ô tìm kiếm chính (kết hợp STT của LOT + Sản phẩm theo thuật toán Web mẹ)
  const searchProductSuggestions = useMemo(() => {
    const cleanTerm = cloudSearchQuery.trim();
    if (!cleanTerm) return [];

    const sttResults: ProductSuggestionItem[] = [];
    const cleanSttQ = normalizeText(cleanTerm).replace(/^(#|stt[:\s-#]*)/i, '').trim();
    const isExplicitStt = /^(#|stt[:\s-#]+)/i.test(cleanTerm);

    if (cleanSttQ) {
      const seenStts = new Set<string>();
      for (const cp of cloudPallets) {
        if (!cp.stt) continue;
        const sttKey = cp.stt.trim().toUpperCase();
        if (seenStts.has(sttKey)) continue;
        const normStt = normalizeText(cp.stt);
        let sttScore = 0;
        if (normStt === cleanSttQ) sttScore = 5000;
        else if (normStt.startsWith(cleanSttQ)) sttScore = 4000 - normStt.length;
        else if (normStt.includes(cleanSttQ)) sttScore = 3000 - normStt.length;

        if (sttScore > 0) {
          seenStts.add(sttKey);
          sttResults.push({
            product: {
              id: 'stt_' + cp.id,
              name: cp.product_name || 'Hàng đông lạnh',
              sku: cp.sku || '',
              aliases: cp.product_aliases || null
            },
            score: sttScore,
            fillValue: `#${cp.stt}`,
            displayTitle: cp.product_name || 'Hàng đông lạnh',
            displaySubtitle: [
              cp.location_code ? `📍 ${cp.location_code}` : null,
              cp.boxes_count ? `📦 ${cp.boxes_count} thùng` : null,
              cp.lot_code ? `LOT: ${cp.lot_code}` : null
            ].filter(Boolean).join('  ·  '),
            badgeType: 'alias',
            badgeText: `STT: #${cp.stt}`
          });
        }
      }
      sttResults.sort((a, b) => b.score - a.score);
    }

    if (isExplicitStt) {
      return sttResults.slice(0, 8);
    }

    const prodResults = getProductSuggestions(cloudSearchQuery, allProductSuggestions);
    return [...sttResults.slice(0, 5), ...prodResults.slice(0, 5)].slice(0, 8);
  }, [allProductSuggestions, cloudPallets, cloudSearchQuery]);

  // Gợi ý cho ô Tên sản phẩm trong Modal Bộ lọc (theo thuật toán Web mẹ)
  const modalProductSuggestions = useMemo(() => {
    return getProductSuggestions(draftFilter.productName || '', allProductSuggestions);
  }, [allProductSuggestions, draftFilter.productName]);

  // ── LỊCH CHỌN NGÀY (CALENDAR PICKER HELPERS) ────────────────
  function openCalendarPicker(field: 'packagingDate' | 'productionDate') {
    const currentValue = draftFilter[field];
    let initYear = new Date().getFullYear();
    let initMonth = new Date().getMonth();

    if (currentValue) {
      const ymdMatch = currentValue.match(/^(\d{4})[-/](\d{1,2})/);
      const dmyMatch = currentValue.match(/(\d{1,2})[-/](\d{4})$/);
      if (ymdMatch) {
        initYear = parseInt(ymdMatch[1], 10) || initYear;
        initMonth = (parseInt(ymdMatch[2], 10) || 1) - 1;
      } else if (dmyMatch) {
        initYear = parseInt(dmyMatch[2], 10) || initYear;
        initMonth = (parseInt(dmyMatch[1], 10) || 1) - 1;
      }
    }

    setCalendarYear(initYear);
    setCalendarMonth(initMonth);
    setCalendarTargetField(field);
  }

  function handlePrevMonth() {
    if (calendarMonth === 0) {
      setCalendarMonth(11);
      setCalendarYear(calendarYear - 1);
    } else {
      setCalendarMonth(calendarMonth - 1);
    }
  }

  function handleNextMonth() {
    if (calendarMonth === 11) {
      setCalendarMonth(0);
      setCalendarYear(calendarYear + 1);
    } else {
      setCalendarMonth(calendarMonth + 1);
    }
  }

  function handleSelectDay(day: number) {
    if (!calendarTargetField) return;
    const mStr = String(calendarMonth + 1).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const formatted = `${calendarYear}-${mStr}-${dStr}`;

    setDraftFilter(prev => ({
      ...prev,
      [calendarTargetField]: formatted
    }));
    setCalendarTargetField(null);
  }

  function handleQuickDate(type: 'today' | 'yesterday' | 'clear') {
    if (!calendarTargetField) return;
    if (type === 'clear') {
      setDraftFilter(prev => ({
        ...prev,
        [calendarTargetField]: undefined
      }));
      setCalendarTargetField(null);
      return;
    }

    const d = new Date();
    if (type === 'yesterday') {
      d.setDate(d.getDate() - 1);
    }
    const yStr = d.getFullYear();
    const mStr = String(d.getMonth() + 1).padStart(2, '0');
    const dStr = String(d.getDate()).padStart(2, '0');
    const formatted = `${yStr}-${mStr}-${dStr}`;

    setDraftFilter(prev => ({
      ...prev,
      [calendarTargetField]: formatted
    }));
    setCalendarTargetField(null);
  }

  const calendarDaysData = useMemo(() => {
    const totalDays = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
    const offset = (firstDay + 6) % 7; // Monday = 0

    const days: (number | null)[] = [];
    for (let i = 0; i < offset; i++) {
      days.push(null);
    }
    for (let d = 1; d <= totalDays; d++) {
      days.push(d);
    }
    return days;
  }, [calendarYear, calendarMonth]);

  function matchProductSearch(cp: CloudPallet, query: string): boolean {
    if (!query || !query.trim()) return true;
    const cleanQ = query.trim();

    const pObj = {
      name: cp.product_name,
      sku: cp.sku,
      aliases: cp.product_aliases,
    };

    if (calculateSearchScore(pObj, cleanQ) > 0) return true;
    if (matchSearch(pObj, cleanQ)) return true;

    return false;
  }

  const hasActiveFilters = Boolean(
    filterCriteria.productName?.trim() ||
    filterCriteria.productionPlace?.trim() ||
    filterCriteria.materialZone?.trim() ||
    filterCriteria.packagingDate?.trim() ||
    filterCriteria.productionDate?.trim() ||
    filterCriteria.locationCode?.trim() ||
    (filterCriteria.statusFilter && filterCriteria.statusFilter !== 'all')
  );

  const filteredCloudPallets = useMemo(() => {
    return cloudPallets.filter(cp => {
      // 1. Text Search đa năng (quét qua tất cả: STT, Mã LOT, Sản phẩm, Tên gõ tắt, SKU, Nơi SX, Vùng NL, Vị trí kho, Ngày đóng gói, NSX...)
      if (cloudSearchQuery.trim()) {
        const rawQ = cloudSearchQuery.trim();
        const q = normalizeText(rawQ);
        const cleanSttQ = q.replace(/^(#|stt[:\s-#]*)/i, '').trim();
        if (/^(#|stt[:\s-#]+)/i.test(rawQ)) {
          if (!cp.stt || !cleanSttQ || !normalizeText(cp.stt).includes(cleanSttQ)) return false;
        } else {
          const matchProduct = matchProductSearch(cp, cloudSearchQuery);
          const matchSearch =
            matchProduct ||
            (cleanSttQ && normalizeText(cp.stt).includes(cleanSttQ)) ||
            (cp.lot_code && normalizeText(cp.lot_code).includes(q)) ||
            (cp.tag && normalizeText(cp.tag).includes(q)) ||
            (cp.production_place && normalizeText(cp.production_place).includes(q)) ||
            (cp.material_zone && normalizeText(cp.material_zone).includes(q)) ||
            matchDate(cp.packaging_date, cloudSearchQuery) ||
            matchDate(cp.production_date, cloudSearchQuery) ||
            (cp.location_code && normalizeText(cp.location_code).includes(q));
          if (!matchSearch) return false;
        }
      }

      // 2. Bộ lọc chi tiết theo trường
      if (filterCriteria.productName?.trim()) {
        if (!matchProductSearch(cp, filterCriteria.productName)) return false;
      }

      if (filterCriteria.productionPlace?.trim()) {
        const pl = normalizeText(filterCriteria.productionPlace);
        if (!cp.production_place || !normalizeText(cp.production_place).includes(pl)) return false;
      }

      if (filterCriteria.materialZone?.trim()) {
        const mz = normalizeText(filterCriteria.materialZone);
        if (!cp.material_zone || !normalizeText(cp.material_zone).includes(mz)) return false;
      }

      if (filterCriteria.locationCode?.trim()) {
        const loc = normalizeText(filterCriteria.locationCode);
        if (!cp.location_code || !normalizeText(cp.location_code).includes(loc)) return false;
      }

      if (filterCriteria.packagingDate?.trim()) {
        if (!matchDate(cp.packaging_date, filterCriteria.packagingDate)) return false;
      }

      if (filterCriteria.productionDate?.trim()) {
        if (!matchDate(cp.production_date, filterCriteria.productionDate)) return false;
      }

      if (filterCriteria.statusFilter && filterCriteria.statusFilter !== 'all') {
        if (filterCriteria.statusFilter === 'linked') {
          if (!cp.is_linked || cp.status === 'exported') return false;
        } else if (filterCriteria.statusFilter === 'unlinked') {
          if (cp.is_linked) return false;
        } else if (filterCriteria.statusFilter === 'exported') {
          if (cp.status !== 'exported') return false;
        }
      }

      return true;
    });
  }, [cloudPallets, cloudSearchQuery, filterCriteria]);

  const totalCloudPages = Math.max(1, Math.ceil(filteredCloudPallets.length / CLOUD_PAGE_SIZE));

  const paginatedCloudPallets = useMemo(() => {
    const start = (cloudCurrentPage - 1) * CLOUD_PAGE_SIZE;
    return filteredCloudPallets.slice(start, start + CLOUD_PAGE_SIZE);
  }, [filteredCloudPallets, cloudCurrentPage]);

  const goToCloudPage = (page: number) => {
    const valid = Math.max(1, Math.min(totalCloudPages, page));
    setCloudCurrentPage(valid);
    cloudFlatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filterCriteria.productName?.trim()) count++;
    if (filterCriteria.productionPlace?.trim()) count++;
    if (filterCriteria.materialZone?.trim()) count++;
    if (filterCriteria.locationCode?.trim()) count++;
    if (filterCriteria.packagingDate?.trim()) count++;
    if (filterCriteria.productionDate?.trim()) count++;
    if (filterCriteria.statusFilter && filterCriteria.statusFilter !== 'all') count++;
    return count;
  }, [filterCriteria]);

  const openFilterModal = () => {
    setDraftFilter({ ...filterCriteria });
    setIsFilterModalOpen(true);
  };

  const applyDraftFilter = () => {
    setFilterCriteria({ ...draftFilter });
    setCloudCurrentPage(1);
    setIsFilterModalOpen(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const resetDraftFilter = () => {
    setDraftFilter({ statusFilter: 'all' });
  };

  const clearAllFilters = () => {
    setFilterCriteria({ statusFilter: 'all' });
    setDraftFilter({ statusFilter: 'all' });
    setCloudSearchQuery('');
    setCloudCurrentPage(1);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const removeSingleFilter = (key: keyof CloudFilterCriteria) => {
    const updated = { ...filterCriteria };
    if (key === 'statusFilter') {
      updated.statusFilter = 'all';
    } else {
      delete updated[key];
    }
    setFilterCriteria(updated);
    setCloudCurrentPage(1);
  };

  const isViewingReadOnly = !!selectedCloudPallet || selectedPallet?.sync_status === 'synced';
  const modalTitle = selectedPallet ? selectedPallet.code : selectedCloudPallet?.stt || '';
  const modalTag = selectedPallet?.tag || selectedCloudPallet?.tag;
  const modalWeight = selectedPallet ? selectedPallet.total_weight : selectedCloudPallet?.total_weight || 0;

  const stampPendingList = useMemo(() => {
    return stampQueueItems.filter(i => i.status === 'pending' || i.status === 'error');
  }, [stampQueueItems]);

  const stampDecodedList = useMemo(() => {
    return stampQueueItems.filter(i => i.status === 'decoded');
  }, [stampQueueItems]);

  // Gom nhóm các con dấu offline chờ mạng theo cùng STT Pallet
  const groupedOfflineStampList = useMemo(() => {
    const map = new Map<string, {
      key: string;
      palletStt: string;
      palletTag?: string | null;
      palletNotes?: string | null;
      totalBoxes: number;
      totalWeight: number;
      createdAt: string;
      items: StampQueueBackgroundItem[];
    }>();

    for (const item of offlineStampItems) {
      const key = (item.palletStt || '').trim().toUpperCase() || item.id;
      if (!map.has(key)) {
        map.set(key, {
          key,
          palletStt: item.palletStt,
          palletTag: item.palletTag,
          palletNotes: item.palletNotes,
          totalBoxes: 0,
          totalWeight: 0,
          createdAt: item.createdAt,
          items: []
        });
      }
      const g = map.get(key)!;
      g.totalBoxes += Number(item.boxCount) || 0;
      g.totalWeight += (Number(item.boxCount) || 0) * (Number(item.boxWeight) || 20);
      g.items.push(item);
      if (!g.palletTag && item.palletTag) g.palletTag = item.palletTag;
      if (!g.palletNotes && item.palletNotes) g.palletNotes = item.palletNotes;
    }
    return Array.from(map.values());
  }, [offlineStampItems]);

  // Gom nhóm các con dấu chờ giải mã theo cùng STT Pallet
  const groupedStampPendingList = useMemo(() => {
    const map = new Map<string, {
      key: string;
      pallet_stt: string;
      pallet_tag?: string | null;
      pallet_notes?: string | null;
      total_boxes: number;
      total_weight: number;
      created_by_name?: string | null;
      created_at: string;
      items: StampQueueItemMobile[];
    }>();

    for (const item of stampPendingList) {
      const key = (item.pallet_stt || '').trim().toUpperCase() || item.id;
      if (!map.has(key)) {
        map.set(key, {
          key,
          pallet_stt: item.pallet_stt,
          pallet_tag: item.pallet_tag,
          pallet_notes: item.pallet_notes,
          total_boxes: 0,
          total_weight: 0,
          created_by_name: item.created_by_name,
          created_at: item.created_at,
          items: []
        });
      }
      const g = map.get(key)!;
      g.total_boxes += Number(item.box_count) || 0;
      g.total_weight += (Number(item.box_count) || 0) * (Number(item.box_weight) || 20);
      g.items.push(item);
      if (!g.pallet_tag && item.pallet_tag) g.pallet_tag = item.pallet_tag;
      if (!g.pallet_notes && item.pallet_notes) g.pallet_notes = item.pallet_notes;
    }
    return Array.from(map.values());
  }, [stampPendingList]);

  // Gom nhóm các con dấu đã giải mã theo cùng STT Pallet
  const groupedStampDecodedList = useMemo(() => {
    const map = new Map<string, {
      key: string;
      pallet_stt: string;
      pallet_tag?: string | null;
      pallet_notes?: string | null;
      total_boxes: number;
      total_weight: number;
      created_by_name?: string | null;
      created_at: string;
      items: StampQueueItemMobile[];
    }>();

    for (const item of stampDecodedList) {
      const key = (item.pallet_stt || '').trim().toUpperCase() || item.id;
      if (!map.has(key)) {
        map.set(key, {
          key,
          pallet_stt: item.pallet_stt,
          pallet_tag: item.pallet_tag,
          pallet_notes: item.pallet_notes,
          total_boxes: 0,
          total_weight: 0,
          created_by_name: item.created_by_name,
          created_at: item.created_at,
          items: []
        });
      }
      const g = map.get(key)!;
      g.total_boxes += Number(item.box_count) || 0;
      g.total_weight += (Number(item.box_count) || 0) * (Number(item.box_weight) || 20);
      g.items.push(item);
      if (!g.pallet_tag && item.pallet_tag) g.pallet_tag = item.pallet_tag;
      if (!g.pallet_notes && item.pallet_notes) g.pallet_notes = item.pallet_notes;
    }
    return Array.from(map.values());
  }, [stampDecodedList]);

  const stampPendingCount = groupedOfflineStampList.length + groupedStampPendingList.length;
  const stampDecodedCount = groupedStampDecodedList.length;
  const cloudCount = cloudPallets.length;

  return (
    <View style={styles.container}>
      {/* ── TOP BAR ───────────────────────────────── */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={onBackToScanner}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
          <Text style={styles.backBtnText}>
            {scannerMode === 'scanner' ? 'Quét Thùng' : 'Quét Đóng Dấu'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>DANH SÁCH PALLET</Text>
        <TouchableOpacity onPress={handleRefreshAll}>
          <Ionicons name="refresh" size={20} color="#38bdf8" />
        </TouchableOpacity>
      </View>

      {/* ── CONNECTION BANNER ─────────────────────── */}
      <View style={styles.connectionBanner}>
        <Text style={styles.connectionText}>{connectionStatus}</Text>
        <TouchableOpacity onPress={checkNetwork}>
          <Text style={styles.pingBtnText}>Kiểm tra</Text>
        </TouchableOpacity>
      </View>

      {/* ── 4 TAB SWITCHER: Chờ đẩy, Chờ giải mã, Đã giải mã, Đã duyệt ─────────── */}
      <View style={styles.tabContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabScrollContent}
        >
          {/* Tab 1: Chờ đẩy */}
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'pending' && styles.tabButtonActivePending]}
            onPress={() => setActiveTab('pending')}
          >
            <Ionicons
              name="time-outline"
              size={15}
              color={activeTab === 'pending' ? '#fbbf24' : '#94a3b8'}
            />
            <Text style={[styles.tabButtonText, activeTab === 'pending' && styles.tabTextPendingActive]}>
              Chờ đẩy ({pendingCount})
            </Text>
          </TouchableOpacity>

          {/* Tab 2: Chờ giải mã */}
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'stamp_pending' && styles.tabButtonActiveStampPending]}
            onPress={() => {
              setActiveTab('stamp_pending');
              void loadStampQueue(stampQueueItems.length > 0);
            }}
          >
            <Ionicons
              name="hourglass-outline"
              size={15}
              color={activeTab === 'stamp_pending' ? '#fb923c' : '#94a3b8'}
            />
            <Text style={[styles.tabButtonText, activeTab === 'stamp_pending' && styles.tabTextStampPendingActive]}>
              Chờ giải mã ({stampPendingCount})
            </Text>
          </TouchableOpacity>

          {/* Tab 3: Đã giải mã */}
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'stamp_decoded' && styles.tabButtonActiveStampDecoded]}
            onPress={() => {
              setActiveTab('stamp_decoded');
              void loadStampQueue(stampQueueItems.length > 0);
            }}
          >
            <Ionicons
              name="checkmark-done-circle-outline"
              size={15}
              color={activeTab === 'stamp_decoded' ? '#c084fc' : '#94a3b8'}
            />
            <Text style={[styles.tabButtonText, activeTab === 'stamp_decoded' && styles.tabTextStampDecodedActive]}>
              Đã giải mã ({stampDecodedCount})
            </Text>
          </TouchableOpacity>

          {/* Tab 4: Đã duyệt */}
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'cloud' && styles.tabButtonActiveCloud]}
            onPress={() => {
              setActiveTab('cloud');
              if (cloudPallets.length === 0) void loadCloudPallets();
            }}
          >
            <Ionicons
              name="checkmark-circle-outline"
              size={15}
              color={activeTab === 'cloud' ? '#4ade80' : '#94a3b8'}
            />
            <Text style={[styles.tabButtonText, activeTab === 'cloud' && styles.tabTextCloudActive]}>
              Đã duyệt ({cloudCount})
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* ── TAB 1: CHỜ ĐẨY LÊN (PALLET KHO LOCAL) ───────────────────────────── */}
      {activeTab === 'pending' && (
        <View style={{ flex: 1 }}>
          {pendingCount > 0 ? (
            <View style={styles.syncAllCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.syncAllTitle}>Có {pendingCount} Pallet chờ đồng bộ</Text>
                <Text style={styles.syncAllSub}>Dữ liệu đang lưu an toàn trong máy</Text>
              </View>
              <TouchableOpacity
                style={styles.syncAllBtn}
                disabled={isSyncingAll}
                onPress={handleSyncAll}
              >
                {isSyncingAll ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="cloud-upload" size={18} color="#fff" />
                    <Text style={styles.syncAllBtnText}>ĐỒNG BỘ TẤT CẢ</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#38bdf8" />
          ) : pendingPallets.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="checkmark-circle-outline" size={54} color="#10b981" />
              <Text style={styles.emptyTitle}>Không có Pallet nào chờ đẩy lên</Text>
              <Text style={styles.emptySub}>
                Tất cả các Pallet bạn quét đã được đẩy lên Server thành công hoặc chưa có lượt quét mới.
              </Text>
              <TouchableOpacity
                style={styles.viewCloudBtn}
                onPress={() => setActiveTab('cloud')}
              >
                <Ionicons name="cloud-outline" size={16} color="#38bdf8" />
                <Text style={styles.viewCloudBtnText}>Xem danh sách Đã lên Server</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <FlatList
              data={pendingPallets}
              keyExtractor={item => item.id}
              contentContainerStyle={{ padding: 16 }}
              refreshControl={
                <RefreshControl
                  refreshing={loading}
                  onRefresh={() => loadLocalPallets(false)}
                  tintColor="#38bdf8"
                  colors={['#38bdf8']}
                />
              }
              renderItem={({ item }) => {
                const isSyncing = syncingId === item.id;
                const isError = item.sync_status === 'error';

                const offlineMatch = offlineStampItems.find(o => (o.palletStt || '').trim().toUpperCase() === item.code.trim().toUpperCase());
                const queueMatch = stampQueueItems.find(q => (q.pallet_stt || '').trim().toUpperCase() === item.code.trim().toUpperCase());

                const imgSrc = offlineMatch?.cropPhotoUri || offlineMatch?.photoUri
                  || getDirectDriveImage(
                       item.stamp_image_url || queueMatch?.image_url,
                       queueMatch?.cropped_image_url,
                       item.drive_file_id || queueMatch?.drive_file_id
                     );

                const fullImgSrc = offlineMatch?.photoUri
                  || getFullStampImage(
                       item.stamp_image_url || queueMatch?.image_url,
                       queueMatch?.cropped_image_url,
                       item.drive_file_id || queueMatch?.drive_file_id
                     ) || imgSrc;

                const line1 = item.stamp_line1 || queueMatch?.stamp_line1;
                const line2 = item.stamp_line2 || queueMatch?.stamp_line2;
                const prodTitle = item.product_name || queueMatch?.decoded_json?.productTitle || queueMatch?.decoded_json?.special12Name || (line1 ? 'Sản phẩm con dấu' : 'Pallet thùng');
                const specText = item.spec || queueMatch?.decoded_json?.spec;
                const packDateText = item.packaging_date || queueMatch?.decoded_json?.packagingDateStr;
                const prodDateText = item.production_date || queueMatch?.decoded_json?.rawMaterialDateStr;
                const regionText = item.region || queueMatch?.decoded_json?.provinceName;
                const weightPerBox = item.box_weight || queueMatch?.box_weight || (item.scanned_qty > 0 && item.total_weight ? Math.round(item.total_weight / item.scanned_qty) : 20);
                const senderName = (item as any).created_by_name || queueMatch?.created_by_name || 'Kho';

                return (
                  <TouchableOpacity
                    style={[styles.palletCard, (line1 || line2 || imgSrc) ? { borderColor: '#f59e0b' } : null]}
                    onPress={() => handleOpenLocalDetail(item)}
                  >
                    <View style={styles.palletCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
                        <Ionicons name="cube" size={18} color="#fbbf24" style={{ marginRight: 6 }} />
                        <Text style={styles.palletCode}>STT: {item.code}</Text>
                        {item.tag ? (
                          <View style={styles.tagBadge}>
                            <Text style={styles.tagBadgeText}>🏷️ {item.tag}</Text>
                          </View>
                        ) : null}
                      </View>
                      <View style={[
                        styles.syncBadge,
                        { backgroundColor: isError ? '#7f1d1d' : '#7c2d12' }
                      ]}>
                        <Text style={[
                          styles.syncBadgeText,
                          { color: isError ? '#fca5a5' : '#fdba74' }
                        ]}>
                          {isError ? '❌ Lỗi đồng bộ' : '⏳ Chờ đồng bộ'}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.palletCardBody}>
                      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
                        {imgSrc ? (
                          <TouchableOpacity
                            activeOpacity={0.8}
                            onPress={(e) => {
                              e.stopPropagation?.();
                              openPreviewImage(fullImgSrc || imgSrc, `STT: ${item.code}`);
                            }}
                            style={{
                              width: 68,
                              height: 68,
                              borderRadius: 8,
                              overflow: 'hidden',
                              backgroundColor: '#1e293b',
                              borderWidth: 1,
                              borderColor: '#475569'
                            }}
                          >
                            <Image
                              source={{ uri: imgSrc }}
                              style={{ width: '100%', height: '100%' }}
                              resizeMode="cover"
                            />
                          </TouchableOpacity>
                        ) : null}
                        <View style={{ flex: 1, justifyContent: 'center' }}>
                          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 18 }} numberOfLines={2}>
                            {prodTitle}
                          </Text>
                          <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: '700', marginTop: 3 }}>
                            {item.scanned_qty} thùng • {weightPerBox} Kg
                          </Text>
                        </View>
                      </View>

                      {/* 2 Dòng số đọc được (nếu là con dấu) */}
                      {(line1 || line2) ? (
                        <View style={{ backgroundColor: '#0f172a', padding: 8, borderRadius: 8, gap: 4, borderWidth: 1, borderColor: '#334155', marginBottom: 6 }}>
                          <Text style={{ color: '#cbd5e1', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                            <Text style={{ color: '#94a3b8' }}>Dòng 1: </Text>
                            <Text style={{ color: '#38bdf8', fontWeight: 'bold' }}>{line1 || '---'}</Text>
                          </Text>
                          <Text style={{ color: '#cbd5e1', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                            <Text style={{ color: '#94a3b8' }}>Dòng 2: </Text>
                            <Text style={{ color: '#a78bfa', fontWeight: 'bold' }}>{line2 || '---'}</Text>
                          </Text>
                        </View>
                      ) : null}

                      {/* Thông tin quét & thông tin khác */}
                      <View style={{ gap: 4, marginTop: 2, marginBottom: 6 }}>
                        {/* Hàng trên: Thông tin quét */}
                        {(regionText || packDateText || prodDateText) ? (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {regionText ? (
                              <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                                Vùng: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{regionText}</Text>
                              </Text>
                            ) : null}
                            {packDateText ? (
                              <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                                Đóng gói: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{packDateText}</Text>
                              </Text>
                            ) : null}
                            {prodDateText ? (
                              <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                                Nhập NL: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{prodDateText}</Text>
                              </Text>
                            ) : null}
                          </View>
                        ) : null}

                        {/* Hàng dưới: Người gửi */}
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                          <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                            Người gửi: <Text style={{ color: '#cbd5e1' }}>{senderName}</Text>
                          </Text>
                        </View>
                      </View>

                      {item.notes ? (
                        <Text style={[styles.palletNotesText, { marginBottom: 4 }]} numberOfLines={2}>
                          📝 {item.notes}
                        </Text>
                      ) : null}

                      <Text style={styles.palletDate}>
                        Ngày tạo: {item.created_at.slice(0, 16).replace('T', ' ')}
                      </Text>
                    </View>

                    <View style={styles.palletCardFooter}>
                      <TouchableOpacity
                        style={styles.deleteBtn}
                        onPress={() => handleDelete(item)}
                      >
                        <Ionicons name="trash-outline" size={16} color="#ef4444" />
                        <Text style={styles.deleteBtnText}>Xóa</Text>
                      </TouchableOpacity>

                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <TouchableOpacity
                          style={styles.moveToDecodeBtn}
                          onPress={() => handleMoveToDecode(item)}
                        >
                          <Ionicons name="scan-outline" size={15} color="#fdba74" />
                          <Text style={styles.moveToDecodeText}>Chuyển giải mã</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.syncSingleBtn}
                          disabled={isSyncing}
                          onPress={() => handleSyncSingle(item)}
                        >
                          {isSyncing ? (
                            <ActivityIndicator color="#fff" size="small" />
                          ) : (
                            <>
                              <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
                              <Text style={styles.syncSingleText}>Tải lên Server</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      )}

      {/* ── TAB 2: CHỜ GIẢI MÃ ────────────────────────────────────────────── */}
      {activeTab === 'stamp_pending' && (
        <View style={{ flex: 1 }}>
          {stampPendingCount > 0 ? (
            <View style={[styles.syncAllCard, { backgroundColor: '#431407', borderColor: '#ea580c' }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.syncAllTitle}>Có {stampPendingCount} Pallet trong hàng đợi</Text>
                <Text style={styles.syncAllSub}>
                  {offlineStampItems.length > 0 ? `${offlineStampItems.length} chưa gửi (Offline) • ` : ''}
                  {stampPendingList.length} đã gửi chờ Server giải mã
                </Text>
              </View>
              {stampPendingList.length > 0 && (
                <TouchableOpacity
                  style={[styles.syncAllBtn, { backgroundColor: '#ea580c' }]}
                  disabled={isDecodingAllQueue}
                  onPress={handleDecodeAllPending}
                >
                  {isDecodingAllQueue ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="scan-outline" size={16} color="#fff" />
                      <Text style={styles.syncAllBtnText}>GIẢI MÃ TẤT CẢ</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          ) : null}

          {loadingStampQueue ? (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#f97316" />
          ) : stampPendingCount === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="checkmark-circle-outline" size={54} color="#10b981" />
              <Text style={styles.emptyTitle}>Không có Pallet nào chờ giải mã</Text>
              <Text style={styles.emptySub}>
                Tất cả ảnh con dấu gửi lên đã được giải mã xong hoặc chưa có lượt chụp con dấu mới.
              </Text>
              <TouchableOpacity
                style={[styles.viewCloudBtn, { borderColor: '#a855f7' }]}
                onPress={() => setActiveTab('stamp_decoded')}
              >
                <Ionicons name="checkmark-done-circle-outline" size={16} color="#c084fc" />
                <Text style={[styles.viewCloudBtnText, { color: '#c084fc' }]}>Xem danh sách Đã giải mã ({stampDecodedCount})</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={{ padding: 16 }}
              refreshControl={
                <RefreshControl
                  refreshing={loadingStampQueue}
                  onRefresh={() => loadStampQueue(false)}
                  tintColor="#f97316"
                  colors={['#f97316']}
                />
              }
            >
              {/* 1. Danh sách Pallet chụp Offline (Chưa gửi được lên server - Đã gom nhóm theo STT) */}
              {groupedOfflineStampList.map(group => {
                const isGroupSyncing = group.items.some(it => syncingOfflineStampId === it.id);

                if (group.items.length === 1) {
                  const item = group.items[0];
                  const imgSrc = item.cropPhotoUri || item.photoUri;

                  return (
                    <View key={item.id} style={[styles.palletCard, { borderColor: '#d97706', backgroundColor: '#1c1917' }]}>
                      <View style={styles.palletCardHeader}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
                          <Ionicons name="phone-portrait-outline" size={18} color="#fbbf24" style={{ marginRight: 6 }} />
                          <Text style={[styles.palletCode, { color: '#fef3c7' }]}>STT: {item.palletStt}</Text>
                          {item.palletTag ? (
                            <View style={styles.tagBadge}>
                              <Text style={styles.tagBadgeText}>🏷️ {item.palletTag}</Text>
                            </View>
                          ) : null}
                        </View>
                        <View style={[styles.syncBadge, { backgroundColor: '#78350f', borderColor: '#d97706', borderWidth: 1 }]}>
                          <Text style={[styles.syncBadgeText, { color: '#fde68a' }]}>
                            ⚠️ Chưa gửi (Lưu trên máy)
                          </Text>
                        </View>
                      </View>

                      <View style={[styles.palletCardBody, { flexDirection: 'row', gap: 10 }]}>
                        {imgSrc ? (
                          <TouchableOpacity
                            activeOpacity={0.8}
                            onPress={() => openPreviewImage(imgSrc, `STT: ${item.palletStt}`)}
                            style={{
                              width: 68,
                              height: 68,
                              borderRadius: 8,
                              overflow: 'hidden',
                              backgroundColor: '#0c0a09',
                              borderWidth: 1,
                              borderColor: '#78350f'
                            }}
                          >
                            <Image
                              source={{ uri: imgSrc }}
                              style={{ width: '100%', height: '100%' }}
                              resizeMode="cover"
                            />
                          </TouchableOpacity>
                        ) : (
                          <View style={{ width: 68, height: 68, borderRadius: 8, backgroundColor: '#0c0a09', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#78350f' }}>
                            <Ionicons name="image-outline" size={24} color="#78716c" />
                          </View>
                        )}
                        <View style={{ flex: 1, justifyContent: 'space-between' }}>
                          <Text style={styles.palletMeta}>
                            Số lượng: <Text style={{ color: '#22c55e', fontWeight: '900' }}>{item.boxCount || 30}</Text> thùng • {item.boxWeight || 20} Kg
                          </Text>
                          <Text style={{ color: '#f59e0b', fontSize: 11, fontWeight: '600' }}>
                            Chờ có mạng để gửi lên Server
                          </Text>
                          <Text style={styles.palletDate}>
                            Chụp lúc: {item.createdAt?.slice(0, 16).replace('T', ' ')}
                          </Text>
                        </View>
                      </View>

                      <View style={[styles.palletCardFooter, { backgroundColor: 'rgba(120, 53, 15, 0.3)' }]}>
                        <TouchableOpacity
                          style={{ padding: 6 }}
                          onPress={() => handleDeleteOfflineStamp(item)}
                        >
                          <Ionicons name="trash-outline" size={18} color="#f87171" />
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[styles.syncSingleBtn, { backgroundColor: '#d97706' }]}
                          disabled={isGroupSyncing}
                          onPress={() => handleSyncSingleOfflineStamp(item)}
                        >
                          {isGroupSyncing ? (
                            <ActivityIndicator color="#fff" size="small" />
                          ) : (
                            <>
                              <Ionicons name="cloud-upload-outline" size={14} color="#fff" />
                              <Text style={styles.syncSingleText}>Gửi ngay</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                }

                // Pallet ghép nhiều đợt con dấu chụp offline
                return (
                  <View key={group.key} style={[styles.palletCard, { borderColor: '#d97706', backgroundColor: '#1c1917' }]}>
                    <View style={styles.palletCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap', gap: 6 }}>
                        <Ionicons name="phone-portrait-outline" size={18} color="#fbbf24" />
                        <Text style={[styles.palletCode, { color: '#fef3c7' }]}>STT: {group.palletStt}</Text>
                        {group.palletTag ? (
                          <View style={styles.tagBadge}>
                            <Text style={styles.tagBadgeText}>🏷️ {group.palletTag}</Text>
                          </View>
                        ) : null}
                        <View style={[styles.tagBadge, { backgroundColor: '#78350f', borderColor: '#d97706', borderWidth: 1 }]}>
                          <Text style={[styles.tagBadgeText, { color: '#fde68a' }]}>
                            📦 Ghép {group.items.length} đợt con dấu
                          </Text>
                        </View>
                      </View>
                      <View style={[styles.syncBadge, { backgroundColor: '#78350f', borderColor: '#d97706', borderWidth: 1 }]}>
                        <Text style={[styles.syncBadgeText, { color: '#fde68a' }]}>
                          ⚠️ Chưa gửi (Lưu trên máy)
                        </Text>
                      </View>
                    </View>

                    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
                      <Text style={styles.palletMeta}>
                        Tổng số lượng: <Text style={{ color: '#22c55e', fontWeight: '900' }}>{group.totalBoxes}</Text> thùng
                      </Text>
                      <Text style={{ color: '#f59e0b', fontSize: 11, fontWeight: '600', marginTop: 2 }}>
                        Chờ có mạng để gửi lên Server ({group.items.length} đợt ảnh con dấu)
                      </Text>
                    </View>

                    <View style={[styles.palletCardBody, { gap: 8 }]}>
                      {group.items.map((sub, sIdx) => {
                        const imgSrc = sub.cropPhotoUri || sub.photoUri;

                        return (
                          <View
                            key={sub.id || sIdx}
                            style={{
                              backgroundColor: '#0c0a09',
                              borderRadius: 8,
                              padding: 8,
                              borderWidth: 1,
                              borderColor: '#78350f',
                              flexDirection: 'row',
                              gap: 10,
                              alignItems: 'center'
                            }}
                          >
                            {imgSrc ? (
                              <TouchableOpacity
                                activeOpacity={0.8}
                                onPress={() => openPreviewImage(imgSrc, `STT: ${group.palletStt} (Đợt ${sIdx + 1})`)}
                                style={{
                                  width: 52,
                                  height: 52,
                                  borderRadius: 6,
                                  overflow: 'hidden',
                                  backgroundColor: '#1c1917',
                                  borderWidth: 1,
                                  borderColor: '#d97706'
                                }}
                              >
                                <Image source={{ uri: imgSrc }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                              </TouchableOpacity>
                            ) : null}
                            <View style={{ flex: 1, justifyContent: 'center' }}>
                              <Text style={{ color: '#fde68a', fontSize: 11, fontWeight: 'bold' }}>
                                Đợt {sIdx + 1}: <Text style={{ color: '#22c55e', fontWeight: 'bold' }}>{sub.boxCount || 30}</Text> thùng • {sub.boxWeight || 20} Kg
                              </Text>
                              <Text style={styles.palletDate}>
                                Chụp: {sub.createdAt?.slice(0, 16).replace('T', ' ')}
                              </Text>
                            </View>
                            <TouchableOpacity
                              style={{ padding: 6 }}
                              onPress={() => handleDeleteOfflineStamp(sub)}
                            >
                              <Ionicons name="trash-outline" size={16} color="#f87171" />
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                    </View>

                    <View style={[styles.palletCardFooter, { backgroundColor: 'rgba(120, 53, 15, 0.3)' }]}>
                      <TouchableOpacity
                        style={{ padding: 6 }}
                        onPress={() => handleDeleteGroupOfflineStamp(group)}
                      >
                        <Ionicons name="trash-outline" size={18} color="#f87171" />
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.syncSingleBtn, { backgroundColor: '#d97706' }]}
                        disabled={isGroupSyncing}
                        onPress={() => handleSyncGroupOfflineStamp(group)}
                      >
                        {isGroupSyncing ? (
                          <ActivityIndicator color="#fff" size="small" />
                        ) : (
                          <>
                            <Ionicons name="cloud-upload-outline" size={14} color="#fff" />
                            <Text style={styles.syncSingleText}>Gửi ngay ({group.totalBoxes} thùng)</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}

              {/* 2. Danh sách Pallet đã gửi lên Server (Chờ AI giải mã - Gom nhóm theo STT Pallet) */}
              {groupedStampPendingList.map(group => {
                if (group.items.length === 1) {
                  const item = group.items[0];
                  const isDecoding = decodingQueueId === item.id;
                  const isErr = item.status === 'error';
                  const imgSrc = getDirectDriveImage(item.image_url, item.cropped_image_url, item.drive_file_id);
                  const fullImgSrc = getFullStampImage(item.image_url, item.cropped_image_url, item.drive_file_id) || imgSrc;

                  return (
                    <View key={item.id} style={[styles.palletCard, isErr && { borderColor: '#ef4444' }]}>
                      <View style={styles.palletCardHeader}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
                          <Ionicons name="cube" size={20} color="#fb923c" style={{ marginRight: 8 }} />
                          <Text style={styles.palletCode}>STT: {item.pallet_stt}</Text>
                          {item.pallet_tag ? (
                            <View style={styles.tagBadge}>
                              <Text style={styles.tagBadgeText}>🏷️ {item.pallet_tag}</Text>
                            </View>
                          ) : null}
                        </View>
                        <View style={[
                          styles.syncBadge,
                          { backgroundColor: isErr ? '#7f1d1d' : '#7c2d12' }
                        ]}>
                          <Text style={[
                            styles.syncBadgeText,
                            { color: isErr ? '#fca5a5' : '#fdba74' }
                          ]}>
                            {isErr ? '❌ Lỗi giải mã' : '⏳ Đã gửi (Chờ Server xử lý)'}
                          </Text>
                        </View>
                      </View>

                      <View style={[styles.palletCardBody, { flexDirection: 'row', gap: 10 }]}>
                        {imgSrc ? (
                          <TouchableOpacity
                            activeOpacity={0.8}
                            onPress={() => openPreviewImage(fullImgSrc || imgSrc, `STT: ${item.pallet_stt}`)}
                            style={{
                              width: 68,
                              height: 68,
                              borderRadius: 8,
                              overflow: 'hidden',
                              backgroundColor: '#1e293b',
                              borderWidth: 1,
                              borderColor: '#d97706'
                            }}
                          >
                            <Image
                              source={{ uri: imgSrc }}
                              style={{ width: '100%', height: '100%' }}
                              resizeMode="cover"
                            />
                          </TouchableOpacity>
                        ) : (
                          <View style={{ width: 68, height: 68, borderRadius: 8, backgroundColor: '#1e293b', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#334155' }}>
                            <Ionicons name="image-outline" size={24} color="#64748b" />
                          </View>
                        )}
                        <View style={{ flex: 1, justifyContent: 'space-between' }}>
                          <Text style={styles.palletMeta}>
                            Số lượng: <Text style={{ color: '#22c55e', fontWeight: '900' }}>{item.box_count}</Text> thùng • {item.box_weight} Kg
                          </Text>
                          {isErr && item.error_message ? (
                            <Text style={{ color: '#f87171', fontSize: 11, marginTop: 2 }} numberOfLines={2}>
                              ⚠️ {item.error_message}
                            </Text>
                          ) : (
                            <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                              Đã lưu ảnh an toàn trên Server
                            </Text>
                          )}
                          <Text style={styles.palletDate}>
                            Gửi lúc: {item.created_at?.slice(0, 16).replace('T', ' ')}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.palletCardFooter}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: '#cbd5e1', fontSize: 11 }}>
                            Người gửi: <Text style={{ color: '#fff', fontWeight: '600' }}>{item.created_by_name || 'Kho'}</Text>
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={[styles.syncSingleBtn, { backgroundColor: '#ea580c' }]}
                          disabled={isDecoding}
                          onPress={() => handleDecodeItem(item.id)}
                        >
                          {isDecoding ? (
                            <ActivityIndicator color="#fff" size="small" />
                          ) : (
                            <>
                              <Ionicons name="scan-outline" size={14} color="#fff" />
                              <Text style={styles.syncSingleText}>Giải mã</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                }

                // Pallet ghép nhiều ảnh con dấu chờ giải mã
                const hasErr = group.items.some(i => i.status === 'error');
                const isDecoding = group.items.some(i => decodingQueueId === i.id);
                const allIds = group.items.map(i => i.id);

                return (
                  <View key={group.key} style={[styles.palletCard, hasErr && { borderColor: '#ef4444' }]}>
                    <View style={styles.palletCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap', gap: 6 }}>
                        <Ionicons name="cube" size={20} color="#fb923c" />
                        <Text style={styles.palletCode}>STT: {group.pallet_stt}</Text>
                        {group.pallet_tag ? (
                          <View style={styles.tagBadge}>
                            <Text style={styles.tagBadgeText}>🏷️ {group.pallet_tag}</Text>
                          </View>
                        ) : null}
                        <View style={[styles.tagBadge, { backgroundColor: '#7c2d12', borderColor: '#ea580c', borderWidth: 1 }]}>
                          <Text style={[styles.tagBadgeText, { color: '#fdba74' }]}>
                            📦 Ghép {group.items.length} đợt con dấu
                          </Text>
                        </View>
                      </View>
                      <Text style={{ color: '#22c55e', fontSize: 13, fontWeight: '900' }}>
                        Tổng: {group.total_boxes} thùng
                      </Text>
                    </View>

                    <View style={[styles.palletCardBody, { gap: 8 }]}>
                      {group.items.map((sub, sIdx) => {
                        const imgSrc = getDirectDriveImage(sub.image_url, sub.cropped_image_url, sub.drive_file_id);
                        const fullImgSrc = getFullStampImage(sub.image_url, sub.cropped_image_url, sub.drive_file_id) || imgSrc;
                        const isSubErr = sub.status === 'error';

                        return (
                          <View
                            key={sub.id || sIdx}
                            style={{
                              backgroundColor: '#1e293b',
                              borderRadius: 8,
                              padding: 8,
                              borderWidth: 1,
                              borderColor: isSubErr ? '#ef4444' : '#334155',
                              flexDirection: 'row',
                              gap: 10,
                              alignItems: 'center'
                            }}
                          >
                            {imgSrc ? (
                              <TouchableOpacity
                                activeOpacity={0.8}
                                onPress={() => openPreviewImage(fullImgSrc || imgSrc, `STT: ${group.pallet_stt} (Đợt ${sIdx + 1})`)}
                                style={{
                                  width: 52,
                                  height: 52,
                                  borderRadius: 6,
                                  overflow: 'hidden',
                                  backgroundColor: '#0f172a',
                                  borderWidth: 1,
                                  borderColor: '#ea580c'
                                }}
                              >
                                <Image source={{ uri: imgSrc }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                              </TouchableOpacity>
                            ) : null}
                            <View style={{ flex: 1, justifyContent: 'center' }}>
                              <Text style={{ color: '#fdba74', fontSize: 11, fontWeight: 'bold' }}>
                                Đợt {sIdx + 1}: <Text style={{ color: '#22c55e', fontWeight: 'bold' }}>{sub.box_count}</Text> thùng • {sub.box_weight} Kg
                              </Text>
                              {isSubErr && sub.error_message ? (
                                <Text style={{ color: '#f87171', fontSize: 10 }} numberOfLines={1}>
                                  ⚠️ {sub.error_message}
                                </Text>
                              ) : (
                                <Text style={{ color: '#94a3b8', fontSize: 10 }}>
                                  Đã lưu ảnh an toàn trên Server
                                </Text>
                              )}
                              <Text style={styles.palletDate}>
                                Gửi: {sub.created_at?.slice(0, 16).replace('T', ' ')}
                              </Text>
                            </View>
                          </View>
                        );
                      })}

                      <View style={{ marginTop: 2 }}>
                        <Text style={{ color: '#cbd5e1', fontSize: 11 }}>
                          Người gửi: <Text style={{ color: '#fff', fontWeight: '600' }}>{group.created_by_name || 'Kho'}</Text>
                        </Text>
                      </View>
                    </View>

                    <View style={styles.palletCardFooter}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#f59e0b', fontSize: 11, fontWeight: '600' }}>
                          ⏳ Chờ giải mã ({group.items.length} ảnh)
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={[styles.syncSingleBtn, { backgroundColor: '#ea580c' }]}
                        disabled={isDecoding}
                        onPress={() => handleDecodeItem(allIds)}
                      >
                        {isDecoding ? (
                          <ActivityIndicator color="#fff" size="small" />
                        ) : (
                          <>
                            <Ionicons name="scan-outline" size={14} color="#fff" />
                            <Text style={styles.syncSingleText}>Giải mã ({group.items.length})</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* ── TAB 3: ĐÃ GIẢI MÃ ────────────────────────────────────────────── */}
      {activeTab === 'stamp_decoded' && (
        <View style={{ flex: 1 }}>
          {loadingStampQueue ? (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#a855f7" />
          ) : groupedStampDecodedList.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="checkmark-done-circle-outline" size={54} color="#a855f7" />
              <Text style={styles.emptyTitle}>Chưa có Pallet nào được giải mã</Text>
              <Text style={styles.emptySub}>
                Khi giải mã xong ảnh con dấu, kết quả nhận diện sẽ xuất hiện ngay tại đây.
              </Text>
            </View>
          ) : (
            <FlatList
              data={groupedStampDecodedList}
              keyExtractor={group => group.key}
              contentContainerStyle={{ padding: 16 }}
              refreshControl={
                <RefreshControl
                  refreshing={loadingStampQueue}
                  onRefresh={() => loadStampQueue(false)}
                  tintColor="#a855f7"
                  colors={['#a855f7']}
                />
              }
              renderItem={({ item: group }) => {
                if (group.items.length === 1) {
                  const item = group.items[0];
                  const dec = item.decoded_json || {};
                  const prodTitle = dec.productTitle || dec.special12Name || 'Sản phẩm con dấu';
                  const imgSrc = getDirectDriveImage(item.image_url, item.cropped_image_url, item.drive_file_id);
                  const fullImgSrc = getFullStampImage(item.image_url, item.cropped_image_url, item.drive_file_id) || imgSrc;

                  return (
                    <View style={[styles.palletCard, { borderColor: '#7e22ce' }]}>
                      <View style={styles.palletCardHeader}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
                          <Ionicons name="cube" size={18} color="#c084fc" style={{ marginRight: 6 }} />
                          <Text style={[styles.palletCode, { color: '#e9d5ff' }]}>STT: {item.pallet_stt}</Text>
                          {item.pallet_tag ? (
                            <View style={styles.tagBadge}>
                              <Text style={styles.tagBadgeText}>🏷️ {item.pallet_tag}</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>

                      <View style={styles.palletCardBody}>
                        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
                          {imgSrc ? (
                            <TouchableOpacity
                              activeOpacity={0.8}
                              onPress={() => openPreviewImage(fullImgSrc || imgSrc, `STT: ${item.pallet_stt}`)}
                              style={{
                                width: 68,
                                height: 68,
                                borderRadius: 8,
                                overflow: 'hidden',
                                backgroundColor: '#1e293b',
                                borderWidth: 1,
                                borderColor: '#9333ea'
                              }}
                            >
                              <Image
                                source={{ uri: imgSrc }}
                                style={{ width: '100%', height: '100%' }}
                                resizeMode="cover"
                              />
                            </TouchableOpacity>
                          ) : null}
                          <View style={{ flex: 1, justifyContent: 'center' }}>
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 18 }} numberOfLines={2}>
                              {prodTitle}
                            </Text>
                            <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: '700', marginTop: 3 }}>
                              {item.box_count} thùng • {item.box_weight} Kg
                            </Text>
                          </View>
                        </View>

                        {/* 2 Dòng số đọc được */}
                        <View style={{ backgroundColor: '#0f172a', padding: 8, borderRadius: 8, gap: 4, borderWidth: 1, borderColor: '#334155' }}>
                          <Text style={{ color: '#cbd5e1', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                            <Text style={{ color: '#94a3b8' }}>Dòng 1: </Text>
                            <Text style={{ color: '#38bdf8', fontWeight: 'bold' }}>{item.stamp_line1 || '---'}</Text>
                          </Text>
                          <Text style={{ color: '#cbd5e1', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                            <Text style={{ color: '#94a3b8' }}>Dòng 2: </Text>
                            <Text style={{ color: '#a78bfa', fontWeight: 'bold' }}>{item.stamp_line2 || '---'}</Text>
                          </Text>
                        </View>

                        {/* Thông tin giải mã chi tiết */}
                        <View style={{ gap: 4, marginTop: 6 }}>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {dec.provinceName ? (
                              <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                                Vùng: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{dec.provinceName}</Text>
                              </Text>
                            ) : null}
                            {dec.packagingDateStr ? (
                              <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                                Đóng gói: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{dec.packagingDateStr}</Text>
                              </Text>
                            ) : null}
                            {dec.rawMaterialDateStr ? (
                              <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                                Nhập NL: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{dec.rawMaterialDateStr}</Text>
                              </Text>
                            ) : null}
                          </View>

                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                              Người gửi: <Text style={{ color: '#cbd5e1' }}>{item.created_by_name || 'Kho'}</Text>
                            </Text>
                            {item.pallet_notes ? (
                              <Text style={{ color: '#94a3b8', fontSize: 11 }} numberOfLines={1}>
                                Ghi chú: <Text style={{ color: '#cbd5e1' }}>{item.pallet_notes}</Text>
                              </Text>
                            ) : null}
                          </View>
                        </View>
                      </View>

                      <View style={[styles.palletCardFooter, { backgroundColor: 'rgba(88, 28, 135, 0.2)' }]}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                          <Ionicons name="time" size={14} color="#a855f7" />
                          <Text style={{ color: '#c084fc', fontSize: 11, fontWeight: '700' }}>
                            Chờ server duyệt tạo Lot
                          </Text>
                        </View>
                        <Text style={{ color: '#64748b', fontSize: 10 }}>
                          {item.created_at?.slice(0, 16).replace('T', ' ')}
                        </Text>
                      </View>
                    </View>
                  );
                }

                // Pallet ghép nhiều đợt con dấu
                return (
                  <View key={group.key} style={[styles.palletCard, { borderColor: '#a855f7', borderWidth: 1.5 }]}>
                    <View style={styles.palletCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap', gap: 6 }}>
                        <Ionicons name="cube" size={18} color="#c084fc" />
                        <Text style={[styles.palletCode, { color: '#e9d5ff' }]}>STT: {group.pallet_stt}</Text>
                        {group.pallet_tag ? (
                          <View style={styles.tagBadge}>
                            <Text style={styles.tagBadgeText}>🏷️ {group.pallet_tag}</Text>
                          </View>
                        ) : null}
                        <View style={[styles.tagBadge, { backgroundColor: '#581c87', borderColor: '#a855f7', borderWidth: 1 }]}>
                          <Text style={[styles.tagBadgeText, { color: '#f3e8ff' }]}>
                            📦 Ghép {group.items.length} đợt con dấu
                          </Text>
                        </View>
                      </View>
                      <Text style={{ color: '#22c55e', fontSize: 13, fontWeight: '900' }}>
                        Tổng: {group.total_boxes} thùng
                      </Text>
                    </View>

                    <View style={[styles.palletCardBody, { gap: 10 }]}>
                      {group.items.map((sub, sIdx) => {
                        const dec = sub.decoded_json || {};
                        const prodTitle = dec.productTitle || dec.special12Name || 'Sản phẩm con dấu';
                        const imgSrc = getDirectDriveImage(sub.image_url, sub.cropped_image_url, sub.drive_file_id);
                        const fullImgSrc = getFullStampImage(sub.image_url, sub.cropped_image_url, sub.drive_file_id) || imgSrc;

                        return (
                          <View
                            key={sub.id || sIdx}
                            style={{
                              backgroundColor: 'rgba(15, 23, 42, 0.7)',
                              borderRadius: 8,
                              padding: 10,
                              borderWidth: 1,
                              borderColor: '#334155',
                              gap: 6
                            }}
                          >
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                              <Text style={{ color: '#c084fc', fontSize: 11, fontWeight: 'bold' }}>
                                Đợt {sIdx + 1}
                              </Text>
                              <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>
                                {sub.box_count} thùng • {sub.box_weight} Kg
                              </Text>
                            </View>

                            <View style={{ flexDirection: 'row', gap: 10 }}>
                              {imgSrc ? (
                                <TouchableOpacity
                                  activeOpacity={0.8}
                                  onPress={() => openPreviewImage(fullImgSrc || imgSrc, `STT: ${group.pallet_stt} (Đợt ${sIdx + 1})`)}
                                  style={{
                                    width: 56,
                                    height: 56,
                                    borderRadius: 6,
                                    overflow: 'hidden',
                                    backgroundColor: '#1e293b',
                                    borderWidth: 1,
                                    borderColor: '#9333ea',
                                    alignSelf: 'flex-start'
                                  }}
                                >
                                  <Image source={{ uri: imgSrc }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                                </TouchableOpacity>
                              ) : null}

                              <View style={{ flex: 1, justifyContent: 'center' }}>
                                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', lineHeight: 16 }} numberOfLines={2}>
                                  {prodTitle}
                                </Text>
                                {(sub.stamp_line1 || sub.stamp_line2) ? (
                                  <Text style={{ color: '#94a3b8', fontSize: 10, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                                    L1: <Text style={{ color: '#38bdf8', fontWeight: 'bold' }}>{sub.stamp_line1 || '---'}</Text> • L2: <Text style={{ color: '#a78bfa', fontWeight: 'bold' }}>{sub.stamp_line2 || '---'}</Text>
                                  </Text>
                                ) : null}
                              </View>
                            </View>

                            {/* Thông tin quét đợt này */}
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
                              {dec.provinceName ? (
                                <Text style={{ color: '#94a3b8', fontSize: 10 }}>
                                  Vùng: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{dec.provinceName}</Text>
                                </Text>
                              ) : null}
                              {dec.packagingDateStr ? (
                                <Text style={{ color: '#94a3b8', fontSize: 10 }}>
                                  Đóng gói: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{dec.packagingDateStr}</Text>
                                </Text>
                              ) : null}
                              {dec.rawMaterialDateStr ? (
                                <Text style={{ color: '#94a3b8', fontSize: 10 }}>
                                  Nhập NL: <Text style={{ color: '#f1f5f9', fontWeight: 'bold' }}>{dec.rawMaterialDateStr}</Text>
                                </Text>
                              ) : null}
                            </View>
                          </View>
                        );
                      })}

                      {/* Hàng dưới cùng của thẻ gom: Người gửi */}
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
                        <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                          Người gửi: <Text style={{ color: '#cbd5e1' }}>{group.created_by_name || 'Kho'}</Text>
                        </Text>
                        {group.pallet_notes ? (
                          <Text style={{ color: '#94a3b8', fontSize: 11 }} numberOfLines={1}>
                            Ghi chú: <Text style={{ color: '#cbd5e1' }}>{group.pallet_notes}</Text>
                          </Text>
                        ) : null}
                      </View>
                    </View>

                    <View style={[styles.palletCardFooter, { backgroundColor: 'rgba(88, 28, 135, 0.2)' }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <Ionicons name="time" size={14} color="#a855f7" />
                        <Text style={{ color: '#c084fc', fontSize: 11, fontWeight: '700' }}>
                          Chờ server duyệt tạo Lot
                        </Text>
                      </View>
                      <Text style={{ color: '#64748b', fontSize: 10 }}>
                        {group.created_at?.slice(0, 16).replace('T', ' ')}
                      </Text>
                    </View>
                  </View>
                );
              }}
            />
          )}
        </View>
      )}

      {/* ── TAB 4: ĐÃ DUYỆT (ĐỒNG BỘ VỚI WEB MẸ & KHÔNG ĐƯỢC XÓA) ───────────── */}
      {activeTab === 'cloud' && (
        <View style={{ flex: 1 }}>
          {/* Offline Status & Quick Sync Bar */}
          <View style={[styles.offlineStatusBar, isOfflineMode && styles.offlineStatusBarActive]}>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons
                name={isOfflineMode ? "cloud-offline" : "cloud-done"}
                size={18}
                color={isOfflineMode ? "#f59e0b" : "#10b981"}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.offlineStatusText} numberOfLines={1}>
                  {isOfflineMode ? 'Chế độ xem ngoại tuyến (Offline)' : 'Dữ liệu trực tuyến'}
                </Text>
                {lastSyncTimeText ? (
                  <Text style={styles.offlineStatusSub} numberOfLines={1}>
                    Đã tải: {lastSyncTimeText}
                  </Text>
                ) : (
                  <Text style={styles.offlineStatusSub} numberOfLines={1}>
                    Chưa tải dữ liệu ngoại tuyến
                  </Text>
                )}
              </View>
            </View>

            <TouchableOpacity
              style={styles.offlineSyncBtn}
              onPress={handleSyncOffline}
              disabled={isSyncingOffline}
            >
              {isSyncingOffline ? (
                <ActivityIndicator size="small" color="#38bdf8" />
              ) : (
                <>
                  <Ionicons name="cloud-download-outline" size={15} color="#38bdf8" />
                  <Text style={styles.offlineSyncBtnText}>Tải về máy</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Search bar + Bộ lọc Nâng cao */}
          <View style={styles.searchFilterRow}>
            <View style={styles.searchContainer}>
              <Ionicons name="search" size={18} color="#94a3b8" style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                placeholder="Tìm STT, LOT, SP, gõ tắt (VD: dncv, ri6)..."
                placeholderTextColor="#64748b"
                value={cloudSearchQuery}
                onChangeText={text => {
                  setCloudSearchQuery(text);
                  setCloudCurrentPage(1);
                  setShowSearchSuggestions(true);
                }}
                onFocus={() => setShowSearchSuggestions(true)}
                autoCapitalize="none"
              />
              {cloudSearchQuery.length > 0 && (
                <TouchableOpacity onPress={() => {
                  setCloudSearchQuery('');
                  setCloudCurrentPage(1);
                  setShowSearchSuggestions(false);
                }}>
                  <Ionicons name="close-circle" size={18} color="#94a3b8" />
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity
              style={[
                styles.filterToggleBtn,
                activeFilterCount > 0 && styles.filterToggleBtnActive
              ]}
              onPress={openFilterModal}
            >
              <Ionicons
                name={activeFilterCount > 0 ? "funnel" : "funnel-outline"}
                size={18}
                color={activeFilterCount > 0 ? "#fff" : "#38bdf8"}
              />
              {activeFilterCount > 0 && (
                <View style={styles.filterBadge}>
                  <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          {/* Hộp gợi ý sản phẩm khi gõ vào ô tìm kiếm chính */}
          {showSearchSuggestions && searchProductSuggestions.length > 0 && (
            <View style={styles.suggestionsContainer}>
              <View style={styles.suggestionsHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons name="search" size={13} color="#10b981" />
                  <Text style={styles.suggestionsHeaderText}>
                    Gợi ý tìm kiếm ({searchProductSuggestions.length})
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowSearchSuggestions(false)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close" size={16} color="#94a3b8" />
                </TouchableOpacity>
              </View>
              {searchProductSuggestions.map((item, idx) => (
                <TouchableOpacity
                  key={'main_sugg_' + item.product.id + '_' + idx}
                  style={styles.suggestionItem}
                  onPress={() => {
                    setCloudSearchQuery(item.fillValue);
                    setShowSearchSuggestions(false);
                    setCloudCurrentPage(1);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <Text style={styles.suggestionName} numberOfLines={1}>
                        {item.displayTitle}
                      </Text>
                      {Boolean(item.badgeText) && (
                        <View style={styles.aliasBadge}>
                          <Text style={styles.aliasBadgeText}>{item.badgeText}</Text>
                        </View>
                      )}
                    </View>
                    {Boolean(item.displaySubtitle) && (
                      <Text style={styles.suggestionMeta}>{item.displaySubtitle}</Text>
                    )}
                  </View>
                  <Ionicons name="return-down-back" size={16} color="#64748b" />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Active Filter Chips */}
          {hasActiveFilters && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.activeChipsContainer}
            >
              <TouchableOpacity
                style={styles.clearAllChip}
                onPress={clearAllFilters}
              >
                <Ionicons name="close-circle-outline" size={14} color="#fca5a5" />
                <Text style={styles.clearAllChipText}>Xóa lọc</Text>
              </TouchableOpacity>

              {filterCriteria.productName ? (
                <View style={styles.filterChip}>
                  <Text style={styles.filterChipLabel}>SP: <Text style={styles.filterChipValue}>{filterCriteria.productName}</Text></Text>
                  <TouchableOpacity onPress={() => removeSingleFilter('productName')}>
                    <Ionicons name="close" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              ) : null}

              {filterCriteria.productionPlace ? (
                <View style={styles.filterChip}>
                  <Text style={styles.filterChipLabel}>Nơi SX: <Text style={styles.filterChipValue}>{filterCriteria.productionPlace}</Text></Text>
                  <TouchableOpacity onPress={() => removeSingleFilter('productionPlace')}>
                    <Ionicons name="close" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              ) : null}

              {filterCriteria.materialZone ? (
                <View style={styles.filterChip}>
                  <Text style={styles.filterChipLabel}>Vùng NL: <Text style={styles.filterChipValue}>{filterCriteria.materialZone}</Text></Text>
                  <TouchableOpacity onPress={() => removeSingleFilter('materialZone')}>
                    <Ionicons name="close" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              ) : null}

              {filterCriteria.locationCode ? (
                <View style={styles.filterChip}>
                  <Text style={styles.filterChipLabel}>VT: <Text style={styles.filterChipValue}>{filterCriteria.locationCode}</Text></Text>
                  <TouchableOpacity onPress={() => removeSingleFilter('locationCode')}>
                    <Ionicons name="close" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              ) : null}

              {filterCriteria.packagingDate ? (
                <View style={styles.filterChip}>
                  <Text style={styles.filterChipLabel}>Đóng gói: <Text style={styles.filterChipValue}>{filterCriteria.packagingDate}</Text></Text>
                  <TouchableOpacity onPress={() => removeSingleFilter('packagingDate')}>
                    <Ionicons name="close" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              ) : null}

              {filterCriteria.productionDate ? (
                <View style={styles.filterChip}>
                  <Text style={styles.filterChipLabel}>NSX: <Text style={styles.filterChipValue}>{filterCriteria.productionDate}</Text></Text>
                  <TouchableOpacity onPress={() => removeSingleFilter('productionDate')}>
                    <Ionicons name="close" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              ) : null}

              {filterCriteria.statusFilter && filterCriteria.statusFilter !== 'all' ? (
                <View style={styles.filterChip}>
                  <Text style={styles.filterChipLabel}>
                    TT: <Text style={styles.filterChipValue}>
                      {filterCriteria.statusFilter === 'linked' ? 'Đã gắn LOT' : filterCriteria.statusFilter === 'unlinked' ? 'Chờ duyệt' : 'Đã xuất kho'}
                    </Text>
                  </Text>
                  <TouchableOpacity onPress={() => removeSingleFilter('statusFilter')}>
                    <Ionicons name="close" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              ) : null}
            </ScrollView>
          )}

          {/* Quick Info bar */}
          {!loadingCloud && filteredCloudPallets.length > 0 && (
            <View style={styles.cloudInfoBar}>
              <Text style={styles.cloudInfoBarText}>
                Tổng: <Text style={{ color: '#38bdf8', fontWeight: '800' }}>{filteredCloudPallets.length}</Text> LOT
                {totalCloudPages > 1 ? ` · Trang ${cloudCurrentPage}/${totalCloudPages} (50 LOT / trang)` : ''}
              </Text>
            </View>
          )}

          {loadingCloud ? (
            <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#38bdf8" />
          ) : filteredCloudPallets.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="cloud-offline-outline" size={54} color="#64748b" />
              <Text style={styles.emptyTitle}>
                {cloudSearchQuery || hasActiveFilters ? 'Không tìm thấy kết quả phù hợp' : 'Chưa có Pallet nào trên Server'}
              </Text>
              <Text style={styles.emptySub}>
                {cloudSearchQuery || hasActiveFilters
                  ? 'Vui lòng thử tìm từ khóa khác hoặc điều chỉnh lại các tiêu chí bộ lọc.'
                  : 'Dữ liệu Pallet/LOT từ Anywarehouse sẽ xuất hiện tại đây khi được tạo.'}
              </Text>
            </View>
          ) : (
            <FlatList
              ref={cloudFlatListRef}
              data={paginatedCloudPallets}
              keyExtractor={item => item.id}
              contentContainerStyle={{ padding: 16 }}
              renderItem={({ item }) => {
                return (
                  <TouchableOpacity
                    style={styles.palletCard}
                    onPress={() => handleOpenCloudDetail(item)}
                  >
                    <View style={styles.palletCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
                        <Ionicons name="cube" size={20} color="#38bdf8" style={{ marginRight: 8 }} />
                        <Text style={styles.palletCode}>{item.stt}</Text>
                        {item.tag ? (
                          <View style={styles.tagBadge}>
                            <Text style={styles.tagBadgeText}>🏷️ {item.tag}</Text>
                          </View>
                        ) : null}
                        {item.location_code ? (
                          <View style={styles.locationBadge}>
                            <Ionicons name="location" size={11} color="#f59e0b" style={{ marginRight: 2 }} />
                            <Text style={styles.locationBadgeText}>VT: {item.location_code}</Text>
                          </View>
                        ) : null}
                      </View>
                      {item.status === 'exported' ? (
                        <View style={[styles.syncBadge, { backgroundColor: '#451a03' }]}>
                          <Text style={[styles.syncBadgeText, { color: '#fb923c' }]}>
                            🚢 Đã xuất kho
                          </Text>
                        </View>
                      ) : (
                        <View style={[
                          styles.syncBadge,
                          { backgroundColor: item.is_linked ? '#064e3b' : '#7c2d12' }
                        ]}>
                          <Text style={[
                            styles.syncBadgeText,
                            { color: item.is_linked ? '#34d399' : '#fdba74' }
                          ]}>
                            {item.is_linked ? '✓ Đã gắn LOT' : '⏳ Chờ duyệt LOT'}
                          </Text>
                        </View>
                      )}
                    </View>

                    <View style={styles.palletCardBody}>
                      {item.lot_code ? (
                        <Text style={styles.cloudLotCode}>
                          Mã LOT Web: <Text style={{ color: '#38bdf8', fontWeight: '800' }}>{item.lot_code}</Text>
                        </Text>
                      ) : null}
                      {item.product_name ? (
                        <Text style={styles.cloudProductName} numberOfLines={2}>
                          {item.product_name}
                        </Text>
                      ) : null}
                      {item.product_aliases ? (
                        <Text style={styles.cloudAliasesText} numberOfLines={1}>
                          🏷️ Gõ tắt: <Text style={styles.cloudAliasesHighlight}>{item.product_aliases}</Text>
                        </Text>
                      ) : null}

                      {/* Vị trí lưu kho */}
                      {item.location_code ? (
                        <View style={styles.cloudLocationRow}>
                          <Ionicons name="location" size={13} color="#f59e0b" />
                          <Text style={styles.cloudLocationLabel}>Vị trí kho: </Text>
                          <Text style={styles.cloudLocationValue}>{item.location_code}</Text>
                        </View>
                      ) : (
                        item.is_linked ? (
                          <View style={styles.cloudLocationRow}>
                            <Ionicons name="location-outline" size={13} color="#64748b" />
                            <Text style={styles.cloudLocationUnassigned}>Chưa gắn vị trí kho</Text>
                          </View>
                        ) : null
                      )}

                      {/* Origin & Material Zone */}
                      {(item.production_place || item.material_zone) ? (
                        <View style={styles.cloudOriginRow}>
                          {item.production_place ? (
                            <View style={styles.originTag}>
                              <Ionicons name="business-outline" size={12} color="#38bdf8" />
                              <Text style={styles.originTagText} numberOfLines={1}>
                                {item.production_place}
                              </Text>
                            </View>
                          ) : null}
                          {item.material_zone ? (
                            <View style={styles.originTag}>
                              <Ionicons name="location-outline" size={12} color="#fbbf24" />
                              <Text style={styles.originTagText} numberOfLines={1}>
                                {item.material_zone}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      ) : null}

                      {/* Badge nếu là ngoại lệ 12 số */}
                      {item.is_special_12 && (
                        <View style={{ alignSelf: 'flex-start', backgroundColor: '#064e3b', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#059669', marginBottom: 6 }}>
                          <Text style={{ color: '#34d399', fontSize: 10, fontWeight: '800' }}>⭐ 12 SỐ ĐẦU TRỌN GÓI</Text>
                        </View>
                      )}

                      {/* Packaging date & Production date / Raw material date */}
                      {(item.packaging_date || item.production_date) ? (
                        <View style={styles.cloudDateRow}>
                          {item.packaging_date ? (
                            <Text style={styles.cloudDateText}>
                              📦 Đóng gói: <Text style={styles.cloudDateHighlight}>{item.packaging_date}</Text>
                            </Text>
                          ) : null}
                          {item.production_date ? (
                            <Text style={styles.cloudDateText}>
                              {item.scan_type === 'stamp' ? '📅 Nhập NL: ' : '📅 NSX: '}
                              <Text style={styles.cloudDateHighlight}>{item.production_date}</Text>
                            </Text>
                          ) : null}
                        </View>
                      ) : null}

                      <Text style={styles.palletMeta}>
                        Số lượng: <Text style={{ color: '#22c55e', fontWeight: '900' }}>{item.boxes_count}</Text> thùng
                        {'  ·  '}
                        Tổng khối lượng: <Text style={{ color: '#38bdf8', fontWeight: '900' }}>{item.total_weight}</Text> Kg
                      </Text>
                      {item.notes ? (
                        <Text style={styles.palletNotesText} numberOfLines={2}>
                          📝 {item.notes}
                        </Text>
                      ) : null}
                      <Text style={styles.palletDate}>
                        Ngày tạo: {item.created_at.slice(0, 16).replace('T', ' ')}
                      </Text>
                    </View>

                    {/* TUYỆT ĐỐI KHÔNG CÓ NÚT XÓA Ở TAB NÀY */}
                    <View style={styles.palletCardFooter}>
                      <TouchableOpacity
                        style={[styles.viewDetailBtn, { flex: 1, justifyContent: 'center' }]}
                        onPress={() => handleOpenCloudDetail(item)}
                      >
                        <Ionicons name="eye-outline" size={16} color="#cbd5e1" />
                        <Text style={styles.viewDetailText}>Xem chi tiết</Text>
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}

          {/* Pagination Bottom Bar */}
          {!loadingCloud && totalCloudPages > 1 && (
            <View style={styles.paginationBar}>
              <TouchableOpacity
                style={[styles.pageBtn, cloudCurrentPage <= 1 && styles.pageBtnDisabled]}
                disabled={cloudCurrentPage <= 1}
                onPress={() => goToCloudPage(cloudCurrentPage - 1)}
              >
                <Ionicons name="chevron-back" size={16} color={cloudCurrentPage <= 1 ? '#475569' : '#38bdf8'} />
                <Text style={[styles.pageBtnText, cloudCurrentPage <= 1 && styles.pageBtnTextDisabled]}>Trước</Text>
              </TouchableOpacity>

              <View style={styles.pageInfoBadge}>
                <Text style={styles.pageInfoText}>
                  Trang <Text style={styles.pageInfoHighlight}>{cloudCurrentPage}</Text> / {totalCloudPages}
                </Text>
                <Text style={styles.pageTotalItemsText}>
                  (50 LOT / trang)
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.pageBtn, cloudCurrentPage >= totalCloudPages && styles.pageBtnDisabled]}
                disabled={cloudCurrentPage >= totalCloudPages}
                onPress={() => goToCloudPage(cloudCurrentPage + 1)}
              >
                <Text style={[styles.pageBtnText, cloudCurrentPage >= totalCloudPages && styles.pageBtnTextDisabled]}>Sau</Text>
                <Ionicons name="chevron-forward" size={16} color={cloudCurrentPage >= totalCloudPages ? '#475569' : '#38bdf8'} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* ── MODAL CHI TIẾT PALLET ─────────────────── */}
      <Modal visible={!!selectedPallet || !!selectedCloudPallet} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Chi tiết Pallet: {modalTitle}</Text>
                {modalTag ? (
                  <Text style={{ color: '#ea580c', fontSize: 12, fontWeight: '700', marginTop: 2 }}>
                    🏷️ Mã phụ: {modalTag}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={() => { setSelectedPallet(null); setSelectedCloudPallet(null); }}>
                <Ionicons name="close" size={24} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {isViewingReadOnly ? (
              <View style={styles.readOnlyBanner}>
                <Ionicons name="lock-closed" size={14} color="#34d399" />
                <Text style={styles.readOnlyBannerText}>
                  Dữ liệu đã lên Server an toàn (Không thể xóa/sửa từ app)
                </Text>
              </View>
            ) : null}

            <Text style={styles.modalSub}>
              Tổng cộng {selectedBoxes.length} thùng · {modalWeight} Kg
            </Text>

            {selectedCloudPallet?.location_code ? (
              <View style={styles.modalLocationBanner}>
                <Ionicons name="location" size={15} color="#f59e0b" />
                <Text style={styles.modalLocationBannerText}>
                  Vị trí kho: <Text style={{ color: '#fbbf24', fontWeight: '900' }}>{selectedCloudPallet.location_code}</Text>
                </Text>
              </View>
            ) : null}

            {isLoadingBoxes ? (
              <ActivityIndicator style={{ marginVertical: 30 }} color="#38bdf8" />
            ) : selectedBoxes.length === 0 ? (
              <View style={{ paddingVertical: 30, alignItems: 'center' }}>
                <Text style={{ color: '#94a3b8', fontSize: 13 }}>Pallet này chưa có thùng hàng nào.</Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 400, marginTop: 10 }}>
                {selectedBoxes.map((b) => (
                  <View key={b.id} style={styles.boxCardItem}>
                    {/* Header Row: Index + SKU + Weight */}
                    <View style={styles.boxCardHeader}>
                      <View style={styles.boxIndexTag}>
                        <Text style={styles.boxIndexTagText}>#{b.box_index}</Text>
                      </View>
                      <Text style={styles.boxSkuTag}>SKU: {b.sku}</Text>
                      <View style={styles.boxWeightTag}>
                        <Text style={styles.boxWeightTagText}>{b.weight} {b.unit}</Text>
                      </View>
                      {!isViewingReadOnly && (
                        <>
                          <TouchableOpacity
                            style={styles.cloneBoxBtn}
                            onPress={() => handleCloneBox(b)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Ionicons name="copy-outline" size={16} color="#38bdf8" />
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.deleteBoxBtn}
                            onPress={() => handleDeleteBox(b)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Ionicons name="trash-outline" size={16} color="#ef4444" />
                          </TouchableOpacity>
                        </>
                      )}
                    </View>

                    {/* Badge Dấu đóng mực & Ngoại lệ 12 số */}
                    {(() => {
                      const isStamp = b.scan_type === 'stamp' || !!b.stamp_line1 || !!b.stamp_line2;
                      return isStamp ? (
                        <View style={{ marginBottom: 6, marginTop: 4 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <View style={{ backgroundColor: '#451a03', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#d97706' }}>
                              <Text style={{ color: '#fbbf24', fontSize: 10, fontWeight: '800' }}>📦 DẤU ĐÓNG MỰC</Text>
                            </View>
                            {b.is_special_12 && (
                              <View style={{ backgroundColor: '#064e3b', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#059669' }}>
                                <Text style={{ color: '#34d399', fontSize: 10, fontWeight: '800' }}>⭐ 12 SỐ ĐẦU TRỌN GÓI</Text>
                              </View>
                            )}
                          </View>
                          {b.is_special_12 && (
                            <Text style={{ color: '#6ee7b7', fontSize: 10, marginTop: 4, lineHeight: 14 }}>
                              ✓ Khớp quy cách ngoại lệ trọn gói. Đã ẩn phân đoạn 14 số chuẩn để không làm sai lệch thông số đóng gói.
                            </Text>
                          )}
                        </View>
                      ) : null;
                    })()}

                    {/* Product Name Full */}
                    <Text style={styles.boxFullTitle}>{b.product_name}</Text>

                    {/* Complete Grid of Details: Adaptive for Stamp vs Label */}
                    {(() => {
                      const isStamp = b.scan_type === 'stamp' || !!b.stamp_line1 || !!b.stamp_line2;
                      if (isStamp) {
                        return (
                          <View style={styles.boxMetaGrid}>
                            <Text style={styles.boxMetaCell}>
                              <Text style={styles.metaDim}>Mã LOT (Dòng 2):</Text> {b.lot_code}
                            </Text>
                            <Text style={styles.boxMetaCell}>
                              <Text style={styles.metaDim}>Quy cách:</Text> {b.spec || (b.is_special_12 ? 'Ngoại lệ trọn gói' : 'Thùng tiêu chuẩn')}
                            </Text>
                            <Text style={styles.boxMetaCell}>
                              <Text style={styles.metaDim}>Nhà máy:</Text> {b.shift_group || 'Nhà máy Đắk Lắk'}
                            </Text>
                            <Text style={styles.boxMetaCell}>
                              <Text style={styles.metaDim}>Vùng NL (Tỉnh):</Text> {b.region || 'Đắk Lắk'}
                            </Text>
                            <Text style={styles.boxMetaCell}>
                              <Text style={styles.metaDim}>Ngày nhập NL:</Text> {b.raw_material_date || b.production_date || '---'}
                            </Text>
                            <Text style={styles.boxMetaCell}>
                              <Text style={styles.metaDim}>Ngày ĐG:</Text> {b.packaging_date || '---'}
                            </Text>
                            <Text style={[styles.boxMetaCell, { width: '100%' }]}>
                              <Text style={styles.metaDim}>Nhà cung cấp:</Text> {b.supplier_name || (b.supplier ? `Mã NCC ${b.supplier}` : 'Mã NCC 000')}
                            </Text>
                          </View>
                        );
                      }

                      return (
                        <View style={styles.boxMetaGrid}>
                          <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Mã LOT:</Text> {b.lot_code}</Text>
                          <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Quy cách:</Text> {b.spec || 'Thùng/túi: 20kg'}</Text>
                          <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Tổ/Nhóm:</Text> {b.shift_group || 'Nguyên'}</Text>
                          <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Vùng NL:</Text> {b.region || 'Tây Nguyên'}</Text>
                          <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Ngày SX:</Text> {b.production_date}</Text>
                          <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Ngày ĐG:</Text> {b.packaging_date || b.production_date}</Text>
                        </View>
                      );
                    })()}
                  </View>
                ))}
              </ScrollView>
            )}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              {selectedPallet && selectedPallet.sync_status !== 'synced' && (
                <TouchableOpacity
                  style={[styles.moveToDecodeBtn, { flex: 1, justifyContent: 'center', paddingVertical: 11 }]}
                  onPress={() => handleMoveToDecode(selectedPallet)}
                >
                  <Ionicons name="scan-outline" size={16} color="#fdba74" />
                  <Text style={[styles.moveToDecodeText, { fontSize: 13 }]}>Chuyển sang Chờ giải mã</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.closeDetailBtn, selectedPallet && selectedPallet.sync_status !== 'synced' ? { width: 90, marginTop: 0 } : {}]}
                onPress={() => { setSelectedPallet(null); setSelectedCloudPallet(null); }}
              >
                <Text style={styles.closeDetailText}>Đóng</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── MODAL BỘ LỌC NÂNG CAO CHO LOT TRÊN CLOUD ───────────────── */}
      <Modal visible={isFilterModalOpen} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { maxHeight: '88%' }]}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="options-outline" size={22} color="#38bdf8" />
                <Text style={styles.modalTitle}>Bộ lọc tìm kiếm LOT</Text>
              </View>
              <TouchableOpacity onPress={() => setIsFilterModalOpen(false)}>
                <Ionicons name="close" size={24} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
              {/* Field 1: Sản phẩm / SKU / Tên viết tắt */}
              <View style={styles.filterFormField}>
                <Text style={styles.filterFormLabel}>🥭 Sản phẩm, SKU hoặc Tên gõ tắt / viết tắt</Text>
                <TextInput
                  style={styles.filterFormInput}
                  placeholder="VD: Monthong, Ri6, dncv, dona c, srmc..."
                  placeholderTextColor="#64748b"
                  value={draftFilter.productName || ''}
                  onChangeText={txt => {
                    setDraftFilter(prev => ({ ...prev, productName: txt }));
                    setShowModalProductSuggestions(true);
                  }}
                  onFocus={() => setShowModalProductSuggestions(true)}
                />
                {showModalProductSuggestions && modalProductSuggestions.length > 0 && (
                  <View style={styles.modalSuggestionsContainer}>
                    <View style={styles.suggestionsHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="search" size={13} color="#10b981" />
                        <Text style={styles.suggestionsHeaderText}>Gợi ý tìm kiếm ({modalProductSuggestions.length})</Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => setShowModalProductSuggestions(false)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close" size={16} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>
                    {modalProductSuggestions.map((item, idx) => (
                      <TouchableOpacity
                        key={'modal_sugg_' + item.product.id + '_' + idx}
                        style={styles.suggestionItem}
                        onPress={() => {
                          setDraftFilter(prev => ({ ...prev, productName: item.fillValue }));
                          setShowModalProductSuggestions(false);
                        }}
                        activeOpacity={0.7}
                      >
                        <View style={{ flex: 1, marginRight: 8 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                            <Text style={styles.suggestionName} numberOfLines={1}>
                              {item.displayTitle}
                            </Text>
                            {Boolean(item.badgeText) && (
                              <View style={styles.aliasBadge}>
                                <Text style={styles.aliasBadgeText}>{item.badgeText}</Text>
                              </View>
                            )}
                          </View>
                          {Boolean(item.displaySubtitle) && (
                            <Text style={styles.suggestionMeta}>{item.displaySubtitle}</Text>
                          )}
                        </View>
                        <Ionicons name="return-down-back" size={16} color="#64748b" />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Field 2: Nơi sản xuất / Nhà máy */}
              <View style={styles.filterFormField}>
                <Text style={styles.filterFormLabel}>🏭 Nơi sản xuất / Nhà máy</Text>
                <TextInput
                  style={styles.filterFormInput}
                  placeholder="VD: Đắk Lắk, Tiền Giang, Chi nhánh 2..."
                  placeholderTextColor="#64748b"
                  value={draftFilter.productionPlace || ''}
                  onChangeText={txt => setDraftFilter(prev => ({ ...prev, productionPlace: txt }))}
                />
              </View>

              {/* Field 3: Vùng nguyên liệu */}
              <View style={styles.filterFormField}>
                <Text style={styles.filterFormLabel}>📍 Vùng nguyên liệu</Text>
                <TextInput
                  style={styles.filterFormInput}
                  placeholder="VD: Lâm Đồng, Đắk Lắk, Tiền Giang..."
                  placeholderTextColor="#64748b"
                  value={draftFilter.materialZone || ''}
                  onChangeText={txt => setDraftFilter(prev => ({ ...prev, materialZone: txt }))}
                />
              </View>

              {/* Field: Vị trí lưu kho */}
              <View style={styles.filterFormField}>
                <Text style={styles.filterFormLabel}>🏢 Vị trí lưu kho (Kệ / Ô / Dãy)</Text>
                <TextInput
                  style={styles.filterFormInput}
                  placeholder="VD: A-01, B-02, KHO-LẠNH..."
                  placeholderTextColor="#64748b"
                  value={draftFilter.locationCode || ''}
                  onChangeText={txt => setDraftFilter(prev => ({ ...prev, locationCode: txt }))}
                />
              </View>

              {/* Field 4 & 5: Ngày đóng gói & Ngày sản xuất */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={[styles.filterFormField, { flex: 1 }]}>
                  <Text style={styles.filterFormLabel}>📦 Ngày đóng gói</Text>
                  <TouchableOpacity
                    style={styles.datePickerTrigger}
                    onPress={() => openCalendarPicker('packagingDate')}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="calendar-outline" size={16} color="#38bdf8" />
                    <Text
                      style={[
                        styles.datePickerTriggerText,
                        !draftFilter.packagingDate && styles.datePickerPlaceholderText
                      ]}
                      numberOfLines={1}
                    >
                      {draftFilter.packagingDate || 'Chọn ngày...'}
                    </Text>
                    {Boolean(draftFilter.packagingDate) && (
                      <TouchableOpacity
                        onPress={() => {
                          setDraftFilter(prev => ({ ...prev, packagingDate: undefined }));
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close-circle" size={16} color="#94a3b8" />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                </View>

                <View style={[styles.filterFormField, { flex: 1 }]}>
                  <Text style={styles.filterFormLabel}>📅 Ngày sản xuất</Text>
                  <TouchableOpacity
                    style={styles.datePickerTrigger}
                    onPress={() => openCalendarPicker('productionDate')}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="calendar-outline" size={16} color="#38bdf8" />
                    <Text
                      style={[
                        styles.datePickerTriggerText,
                        !draftFilter.productionDate && styles.datePickerPlaceholderText
                      ]}
                      numberOfLines={1}
                    >
                      {draftFilter.productionDate || 'Chọn ngày...'}
                    </Text>
                    {Boolean(draftFilter.productionDate) && (
                      <TouchableOpacity
                        onPress={() => {
                          setDraftFilter(prev => ({ ...prev, productionDate: undefined }));
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close-circle" size={16} color="#94a3b8" />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                </View>
              </View>

              {/* Field 6: Trạng thái liên kết LOT */}
              <View style={styles.filterFormField}>
                <Text style={styles.filterFormLabel}>🏷️ Trạng thái LOT</Text>
                <View style={styles.statusChipRow}>
                  {[
                    { id: 'all', label: 'Tất cả' },
                    { id: 'linked', label: '✓ Đã gắn LOT' },
                    { id: 'unlinked', label: '⏳ Chờ duyệt' },
                    { id: 'exported', label: '🚢 Đã xuất kho' },
                  ].map(item => {
                    const active = (draftFilter.statusFilter || 'all') === item.id;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.statusChipBtn, active && styles.statusChipBtnActive]}
                        onPress={() => setDraftFilter(prev => ({ ...prev, statusFilter: item.id as any }))}
                      >
                        <Text style={[styles.statusChipBtnText, active && styles.statusChipBtnTextActive]}>
                          {item.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </ScrollView>

            {/* Bottom Actions */}
            <View style={styles.filterActionsRow}>
              <TouchableOpacity
                style={styles.filterResetBtn}
                onPress={resetDraftFilter}
              >
                <Ionicons name="refresh-outline" size={16} color="#cbd5e1" />
                <Text style={styles.filterResetBtnText}>Thiết lập lại</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.filterApplyBtn}
                onPress={applyDraftFilter}
              >
                <Ionicons name="checkmark-circle" size={18} color="#fff" />
                <Text style={styles.filterApplyBtnText}>Áp dụng bộ lọc</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── MODAL LỊCH CHỌN NGÀY (CALENDAR PICKER) ─────────────────── */}
      <Modal visible={calendarTargetField !== null} transparent animationType="fade">
        <View style={styles.calendarModalOverlay}>
          <View style={styles.calendarModalCard}>
            {/* Header */}
            <View style={styles.calendarHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="calendar" size={18} color="#38bdf8" />
                <Text style={styles.calendarTitle}>
                  {calendarTargetField === 'packagingDate' ? 'Chọn ngày đóng gói' : 'Chọn ngày sản xuất'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setCalendarTargetField(null)}>
                <Ionicons name="close" size={22} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {/* Chuyển tháng / năm */}
            <View style={styles.monthSwitcherRow}>
              <TouchableOpacity style={styles.monthNavBtn} onPress={handlePrevMonth}>
                <Ionicons name="chevron-back" size={20} color="#38bdf8" />
              </TouchableOpacity>
              <Text style={styles.monthYearTitle}>
                Tháng {calendarMonth + 1} / {calendarYear}
              </Text>
              <TouchableOpacity style={styles.monthNavBtn} onPress={handleNextMonth}>
                <Ionicons name="chevron-forward" size={20} color="#38bdf8" />
              </TouchableOpacity>
            </View>

            {/* Tiêu đề các thứ trong tuần */}
            <View style={styles.weekDaysRow}>
              {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((w, idx) => (
                <Text key={w} style={[styles.weekDayText, idx >= 5 && { color: '#f87171' }]}>
                  {w}
                </Text>
              ))}
            </View>

            {/* Lưới các ngày trong tháng */}
            <View style={styles.calendarGrid}>
              {calendarDaysData.map((day, idx) => {
                if (day === null) {
                  return <View key={'empty_' + idx} style={styles.calendarDayCell} />;
                }

                const mStr = String(calendarMonth + 1).padStart(2, '0');
                const dStr = String(day).padStart(2, '0');
                const dayDateStr = `${calendarYear}-${mStr}-${dStr}`;

                const isSelected = Boolean(
                  calendarTargetField &&
                  draftFilter[calendarTargetField] &&
                  (draftFilter[calendarTargetField] === dayDateStr ||
                   draftFilter[calendarTargetField] === `${dStr}/${mStr}/${calendarYear}`)
                );

                const now = new Date();
                const isToday =
                  now.getFullYear() === calendarYear &&
                  now.getMonth() === calendarMonth &&
                  now.getDate() === day;

                return (
                  <TouchableOpacity
                    key={'day_' + day}
                    style={[
                      styles.calendarDayCell,
                      isSelected && styles.calendarDayCellSelected,
                      isToday && !isSelected && styles.calendarDayCellToday,
                    ]}
                    onPress={() => handleSelectDay(day)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.calendarDayText,
                        isSelected && styles.calendarDayTextSelected,
                        isToday && !isSelected && styles.calendarDayTextToday,
                      ]}
                    >
                      {day}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Phím tắt chọn nhanh */}
            <View style={styles.quickDateRow}>
              <TouchableOpacity
                style={styles.quickDateBtn}
                onPress={() => handleQuickDate('today')}
              >
                <Text style={styles.quickDateBtnText}>Hôm nay</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.quickDateBtn}
                onPress={() => handleQuickDate('yesterday')}
              >
                <Text style={styles.quickDateBtnText}>Hôm qua</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.quickDateBtn, { backgroundColor: 'rgba(239, 68, 68, 0.15)' }]}
                onPress={() => handleQuickDate('clear')}
              >
                <Text style={[styles.quickDateBtnText, { color: '#f87171' }]}>Xóa ngày</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── MODAL XEM ẢNH CON DẤU PHÓNG TO TOÀN MÀN HÌNH ───────────────── */}
      <Modal
        visible={Boolean(previewModalImageUri)}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewModalImageUri(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setPreviewModalImageUri(null)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.95)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
          }}
        >
          <View style={{
            position: 'absolute',
            top: Platform.OS === 'ios' ? 52 : 36,
            left: 20,
            right: 20,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            zIndex: 10
          }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>
              🔍 {previewModalTitle || 'Ảnh con dấu'}
            </Text>
            <TouchableOpacity
              onPress={() => setPreviewModalImageUri(null)}
              style={{
                padding: 8,
                backgroundColor: 'rgba(255,255,255,0.25)',
                borderRadius: 24,
              }}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>

          {previewModalImageUri ? (
            <Image
              source={{ uri: previewModalImageUri }}
              style={{ width: '100%', height: '78%', borderRadius: 12 }}
              resizeMode="contain"
            />
          ) : null}

          <Text style={{ color: '#94a3b8', fontSize: 13, marginTop: 16, fontWeight: '600' }}>
            Chạm vào bất kỳ đâu để đóng
          </Text>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  topBarTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '900',
  },
  connectionBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  connectionText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
  },
  pingBtnText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },

  /* ── Tab Switcher ── */
  tabContainer: {
    backgroundColor: '#1e293b',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  tabScrollContent: {
    paddingHorizontal: 10,
    gap: 8,
  },
  tabButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    gap: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  tabButtonActive: {
    backgroundColor: '#1e3a8a',
    borderColor: '#38bdf8',
  },
  tabButtonActivePending: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: '#f59e0b',
  },
  tabButtonActiveStampPending: {
    backgroundColor: 'rgba(249, 115, 22, 0.18)',
    borderColor: '#f97316',
  },
  tabButtonActiveStampDecoded: {
    backgroundColor: 'rgba(168, 85, 247, 0.18)',
    borderColor: '#c084fc',
  },
  tabButtonActiveCloud: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderColor: '#34d399',
  },
  tabButtonText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  tabButtonTextActive: {
    color: '#38bdf8',
    fontWeight: '900',
  },
  tabTextPendingActive: {
    color: '#fbbf24',
    fontWeight: '900',
  },
  tabTextStampPendingActive: {
    color: '#fb923c',
    fontWeight: '900',
  },
  tabTextStampDecodedActive: {
    color: '#d8b4fe',
    fontWeight: '900',
  },
  tabTextCloudActive: {
    color: '#4ade80',
    fontWeight: '900',
  },

  /* ── Search Container (Tab 2) ── */
  searchFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    gap: 8,
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  filterToggleBtn: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  filterToggleBtnActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  filterBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#ef4444',
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#0f172a',
  },
  filterBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
  },
  searchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    padding: 0,
  },

  syncAllCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e3a8a',
    margin: 16,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  syncAllTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  syncAllSub: {
    color: '#93c5fd',
    fontSize: 11,
    marginTop: 2,
  },
  syncAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  syncAllBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },

  palletCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  palletCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  palletCode: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '900',
  },
  tagBadge: {
    backgroundColor: '#ea580c',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 8,
  },
  tagBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },
  syncBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  syncBadgeText: {
    fontSize: 11,
    fontWeight: '800',
  },
  palletCardBody: {
    marginTop: 10,
    gap: 4,
  },
  cloudLotCode: {
    color: '#94a3b8',
    fontSize: 12,
  },
  cloudProductName: {
    color: '#f1f5f9',
    fontSize: 13,
    fontWeight: '700',
    marginVertical: 2,
  },
  palletMeta: {
    color: '#cbd5e1',
    fontSize: 13,
  },
  palletNotesText: {
    color: '#facc15',
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 2,
  },
  palletDate: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 4,
  },
  palletCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },

  pullBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#0c4a6e',
  },
  pullBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 4,
  },
  viewDetailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#334155',
    gap: 4,
  },
  viewDetailText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 6,
  },
  deleteBtnText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '700',
  },
  moveToDecodeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#7c2d12',
    borderWidth: 1,
    borderColor: '#ea580c',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  moveToDecodeText: {
    color: '#fdba74',
    fontSize: 12,
    fontWeight: '800',
  },
  syncSingleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2563eb',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 6,
  },
  syncSingleText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },

  emptyContainer: {
    padding: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 30,
  },
  emptyTitle: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '800',
    marginTop: 12,
    textAlign: 'center',
  },
  emptySub: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 20,
  },
  viewCloudBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0c4a6e',
    gap: 6,
  },
  viewCloudBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },

  /* ── Modal Detail ── */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    width: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
  },
  readOnlyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#064e3b',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    marginTop: 8,
    gap: 6,
  },
  readOnlyBannerText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '700',
  },
  modalSub: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 6,
  },

  boxCardItem: {
    backgroundColor: '#131b2e',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  boxCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  boxIndexTag: {
    backgroundColor: '#064e3b',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  boxIndexTagText: {
    color: '#34d399',
    fontSize: 14,
    fontWeight: '900',
  },
  boxSkuTag: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
    marginLeft: 8,
  },
  boxWeightTag: {
    backgroundColor: '#0c4a6e',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  boxWeightTagText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  boxFullTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 19,
    marginBottom: 6,
  },
  boxMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  boxMetaCell: {
    width: '48%',
    color: '#cbd5e1',
    fontSize: 11,
    marginVertical: 1,
  },
  metaDim: {
    color: '#64748b',
    fontWeight: '600',
  },

  closeDetailBtn: {
    backgroundColor: '#334155',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 14,
  },
  closeDetailText: {
    color: '#fff',
    fontWeight: '700',
  },
  cloneBoxBtn: {
    padding: 5,
    marginRight: 6,
    backgroundColor: '#0c4a6e',
    borderRadius: 6,
  },
  deleteBoxBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#450a0a',
    marginLeft: 6,
  },
  cloudInfoBar: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  cloudInfoBarText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  paginationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  pageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  pageBtnDisabled: {
    borderColor: '#334155',
    backgroundColor: 'transparent',
    opacity: 0.4,
  },
  pageBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  pageBtnTextDisabled: {
    color: '#64748b',
  },
  pageInfoBadge: {
    alignItems: 'center',
  },
  pageInfoText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
  },
  pageInfoHighlight: {
    color: '#38bdf8',
    fontWeight: '900',
  },
  pageTotalItemsText: {
    color: '#64748b',
    fontSize: 10,
    marginTop: 2,
  },
  activeChipsContainer: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clearAllChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#450a0a',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#f87171',
  },
  clearAllChipText: {
    color: '#fca5a5',
    fontSize: 11,
    fontWeight: '700',
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  filterChipLabel: {
    color: '#94a3b8',
    fontSize: 11,
  },
  filterChipValue: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  cloudOriginRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
    marginBottom: 2,
  },
  originTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  originTagText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
    maxWidth: 200,
  },
  cloudDateRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 4,
  },
  cloudDateText: {
    color: '#94a3b8',
    fontSize: 11,
  },
  cloudDateHighlight: {
    color: '#e2e8f0',
    fontWeight: '700',
  },
  filterFormField: {
    marginBottom: 14,
  },
  filterFormLabel: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  filterFormInput: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#f8fafc',
    fontSize: 13,
  },
  statusChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusChipBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  statusChipBtnActive: {
    backgroundColor: '#1e3a8a',
    borderColor: '#38bdf8',
  },
  statusChipBtnText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  statusChipBtnTextActive: {
    color: '#38bdf8',
    fontWeight: '800',
  },
  filterActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  filterResetBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#334155',
  },
  filterResetBtnText: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
  },
  filterApplyBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#0284c7',
  },
  filterApplyBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
  locationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#78350f',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#f59e0b',
    marginLeft: 6,
  },
  locationBadgeText: {
    color: '#fef3c7',
    fontSize: 11,
    fontWeight: '800',
  },
  cloudLocationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    marginBottom: 2,
  },
  cloudLocationLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  cloudLocationValue: {
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: '900',
  },
  cloudLocationUnassigned: {
    color: '#64748b',
    fontSize: 11,
    fontStyle: 'italic',
  },
  modalLocationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#78350f',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  modalLocationBannerText: {
    color: '#fef3c7',
    fontSize: 13,
    fontWeight: '700',
  },
  cloudAliasesText: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
    marginBottom: 2,
  },
  cloudAliasesHighlight: {
    color: '#94a3b8',
    fontWeight: '600',
  },

  // ── GỢI Ý AUTOCOMPLETE SẢN PHẨM ──────────────────────
  suggestionsContainer: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#38bdf8',
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 8,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 999,
  },
  modalSuggestionsContainer: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#38bdf8',
    marginTop: 6,
    overflow: 'hidden',
  },
  suggestionsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(16, 185, 129, 0.2)',
  },
  suggestionsHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#34d399',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  suggestionName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f8fafc',
    flexShrink: 1,
  },
  suggestionMeta: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 3,
  },
  aliasBadge: {
    backgroundColor: '#064e3b',
    borderWidth: 1,
    borderColor: '#059669',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  aliasBadgeText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '800',
  },

  // ── DATE PICKER TRIGGER TRONG BỘ LỌC ────────────────
  datePickerTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  datePickerTriggerText: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 6,
  },
  datePickerPlaceholderText: {
    color: '#64748b',
    fontWeight: 'normal',
  },

  // ── LỊCH CHỌN NGÀY (CALENDAR PICKER MODAL) ───────────
  calendarModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  calendarModalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1e293b',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
  },
  calendarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  calendarTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f8fafc',
  },
  monthSwitcherRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  monthNavBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  monthYearTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#38bdf8',
  },
  weekDaysRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  weekDayText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarDayCell: {
    width: '14.28%',
    height: 38,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 2,
    borderRadius: 8,
  },
  calendarDayCellSelected: {
    backgroundColor: '#0284c7',
  },
  calendarDayCellToday: {
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  calendarDayText: {
    fontSize: 13,
    color: '#f8fafc',
    fontWeight: '500',
  },
  calendarDayTextSelected: {
    color: '#ffffff',
    fontWeight: '800',
  },
  calendarDayTextToday: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  quickDateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  quickDateBtn: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  quickDateBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  offlineStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderWidth: 1,
    borderColor: '#334155',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  offlineStatusBarActive: {
    backgroundColor: 'rgba(120, 53, 15, 0.25)',
    borderColor: '#d97706',
  },
  offlineStatusText: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  offlineStatusSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 1,
  },
  offlineSyncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0369a1',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 7,
  },
  offlineSyncBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
});