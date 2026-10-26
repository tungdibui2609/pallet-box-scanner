import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Alert, ActivityIndicator, Modal, ScrollView, TextInput,
  KeyboardAvoidingView, Platform, RefreshControl
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Pallet, BoxLabel, CloudPallet, CloudFilterCriteria } from '../types';
import {
  getAllPallets, getBoxesByPallet, deletePallet,
  deleteBox, cloneBoxToPallet, saveCloudPalletToLocal,
  getCloudPalletsFromCache, getProductsFromCache
} from '../services/database';
import {
  syncPalletToSupabase, testConnection, pullPalletFromSupabase,
  unlinkBoxOnSupabase, fetchCloudPallets, fetchCloudPalletBoxes,
  fetchProductsForSuggestions, ProductSuggestion,
  syncCloudPalletsOffline, getLastOfflineSyncInfo
} from '../services/supabase';
import { calculateSearchScore, matchSearch, normalizeSearchString } from '../utils/searchUtils';

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
  isActive
}: {
  onBackToScanner: () => void;
  isActive?: boolean;
}) {
  // Tabs: 'pending' (Chờ đẩy lên / Chưa đồng bộ) vs 'cloud' (Đã lên Web mẹ / Đã đồng bộ)
  const [activeTab, setActiveTab] = useState<'pending' | 'cloud'>('pending');

  // Local pending pallets
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [isSyncingAll, setIsSyncingAll] = useState(false);

  // Cloud pallets (Web mẹ)
  const [cloudPallets, setCloudPallets] = useState<CloudPallet[]>([]);
  const [loadingCloud, setLoadingCloud] = useState(false);
  const [cloudSearchQuery, setCloudSearchQuery] = useState('');
  const [pullingCloudStt, setPullingCloudStt] = useState<string | null>(null);

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
  const [isOnline, setIsOnline] = useState<boolean>(false);

  // Detail Modal
  const [selectedPallet, setSelectedPallet] = useState<Pallet | null>(null);
  const [selectedCloudPallet, setSelectedCloudPallet] = useState<CloudPallet | null>(null);
  const [selectedBoxes, setSelectedBoxes] = useState<BoxLabel[]>([]);
  const [isLoadingBoxes, setIsLoadingBoxes] = useState(false);

  useEffect(() => {
    loadCacheFirst();
    loadLocalPallets();
    loadCloudPallets();
    checkNetwork();
    refreshSyncInfo();
  }, []);

  // Tự động làm mới danh sách Pallet từ SQLite ngay lập tức khi người dùng chuyển sang tab Pallet Kho
  useEffect(() => {
    if (isActive) {
      loadLocalPallets(pallets.length > 0);
      checkNetwork();
      setActiveTab('pending');
    }
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

  async function loadCacheFirst() {
    try {
      const cached = await getCloudPalletsFromCache();
      if (cached && cached.length > 0) {
        setCloudPallets(cached);
      }
      const cachedProds = await getProductsFromCache();
      if (cachedProds && cachedProds.length > 0) {
        setAvailableProducts(cachedProds);
      }
    } catch (e) {
      console.warn('loadCacheFirst error:', e);
    }
  }

  async function checkNetwork() {
    const res = await testConnection();
    setIsOnline(res.success);
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
    await loadLocalPallets();
    await loadCloudPallets();
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
      Alert.alert('Đồng bộ xong', `Đã đồng bộ thành công ${successCount} / ${pending.length} Pallet lên Web mẹ!`);
      loadCloudPallets().catch(err => console.warn('Lỗi tải ngầm cloud pallets:', err));
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setIsSyncingAll(false);
    }
  }

  // ── DELETE LOCAL PALLET ──
  async function handleDelete(pallet: Pallet) {
    const isSynced = pallet.sync_status === 'synced';

    Alert.alert(
      isSynced ? 'Xóa Pallet đã đồng bộ khỏi máy' : 'Xóa Pallet chưa đồng bộ',
      isSynced
        ? `Pallet ${pallet.code} (${pallet.scanned_qty} thùng) đã từng được đẩy lên Web mẹ.\n\nBạn có muốn xóa Pallet này khỏi bộ nhớ máy con để dọn dẹp hoặc quét lại không? (Thao tác này chỉ xóa trên điện thoại, không ảnh hưởng tới dữ liệu trên Web mẹ).`
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

  // ── CLOUD ACTIONS (TAB 2) ─────────────────────────────────
  async function handlePullCloudPallet(cp: CloudPallet) {
    setPullingCloudStt(cp.stt);
    try {
      const resBoxes = await fetchCloudPalletBoxes(cp.stt, cp.lot_id);
      if (!resBoxes.success || resBoxes.data.length === 0) {
        Alert.alert('Thông báo', `Không tìm thấy thùng nào cho STT ${cp.stt} trên Web mẹ.`);
        return;
      }

      await saveCloudPalletToLocal(cp, resBoxes.data);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Thành công', `Đã lưu ${resBoxes.data.length} thùng của Pallet ${cp.stt} về máy!`);
      await loadLocalPallets();
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setPullingCloudStt(null);
    }
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
        Alert.alert('Thông báo', res.message || 'Không thể tải danh sách thùng từ Web mẹ.');
      }
    } finally {
      setIsLoadingBoxes(false);
    }
  }

  async function handleDeleteBox(box: BoxLabel) {
    if (!selectedPallet) return;
    if (selectedPallet.sync_status === 'synced' || selectedCloudPallet) {
      Alert.alert('Không thể xóa', 'Dữ liệu đã đồng bộ lên Web mẹ không được phép chỉnh sửa hoặc xóa từ điện thoại.');
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
      Alert.alert('Không thể nhân bản', 'Dữ liệu đã đồng bộ lên Web mẹ không được phép nhân bản.');
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

  // Filter lists
  const pendingPallets = pallets.filter(p => p.sync_status !== 'synced');
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

  function normalizeText(text?: string | null): string {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .trim();
  }

  function getInitials(text?: string | null): string[] {
    if (!text) return [];
    const clean = normalizeText(text);
    const words = clean.split(/[^a-z0-9]+/i).filter(Boolean);
    if (words.length === 0) return [];
    
    // 1. Chữ cái đầu mỗi từ: VD "Sau Rieng Monthong C" -> "srmc"
    const standard = words.map(w => w[0]).join('');
    // 2. Kèm chữ số: VD "Ri 6" -> "r6", "Ri6" -> "r6"
    const withDigits = words.map(w => {
      const d = w.replace(/\D/g, '');
      return d ? (w[0] + d) : w[0];
    }).join('');

    return Array.from(new Set([standard, withDigits].filter(Boolean)));
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
      const [_, y, m, d] = ymdMatch;
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
      const [_, d, m, y] = dmyMatch;
      const mPad = m.padStart(2, '0');
      const dPad = d.padStart(2, '0');
      const ymdDash = `${y}-${mPad}-${dPad}`;
      if (dNorm.includes(normalizeText(ymdDash))) {
        return true;
      }
    }

    return false;
  }

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

  // Gợi ý cho ô tìm kiếm chính (theo thuật toán Web mẹ)
  const searchProductSuggestions = useMemo(() => {
    return getProductSuggestions(cloudSearchQuery, allProductSuggestions);
  }, [allProductSuggestions, cloudSearchQuery]);

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
        const q = normalizeText(cloudSearchQuery);
        const matchProduct = matchProductSearch(cp, cloudSearchQuery);
        const matchSearch =
          matchProduct ||
          normalizeText(cp.stt).includes(q) ||
          (cp.lot_code && normalizeText(cp.lot_code).includes(q)) ||
          (cp.tag && normalizeText(cp.tag).includes(q)) ||
          (cp.production_place && normalizeText(cp.production_place).includes(q)) ||
          (cp.material_zone && normalizeText(cp.material_zone).includes(q)) ||
          matchDate(cp.packaging_date, cloudSearchQuery) ||
          matchDate(cp.production_date, cloudSearchQuery) ||
          (cp.location_code && normalizeText(cp.location_code).includes(q));
        if (!matchSearch) return false;
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

  return (
    <View style={styles.container}>
      {/* ── TOP BAR ───────────────────────────────── */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={onBackToScanner}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
          <Text style={styles.backBtnText}>Quét Thùng</Text>
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

      {/* ── TAB SWITCHER ──────────────────────────── */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'pending' && styles.tabButtonActive]}
          onPress={() => setActiveTab('pending')}
        >
          <Ionicons
            name="time-outline"
            size={18}
            color={activeTab === 'pending' ? '#38bdf8' : '#94a3b8'}
          />
          <Text style={[styles.tabButtonText, activeTab === 'pending' && styles.tabButtonTextActive]}>
            Chờ đẩy lên ({pendingCount})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'cloud' && styles.tabButtonActive]}
          onPress={() => {
            setActiveTab('cloud');
            if (cloudPallets.length === 0) loadCloudPallets();
          }}
        >
          <Ionicons
            name="cloud-done-outline"
            size={18}
            color={activeTab === 'cloud' ? '#38bdf8' : '#94a3b8'}
          />
          <Text style={[styles.tabButtonText, activeTab === 'cloud' && styles.tabButtonTextActive]}>
            Đã lên Web mẹ ({cloudPallets.length})
          </Text>
        </TouchableOpacity>
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
                Tất cả các Pallet bạn quét đã được đẩy lên Web mẹ thành công hoặc chưa có lượt quét mới.
              </Text>
              <TouchableOpacity
                style={styles.viewCloudBtn}
                onPress={() => setActiveTab('cloud')}
              >
                <Ionicons name="cloud-outline" size={16} color="#38bdf8" />
                <Text style={styles.viewCloudBtnText}>Xem danh sách Đã lên Web mẹ</Text>
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

                return (
                  <TouchableOpacity
                    style={styles.palletCard}
                    onPress={() => handleOpenLocalDetail(item)}
                  >
                    <View style={styles.palletCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
                        <Ionicons name="cube" size={20} color="#fbbf24" style={{ marginRight: 8 }} />
                        <Text style={styles.palletCode}>{item.code}</Text>
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
                      <Text style={styles.palletMeta}>
                        Số lượng: <Text style={{ color: '#22c55e', fontWeight: '900' }}>{item.scanned_qty}</Text> / {item.target_qty} thùng
                      </Text>
                      <Text style={styles.palletMeta}>
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

                    <View style={styles.palletCardFooter}>
                      <TouchableOpacity
                        style={styles.deleteBtn}
                        onPress={() => handleDelete(item)}
                      >
                        <Ionicons name="trash-outline" size={16} color="#ef4444" />
                        <Text style={styles.deleteBtnText}>Xóa</Text>
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
                            <Text style={styles.syncSingleText}>Tải lên Web</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      )}

      {/* ── TAB 2: ĐÃ LÊN WEB MẸ (ĐỒNG BỘ VỚI WEB MẸ & KHÔNG ĐƯỢC XÓA) ───────────── */}
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
                  <Ionicons name="sparkles" size={13} color="#10b981" />
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
                {cloudSearchQuery || hasActiveFilters ? 'Không tìm thấy kết quả phù hợp' : 'Chưa có Pallet nào trên Web mẹ'}
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
                const isPulling = pullingCloudStt === item.stt;

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
                  Dữ liệu đã lên Web mẹ an toàn (Không thể xóa/sửa từ app)
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

            <TouchableOpacity
              style={styles.closeDetailBtn}
              onPress={() => { setSelectedPallet(null); setSelectedCloudPallet(null); }}
            >
              <Text style={styles.closeDetailText}>Đóng</Text>
            </TouchableOpacity>
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
                        <Ionicons name="sparkles" size={13} color="#10b981" />
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
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    gap: 8,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
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
  tabButtonText: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '700',
  },
  tabButtonTextActive: {
    color: '#38bdf8',
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