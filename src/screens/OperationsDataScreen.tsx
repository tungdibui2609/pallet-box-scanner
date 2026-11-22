import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Image,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../contexts/AuthContext';
import { useTheme, AppThemeColors } from '../contexts/ThemeContext';
import {
  DeliveryShift,
  ShiftProductItem,
  JournalRecord,
  SubShift,
  getOpenShifts,
  getPastShifts,
  getShiftJournals,
  getMultiShiftJournals,
  submitJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
  syncPinnedProducts,
  getWarehouseProducts,
  getSubShifts,
  aggregateShiftsProducts,
  aggregateShiftsUnits,
  getPendingOperationsCount,
  syncOperationsOfflineQueue,
  getJobTemplates,
  getOrderTypes,
  getCurrentSystemCode,
  ReconcileEntry,
  getCachedShiftReconciliations,
  saveShiftReconciliations,
  registerShiftParticipant,
} from '../services/operationsService';
import { getSupabaseClient } from '../services/supabase';
import OperationNumberPadModal from '../components/operations/OperationNumberPadModal';
import ReconcileTabView from '../components/operations/ReconcileTabView';
import OpenJobModal from '../components/operations/OpenJobModal';
import CloseJobModal from '../components/operations/CloseJobModal';
import InterimCloseModal from '../components/operations/InterimCloseModal';
import ProductHistoryModal from '../components/operations/ProductHistoryModal';
import EditJournalModal from '../components/operations/EditJournalModal';
import PastShiftDetailModal from '../components/operations/PastShiftDetailModal';
import AggregatedReportModal from '../components/operations/AggregatedReportModal';
import { CalendarPickerModal } from '../components/operations/CalendarPickerModal';
import OperationImagesModal, { JournalImageTarget } from '../components/operations/OperationImagesModal';
import WarehouseAlbumModal from '../components/operations/WarehouseAlbumModal';
import QuickSnapQueueModal from '../components/operations/QuickSnapQueueModal';
import QuickSnapCameraModal from '../components/operations/QuickSnapCameraModal';
import {
  LocalPickedImage,
  OperationImageRecord,
  uploadOperationImages,
  getShiftOperationImages,
  syncOfflineOperationImages,
} from '../services/operationImagesService';
import {
  QuickSnapItem,
  getAllQuickSnaps,
  addQuickSnap,
  updateQuickSnapShift,
  removeQuickSnap,
} from '../services/quickSnapStore';
import { formatDateDisplay, formatDateTime, toTimestamp } from '../utils/dateUtils';
import { matchSearch, calculateSearchScore } from '../utils/searchUtils';

interface OperationsDataScreenProps {
  isActive?: boolean;
}

// Helper lấy date key (YYYY-MM-DD) từ ISO string
function getShiftDateString(isoString?: string | null): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return '';
  }
}

// Helper kiểm tra ca có đóng sang ngày hôm sau không
function isOvernightShift(shift?: DeliveryShift | null): boolean {
  if (!shift?.opened_at || !shift?.closed_at) return false;
  return getShiftDateString(shift.opened_at) !== getShiftDateString(shift.closed_at);
}

// Helper kiểm tra đơn vị có phải là Thùng không
function isBoxUnit(u?: string | null): boolean {
  if (!u) return false;
  const lower = u.trim().toLowerCase();
  return lower.includes('thùng') || lower.startsWith('thung');
}

// Helper chuẩn hóa nhãn đơn vị có hậu tố (Ví dụ: Thùng -> Thùng (20kg))
function standardizeUnitLabel(u?: string | null): string {
  if (!u) return '';
  const norm = u.trim().toLowerCase();
  if (norm === 'thùng' || norm === 'thung') return 'Thùng (20kg)';
  return u.trim();
}

// Helper định dạng khoảng thời gian gọn (HH:mm - HH:mm)
function formatCompactRange(fromIso?: string | null, toIso?: string | null): string {
  if (!fromIso || !toIso) return '-';
  try {
    const fTs = toTimestamp(fromIso);
    const tTs = toTimestamp(toIso);
    const f = new Date(fTs || fromIso);
    const t = new Date(tTs || toIso);
    const fStr = f.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const tStr = t.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dStr = t.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    return `${fStr} - ${tStr} (${dStr})`;
  } catch {
    return `${fromIso} - ${toIso}`;
  }
}

// Helper lọc bỏ tag hệ thống khỏi ghi chú người dùng
function cleanUserNotes(notes?: string | null): string {
  if (!notes) return '';
  return notes
    .replace(/\[CV_ID:\s*[^\]]+\]/gi, '')
    .replace(/\[PID:\s*[^\]]+\]/gi, '')
    .replace(/\[SKU:\s*[^\]]*\]/gi, '')
    .replace(/\[CV:\s*[^\]]+\]/gi, '')
    .replace(/Nhập kho|Xuất kho/gi, '')
    .replace(/^[\s-]+/, '')
    .trim();
}

export default function OperationsDataScreen({ isActive = true }: OperationsDataScreenProps = {}) {
  const { user } = useAuth();

  // Tab: 'active' (Đang làm) | 'done' (Đã hoàn thành)
  const [activeTab, setActiveTab] = useState<'active' | 'done'>('active');
  const [isWarehouseAlbumVisible, setIsWarehouseAlbumVisible] = useState(false);
  const [albumSystemCode, setAlbumSystemCode] = useState<string>('');

  // Quản lý ca công việc
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const [openShifts, setOpenShifts] = useState<DeliveryShift[]>([]);
  const [selectedShift, setSelectedShift] = useState<DeliveryShift | null>(null);
  const [pastShifts, setPastShifts] = useState<DeliveryShift[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Danh mục sản phẩm & Bàn làm việc
  const [allProducts, setAllProducts] = useState<ShiftProductItem[]>([]);
  const allProductsRef = useRef<ShiftProductItem[]>([]);
  useEffect(() => {
    allProductsRef.current = allProducts;
  }, [allProducts]);
  const [pinnedProducts, setPinnedProducts] = useState<ShiftProductItem[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMode, setSearchMode] = useState<'filter' | 'pin'>('filter');

  // Bản đồ ghi nhớ ĐVT người dùng đang chọn cho từng sản phẩm
  const [selectedUnitMap, setSelectedUnitMap] = useState<Record<string, string>>({});

  // Nhật ký của toàn ca hiện tại & Danh sách các đợt chốt tạm
  const [allJournals, setAllJournals] = useState<JournalRecord[]>([]);
  const [subShifts, setSubShifts] = useState<SubShift[]>([]);

  // Chế độ xem: 'sub-shift' (Đợt hiện tại - reset về 0 sau khi chốt tạm) | 'shift' (Toàn ca)
  const [viewMode, setViewMode] = useState<'sub-shift' | 'shift'>('sub-shift');

  // Tab Báo cáo cuối trang: 'feed' (Lịch sử đợt) | 'summary' (Báo cáo tổng hợp)
  const [reportTab, setReportTab] = useState<'feed' | 'summary' | 'reconcile'>('feed');
  const [reconcileMap, setReconcileMap] = useState<Record<string, ReconcileEntry>>({});
  const [savingReconcile, setSavingReconcile] = useState(false);
  const [expandedReconcileKeys, setExpandedReconcileKeys] = useState<Record<string, boolean>>({});
  const [reconcileImagesMap, setReconcileImagesMap] = useState<Record<string, { start: OperationImageRecord[]; end: OperationImageRecord[] }>>({});
  const [uploadingReconcileKey, setUploadingReconcileKey] = useState<string | null>(null);
  const [previewReconcileImage, setPreviewReconcileImage] = useState<OperationImageRecord | null>(null);

  useEffect(() => {
    const shiftId = selectedShift?.id;
    const fromShift = (selectedShift as any)?.summary_data?.reconciliations;
    const timer = setTimeout(() => {
      if (!shiftId) {
        setReconcileMap({});
        return;
      }
      if (fromShift && typeof fromShift === 'object') {
        setReconcileMap(fromShift);
        return;
      }
      getCachedShiftReconciliations(shiftId)
        .then(setReconcileMap)
        .catch(() => setReconcileMap({}));
    }, 0);
    return () => clearTimeout(timer);
  }, [selectedShift]);

  const handleSaveReconcile = async () => {
    if (!selectedShift?.id) return;
    setSavingReconcile(true);
    try {
      const nextSummary = await saveShiftReconciliations(selectedShift, reconcileMap);
      setSelectedShift((prev: any) => (prev && prev.id === selectedShift.id ? { ...prev, summary_data: nextSummary } : prev));
      Alert.alert('Thành công', 'Đã lưu dữ liệu tham chiếu.');
    } catch (e: any) {
      Alert.alert('Lỗi', e?.message || 'Không thể lưu tham chiếu');
    } finally {
      setSavingReconcile(false);
    }
  };

  const handlePickReconcileImage = (reconcileKey: string, phase: 'start' | 'end', itemName: string, unit: string) => {
    if (!selectedShift?.id) return;
    const doUpload = async (assets: ImagePicker.ImagePickerAsset[]) => {
      if (!assets || assets.length === 0) return;
      setUploadingReconcileKey(`${reconcileKey}:${phase}`);
      try {
        const images: LocalPickedImage[] = assets.map((a, idx) => ({
          localId: `ref_${Date.now()}_${idx}`,
          uri: a.uri,
          fileName: a.fileName || `ref_${Date.now()}_${idx}.jpg`,
          mimeType: a.mimeType || 'image/jpeg',
          fileSize: a.fileSize,
        }));
        await uploadOperationImages({
          systemCode: selectedShift.system_code || 'KHO_DONG_LANH',
          companyId: selectedShift.company_id || user?.company_id || null,
          shiftId: selectedShift.id,
          jobName: selectedShift.summary_data?.job_name || selectedShift.notes || '',
          scope: 'shift',
          itemName: reconcileKey === '__TOTAL__' ? 'Tham chiếu tổng' : itemName,
          unit,
          notes: `[THAM_CHIEU:${reconcileKey}:${phase}]`,
          images,
          user,
        });
        await reloadShiftData(selectedShift.id);
      } catch (e: any) {
        Alert.alert('Lỗi tải ảnh', e?.message || 'Không thể tải ảnh tham chiếu');
      } finally {
        setUploadingReconcileKey(null);
      }
    };

    Alert.alert(`Ảnh tham chiếu ${phase === 'start' ? 'ĐẦU' : 'CUỐI'}`, 'Chọn nguồn ảnh:', [
      {
        text: 'Chụp ảnh mới',
        onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Cần quyền Camera', 'Vui lòng cấp quyền camera để chụp ảnh.');
            return;
          }
          const res = await ImagePicker.launchCameraAsync({ quality: 0.75 });
          if (!res.canceled && res.assets) await doUpload(res.assets);
        },
      },
      {
        text: 'Chọn từ thư viện',
        onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Cần quyền Thư viện', 'Vui lòng cấp quyền truy cập ảnh.');
            return;
          }
          const res = await ImagePicker.launchImageLibraryAsync({
            allowsMultipleSelection: true,
            quality: 0.75,
          });
          if (!res.canceled && res.assets) await doUpload(res.assets);
        },
      },
      { text: 'Hủy', style: 'cancel' },
    ]);
  };
  // Bộ lọc cho Lịch sử đợt: 'all' | 'in' | 'out'
  const [journalFilter, setJournalFilter] = useState<'all' | 'in' | 'out'>('all');

  // Trạng thái mở rộng các đợt chốt tạm trong lịch sử
  const [expandedSubShifts, setExpandedSubShifts] = useState<Record<string, boolean>>({});

  // Trạng thái thu / mở rộng các thẻ trong Báo cáo tổng hợp (Mặc định đều là THU)
  const [expandUnitSummary, setExpandUnitSummary] = useState(false);
  const [expandProductSummary, setExpandProductSummary] = useState(false);
  const [expandSubShiftsSummary, setExpandSubShiftsSummary] = useState(false);

  // Chỉnh sửa dòng ghi nhận
  const [editingRecord, setEditingRecord] = useState<JournalRecord | null>(null);
  const [isEditModalVisible, setIsEditModalVisible] = useState(false);

  // Modals
  const [padProduct, setPadProduct] = useState<ShiftProductItem | null>(null);
  const [padDefaultUnit, setPadDefaultUnit] = useState<string | undefined>(undefined);
  const [isPadVisible, setIsPadVisible] = useState(false);
  const [isOpenJobModal, setIsOpenJobModal] = useState(false);
  const [isCloseJobModal, setIsCloseJobModal] = useState(false);
  const [isInterimCloseModal, setIsInterimCloseModal] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [isImagesModalVisible, setIsImagesModalVisible] = useState(false);
  const [journalTargetForImages, setJournalTargetForImages] = useState<JournalImageTarget | null>(null);
  const [shiftImageCount, setShiftImageCount] = useState(0);
  const [bgUploadingCount, setBgUploadingCount] = useState(0);
  const [quickSnaps, setQuickSnaps] = useState<QuickSnapItem[]>([]);
  const [isQuickSnapModalVisible, setIsQuickSnapModalVisible] = useState(false);
  const [isQuickCameraVisible, setIsQuickCameraVisible] = useState(false);
  const [isQuickSnapBarCollapsed, setIsQuickSnapBarCollapsed] = useState(false);
  const [historyProduct, setHistoryProduct] = useState<ShiftProductItem | null>(null);
  const [isHistoryVisible, setIsHistoryVisible] = useState(false);
  const [isShiftDropdownOpen, setIsShiftDropdownOpen] = useState(false);

  // Xem chi tiết ca đã hoàn thành
  const [selectedPastShift, setSelectedPastShift] = useState<DeliveryShift | null>(null);
  const [pastSubShifts, setPastSubShifts] = useState<SubShift[]>([]);
  const [pastShiftJournals, setPastShiftJournals] = useState<JournalRecord[]>([]);
  const [loadingPastDetail, setLoadingPastDetail] = useState(false);

  // Chế độ xem trong Tab Đã Hoàn Thành: 'single' (Từng CV) | 'daily' (Theo Ngày) | 'product' (Theo Sản Phẩm) | 'custom' (Tùy Chọn)
  const [doneMode, setDoneMode] = useState<'single' | 'daily' | 'product' | 'custom'>('single');
  // Chế độ lọc trong tab Theo Ngày: 'multi' (Tùy chọn nhiều ngày) | 'range' (Mốc thời gian Từ - Đến)
  const [dailyFilterType, setDailyFilterType] = useState<'multi' | 'range'>('multi');
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [dailyRangeFrom, setDailyRangeFrom] = useState<string>('');
  const [dailyRangeTo, setDailyRangeTo] = useState<string>('');
  const [dailyJournals, setDailyJournals] = useState<JournalRecord[]>([]);
  const [loadingDailyJournals, setLoadingDailyJournals] = useState<boolean>(false);
  // Modal Lịch chọn ngày
  const [isCalendarModalVisible, setIsCalendarModalVisible] = useState<boolean>(false);
  const [calendarTarget, setCalendarTarget] = useState<'multi' | 'from' | 'to' | 'prodFrom' | 'prodTo'>('multi');

  // Cho Báo Cáo Theo Sản Phẩm:
  const [prodSearchQuery, setProdSearchQuery] = useState<string>('');
  const [prodTimeFilter, setProdTimeFilter] = useState<'today' | 'yesterday' | '7days' | '30days' | 'range' | 'all'>('7days');
  const [prodRangeFrom, setProdRangeFrom] = useState<string>('');
  const [prodRangeTo, setProdRangeTo] = useState<string>('');
  const [selectedProductFilter, setSelectedProductFilter] = useState<string>('all');
  const [prodJournals, setProdJournals] = useState<JournalRecord[]>([]);
  const [loadingProdJournals, setLoadingProdJournals] = useState<boolean>(false);
  const [expandProdProducts, setExpandProdProducts] = useState<boolean>(true);
  const [expandProdUnits, setExpandProdUnits] = useState<boolean>(true);

  // Danh sách công việc được tích chọn trong chế độ Tùy Chọn
  const [selectedCustomShiftIds, setSelectedCustomShiftIds] = useState<string[]>([]);
  const [isCustomReportModalVisible, setIsCustomReportModalVisible] = useState<boolean>(false);
  const [customJournals, setCustomJournals] = useState<JournalRecord[]>([]);
  const [loadingCustomJournals, setLoadingCustomJournals] = useState<boolean>(false);

  // Trạng thái mở rộng các khối trong Báo Cáo Theo Ngày (Mặc định đều Mở)
  const [expandDailyProducts, setExpandDailyProducts] = useState<boolean>(true);
  const [expandDailyUnits, setExpandDailyUnits] = useState<boolean>(true);
  const [expandDailyShifts, setExpandDailyShifts] = useState<boolean>(true);

  // Ô tìm kiếm công việc trong tab Đã hoàn thành (áp dụng cho Tùy Chọn & Từng CV)
  const [doneSearchQuery, setDoneSearchQuery] = useState<string>('');

  // ── TRẠNG THÁI OFFLINE & ĐỒNG BỘ DỮ LIỆU KHO ĐÔNG ──
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);
  const [isSyncingOffline, setIsSyncingOffline] = useState<boolean>(false);

  const refreshPendingCount = useCallback(async () => {
    try {
      const count = await getPendingOperationsCount();
      setPendingSyncCount(count);
    } catch {}
  }, []);

  const handleSyncOfflineNow = async () => {
    if (isSyncingOffline) return;
    setIsSyncingOffline(true);
    try {
      const res = await syncOperationsOfflineQueue();
      await refreshPendingCount();
      await handleRefresh();
      Alert.alert('Đồng bộ số liệu', res.message || 'Đã đồng bộ thành công!');
    } catch (err: any) {
      Alert.alert('Đồng bộ thất bại', err?.message || 'Không thể kết nối đến máy chủ. Bạn vui lòng thử lại sau khi có mạng!');
    } finally {
      setIsSyncingOffline(false);
    }
  };

  useEffect(() => {
    const initialTimer = setTimeout(() => {
      void refreshPendingCount();
    }, 0);
    const interval = setInterval(() => {
      void refreshPendingCount();
    }, 10000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [refreshPendingCount]);

  // Mở xem chi tiết báo cáo ca đã hoàn thành
  const handleOpenPastShiftDetail = async (shift: DeliveryShift) => {
    setSelectedPastShift(shift);
    setLoadingPastDetail(true);
    try {
      const [jList, sList] = await Promise.all([
        getShiftJournals(shift.id),
        getSubShifts(shift.id),
      ]);
      setPastShiftJournals(jList);
      setPastSubShifts(sList);
    } catch (e) {
      console.warn('Lỗi lấy chi tiết ca hoàn thành:', e);
    } finally {
      setLoadingPastDetail(false);
    }
  };

  const enrichProducts = useCallback((list: ShiftProductItem[], catalog: ShiftProductItem[]): ShiftProductItem[] => {
    if (!catalog || catalog.length === 0) return list;
    return list.map(item => {
      const found = catalog.find(c => c.id === item.id || c.name.trim().toLowerCase() === item.name.trim().toLowerCase());
      if (found) {
        const uList = found.available_units && found.available_units.length > 0 ? found.available_units : (item.available_units || []);
        const thungU = uList.find(u => isBoxUnit(u));
        return {
          ...item,
          sku: item.sku || found.sku,
          unit: thungU || found.unit || item.unit,
          available_units: uList.length > 0 ? uList : item.available_units,
        };
      }
      return item;
    });
  }, []);

  // Tải lại nhật ký và các đợt chốt tạm của ca
  const reloadShiftData = useCallback(async (shiftId: string) => {
    try {
      const [jList, sList, imgList] = await Promise.all([
        getShiftJournals(shiftId),
        getSubShifts(shiftId),
        getShiftOperationImages(shiftId),
      ]);
      setAllJournals(jList);
      setSubShifts(sList);
      setShiftImageCount(imgList.length);
      const refMap: Record<string, { start: OperationImageRecord[]; end: OperationImageRecord[] }> = {};
      imgList.forEach(img => {
        const m = img.notes?.match(/^\[THAM_CHIEU:([^\]:]+)(?::(start|end))?\]/);
        if (m && m[1]) {
          const phase = m[2] === 'end' ? 'end' : 'start';
          if (!refMap[m[1]]) refMap[m[1]] = { start: [], end: [] };
          refMap[m[1]][phase].push(img);
        }
      });
      setReconcileImagesMap(refMap);
    } catch (e) {
      console.warn('Lỗi lấy nhật ký & đợt chốt tạm:', e);
    }
  }, [setShiftImageCount]);

  const reloadShiftDataRef = useRef(reloadShiftData);
  useEffect(() => {
    reloadShiftDataRef.current = reloadShiftData;
  }, [reloadShiftData]);

  // Chọn ca công việc (Khai báo trước để loadInitialData gọi an toàn)
  const selectShift = useCallback(async (shift: DeliveryShift, catalog?: ShiftProductItem[]) => {
    setSelectedShift(shift);
    setIsShiftDropdownOpen(false);

    // Nạp pinned products từ summary_data của ca, đồng bộ available_units đầy đủ từ danh mục kho
    const cat = catalog && catalog.length > 0 ? catalog : allProductsRef.current;
    const savedPinned = shift.summary_data?.pinned_products || [];
    const enriched = enrichProducts(savedPinned, cat);
    setPinnedProducts(enriched);

    // Tự động map selectedUnitMap sang đơn vị Thùng (20kg)
    const unitMap: Record<string, string> = {};
    enriched.forEach(p => {
      const found = cat.find((c: ShiftProductItem) => c.id === p.id || c.name.trim().toLowerCase() === p.name.trim().toLowerCase());
      const uList = found?.available_units && found.available_units.length > 0 ? found.available_units : (p.available_units || []);
      const thungU = uList.find((u: string) => isBoxUnit(u));
      unitMap[p.id] = thungU || p.unit || uList[0] || 'Kg';
    });
    setSelectedUnitMap(prev => ({ ...prev, ...unitMap }));

    // Tải nhật ký số liệu và danh sách đợt chốt tạm của ca
    await reloadShiftDataRef.current(shift.id);
  }, [enrichProducts, setIsShiftDropdownOpen]);

  const loadInitialData = useCallback(async () => {
    setLoading(true);
    try {
      const [shifts, prods, past] = await Promise.all([
        getOpenShifts(),
        getWarehouseProducts(),
        getPastShifts(100),
      ]);
      setOpenShifts(shifts);
      setAllProducts(prods);
      setPastShifts(past);

      if (shifts.length > 0) {
        selectShift(shifts[0], prods);
      } else {
        setSelectedShift(null);
        setPinnedProducts([]);
        setAllJournals([]);
        setSubShifts([]);
      }
    } catch (e) {
      console.warn('Lỗi nạp dữ liệu số liệu:', e);
    } finally {
      setLoading(false);
    }
  }, [selectShift]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [shifts, prods, past] = await Promise.all([
        getOpenShifts(),
        getWarehouseProducts(),
        getPastShifts(100),
      ]);
      setOpenShifts(shifts);
      setAllProducts(prods);
      setPastShifts(past);
      if (selectedShift) {
        const fresh = shifts.find(s => s.id === selectedShift.id);
        if (fresh) {
          selectShift(fresh, prods);
        } else if (shifts.length > 0) {
          selectShift(shifts[0], prods);
        } else {
          setSelectedShift(null);
          setAllJournals([]);
          setSubShifts([]);
        }
      } else if (shifts.length > 0) {
        selectShift(shifts[0], prods);
      }
    } finally {
      setRefreshing(false);
    }
  }, [selectedShift, selectShift]);

  const [downloadingOpsOffline, setDownloadingOpsOffline] = useState(false);
  const [syncingShift, setSyncingShift] = useState(false);

  // Đồng bộ 2 chiều phiên làm việc hiện tại (Đẩy offline lên + Tải bản mới đầy đủ nhất từ Server về để 2 người làm offline khớp 100%)
  const handleSyncCurrentShift = useCallback(async () => {
    if (syncingShift) return;
    setSyncingShift(true);
    try {
      // 1. Đẩy dữ liệu offline cục bộ của máy này lên Server trước (nếu có)
      const pushRes = await syncOperationsOfflineQueue().catch(() => ({
        success: false,
        syncedCount: 0,
      }));
      const pushedImages = await syncOfflineOperationImages().catch(() => 0);
      await refreshPendingCount();

      // 2. Tải mới nhất danh sách ca đang mở + danh mục sản phẩm từ Server
      const [shifts, prods] = await Promise.all([
        getOpenShifts(),
        getWarehouseProducts(),
      ]);
      setOpenShifts(shifts);
      setAllProducts(prods);

      const targetShiftId = selectedShift?.id;
      const freshShift = targetShiftId
        ? shifts.find(s => s.id === targetShiftId)
        : shifts[0];

      if (freshShift) {
        await selectShift(freshShift, prods);
        const serverReconcile = (freshShift as any)?.summary_data?.reconciliations;
        if (serverReconcile && typeof serverReconcile === 'object') {
          setReconcileMap(serverReconcile);
        }
        const [jList, sList] = await Promise.all([
          getShiftJournals(freshShift.id),
          getSubShifts(freshShift.id),
        ]);
        const pinnedCount = (freshShift.summary_data?.pinned_products || []).length;
        const pushedPart =
          pushRes.syncedCount > 0 || pushedImages > 0
            ? `Đã gửi lên: ${pushRes.syncedCount} lượt số liệu${pushedImages > 0 ? `, ${pushedImages} ảnh` : ''}.\n`
            : '';
        Alert.alert(
          'Đã đồng bộ phiên làm việc',
          `${pushedPart}Đã tải mới nhất cho "${freshShift.summary_data?.job_name || freshShift.notes || 'Công việc'}":\n• ${jList.length} lượt nhập/xuất\n• ${pinnedCount} sản phẩm ghim\n• ${sList.length} đợt chốt ca tạm`
        );
      } else if (targetShiftId) {
        // Ca đang mở trước đó đã được đồng nghiệp chốt hoàn thành
        if (shifts.length > 0) {
          await selectShift(shifts[0], prods);
        } else {
          setSelectedShift(null);
          setPinnedProducts([]);
          setAllJournals([]);
          setSubShifts([]);
        }
        Alert.alert(
          'Ca làm việc đã cập nhật',
          'Phiên làm việc trước đó đã được hoàn thành trên máy chủ. Đã tải lại danh sách công việc mới nhất.'
        );
      } else {
        Alert.alert(
          'Đã tải dữ liệu mới nhất',
          'Hiện chưa có công việc nào đang mở trên hệ thống.'
        );
      }
    } catch (e: any) {
      Alert.alert(
        'Chưa thể đồng bộ',
        e?.message || 'Không có kết nối mạng. Dữ liệu offline trên máy vẫn được giữ an toàn.'
      );
    } finally {
      setSyncingShift(false);
    }
  }, [syncingShift, selectedShift, selectShift, refreshPendingCount]);

  const handleSyncOperationsOffline = useCallback(async () => {
    if (downloadingOpsOffline) return;
    setDownloadingOpsOffline(true);
    try {
      await syncOperationsOfflineQueue().catch(() => {});
      await refreshPendingCount();
      const [templates] = await Promise.all([
        getJobTemplates().catch(() => []),
        getOrderTypes().catch(() => []),
        handleRefresh(),
      ]);
      Alert.alert(
        'Đã tải dữ liệu Số Liệu',
        `Đã cập nhật danh sách ca làm việc, sản phẩm và ${Array.isArray(templates) ? templates.length : 0} công việc mẫu về bộ nhớ máy.`
      );
    } catch (e: any) {
      Alert.alert('Lỗi', e?.message || 'Không thể tải dữ liệu số liệu.');
    } finally {
      setDownloadingOpsOffline(false);
    }
  }, [downloadingOpsOffline, handleRefresh, refreshPendingCount]);

  // Danh sách các ngày phát sinh từ pastShifts (Gom cả ngày mở và ngày đóng ca như Web)
  const availableDates = useMemo(() => {
    const dateMap: Record<string, number> = {};
    pastShifts.forEach(s => {
      const op = getShiftDateString(s.opened_at);
      const cl = getShiftDateString(s.closed_at);
      const shiftDates = new Set<string>();
      if (op) shiftDates.add(op);
      if (cl) shiftDates.add(cl);

      shiftDates.forEach(d => {
        dateMap[d] = (dateMap[d] || 0) + 1;
      });
    });

    return Object.keys(dateMap)
      .sort((a, b) => b.localeCompare(a))
      .map(key => ({
        dateKey: key,
        label: formatDateDisplay(key),
        count: dateMap[key],
      }));
  }, [pastShifts]);

  // Tự động gán ngày mặc định khi chuyển sang tab daily hoặc khi danh sách ngày thay đổi
  useEffect(() => {
    if (availableDates.length > 0 && selectedDates.length === 0) {
      const latest = availableDates[0].dateKey;
      const timer = setTimeout(() => {
        setSelectedDates([latest]);
        setDailyRangeFrom(latest);
        setDailyRangeTo(latest);
        setProdRangeFrom(latest);
        setProdRangeTo(latest);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [availableDates, selectedDates.length]);

  // Danh sách các công việc trong các ngày được chọn hoặc khoảng ngày (Khớp chuẩn 100% như Web)
  const dailyShifts = useMemo(() => {
    if (dailyFilterType === 'multi') {
      if (selectedDates.length === 0) return [];
      return pastShifts.filter(s => {
        const op = getShiftDateString(s.opened_at);
        const cl = getShiftDateString(s.closed_at);
        return (op && selectedDates.includes(op)) || (cl && selectedDates.includes(cl));
      });
    } else {
      if (!dailyRangeFrom || !dailyRangeTo) return [];
      const minD = dailyRangeFrom <= dailyRangeTo ? dailyRangeFrom : dailyRangeTo;
      const maxD = dailyRangeFrom <= dailyRangeTo ? dailyRangeTo : dailyRangeFrom;
      return pastShifts.filter(s => {
        const op = getShiftDateString(s.opened_at);
        const cl = getShiftDateString(s.closed_at);
        const opMatch = op ? (op >= minD && op <= maxD) : false;
        const clMatch = cl ? (cl >= minD && cl <= maxD) : false;
        return opMatch || clMatch;
      });
    }
  }, [pastShifts, dailyFilterType, selectedDates, dailyRangeFrom, dailyRangeTo]);

  // Tiêu đề báo cáo theo ngày hiển thị thông minh
  const dailyReportTitle = useMemo(() => {
    if (dailyFilterType === 'multi') {
      if (selectedDates.length === 0) return 'Chưa chọn ngày nào';
      if (selectedDates.length === 1) return `Báo Cáo Ngày: ${formatDateDisplay(selectedDates[0])}`;
      const sorted = [...selectedDates].sort().reverse();
      const listStr = sorted.slice(0, 3).map(d => formatDateDisplay(d).slice(0, 5)).join(', ');
      return `Báo Cáo ${selectedDates.length} Ngày: ${listStr}${sorted.length > 3 ? '...' : ''}`;
    } else {
      const minD = dailyRangeFrom <= dailyRangeTo ? dailyRangeFrom : dailyRangeTo;
      const maxD = dailyRangeFrom <= dailyRangeTo ? dailyRangeTo : dailyRangeFrom;
      if (!minD || !maxD) return 'Chưa chọn mốc thời gian';
      if (minD === maxD) return `Báo Cáo Ngày: ${formatDateDisplay(minD)}`;
      return `Báo Cáo: ${formatDateDisplay(minD)} ➔ ${formatDateDisplay(maxD)}`;
    }
  }, [dailyFilterType, selectedDates, dailyRangeFrom, dailyRangeTo]);

  const toggleSelectDate = (dateKey: string) => {
    setSelectedDates(prev => {
      if (prev.includes(dateKey)) {
        if (prev.length === 1) return prev; // giữ lại ít nhất 1 ngày
        return prev.filter(d => d !== dateKey);
      } else {
        return [...prev, dateKey];
      }
    });
  };

  // Tự động tải nhật ký các ca trong ngày khi đổi ngày hoặc danh sách ca đổi
  useEffect(() => {
    if (activeTab === 'done' && doneMode === 'daily' && dailyShifts.length > 0) {
      let cancelled = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        setLoadingDailyJournals(true);
        getMultiShiftJournals(dailyShifts.map(s => s.id))
          .then(lines => {
            if (!cancelled) setDailyJournals(lines);
          })
          .catch(err => {
            console.warn('Lỗi tải nhật ký ca trong ngày:', err);
          })
          .finally(() => {
            if (!cancelled) setLoadingDailyJournals(false);
          });
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    } else if (dailyShifts.length === 0) {
      const timer = setTimeout(() => {
        setDailyJournals([]);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [activeTab, doneMode, dailyShifts]);

  // Tính số liệu tổng hợp cho ngày
  const dailyProductRows = useMemo(() => {
    return aggregateShiftsProducts(dailyShifts, dailyJournals, allProducts);
  }, [dailyShifts, dailyJournals, allProducts]);

  const dailyUnitRows = useMemo(() => {
    return aggregateShiftsUnits(dailyProductRows);
  }, [dailyProductRows]);

  // ── LOGIC CHO BÁO CÁO THEO SẢN PHẨM ──
  // Danh sách các ca theo mốc thời gian lọc cho Báo Cáo Sản Phẩm
  const prodShifts = useMemo(() => {
    if (prodTimeFilter === 'all') return pastShifts;
    const today = new Date();
    const todayKey = getShiftDateString(today.toISOString());

    if (prodTimeFilter === 'today') {
      return pastShifts.filter(s => {
        const op = getShiftDateString(s.opened_at);
        const cl = getShiftDateString(s.closed_at);
        return op === todayKey || cl === todayKey;
      });
    }

    if (prodTimeFilter === 'yesterday') {
      const yest = new Date();
      yest.setDate(today.getDate() - 1);
      const yestKey = getShiftDateString(yest.toISOString());
      return pastShifts.filter(s => {
        const op = getShiftDateString(s.opened_at);
        const cl = getShiftDateString(s.closed_at);
        return op === yestKey || cl === yestKey;
      });
    }

    if (prodTimeFilter === '7days' || prodTimeFilter === '30days') {
      const days = prodTimeFilter === '7days' ? 7 : 30;
      const past = new Date();
      past.setDate(today.getDate() - (days - 1));
      const minD = getShiftDateString(past.toISOString());
      const maxD = todayKey;
      return pastShifts.filter(s => {
        const op = getShiftDateString(s.opened_at);
        const cl = getShiftDateString(s.closed_at);
        const opMatch = op ? (op >= minD && op <= maxD) : false;
        const clMatch = cl ? (cl >= minD && cl <= maxD) : false;
        return opMatch || clMatch;
      });
    }

    if (prodTimeFilter === 'range') {
      if (!prodRangeFrom || !prodRangeTo) return pastShifts;
      const minD = prodRangeFrom <= prodRangeTo ? prodRangeFrom : prodRangeTo;
      const maxD = prodRangeFrom <= prodRangeTo ? prodRangeTo : prodRangeFrom;
      return pastShifts.filter(s => {
        const op = getShiftDateString(s.opened_at);
        const cl = getShiftDateString(s.closed_at);
        const opMatch = op ? (op >= minD && op <= maxD) : false;
        const clMatch = cl ? (cl >= minD && cl <= maxD) : false;
        return opMatch || clMatch;
      });
    }

    return pastShifts;
  }, [pastShifts, prodTimeFilter, prodRangeFrom, prodRangeTo]);

  // Tiêu đề báo cáo theo sản phẩm
  const prodReportTitle = useMemo(() => {
    if (prodTimeFilter === 'today') return 'Hôm nay';
    if (prodTimeFilter === 'yesterday') return 'Hôm qua';
    if (prodTimeFilter === '7days') return '7 ngày qua';
    if (prodTimeFilter === '30days') return '30 ngày qua';
    if (prodTimeFilter === 'range') {
      const minD = prodRangeFrom <= prodRangeTo ? prodRangeFrom : prodRangeTo;
      const maxD = prodRangeFrom <= prodRangeTo ? prodRangeTo : prodRangeFrom;
      if (!minD || !maxD) return 'Khoảng ngày';
      if (minD === maxD) return formatDateDisplay(minD);
      return `${formatDateDisplay(minD).slice(0, 5)} ➔ ${formatDateDisplay(maxD).slice(0, 5)}`;
    }
    return 'Tất cả';
  }, [prodTimeFilter, prodRangeFrom, prodRangeTo]);

  // Tự động tải nhật ký các ca cho Báo Cáo Theo Sản Phẩm
  useEffect(() => {
    if (activeTab === 'done' && doneMode === 'product' && prodShifts.length > 0) {
      let cancelled = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        setLoadingProdJournals(true);
        getMultiShiftJournals(prodShifts.map(s => s.id))
          .then(lines => {
            if (!cancelled) setProdJournals(lines);
          })
          .catch(err => {
            console.warn('Lỗi tải nhật ký ca theo sản phẩm:', err);
          })
          .finally(() => {
            if (!cancelled) setLoadingProdJournals(false);
          });
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    } else if (prodShifts.length === 0) {
      const timer = setTimeout(() => {
        setProdJournals([]);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [activeTab, doneMode, prodShifts]);

  // Danh sách tất cả các mặt hàng thô đã gom được
  const rawProductReportRows = useMemo(() => {
    return aggregateShiftsProducts(prodShifts, prodJournals, allProducts);
  }, [prodShifts, prodJournals, allProducts]);

  // Helper dựng đối tượng tìm kiếm đầy đủ (kèm aliases, internal_code, internal_name từ danh mục allProducts)
  const buildAggregatedProductSearchObj = useCallback(
    (r: { product_id?: string | null; sku?: string | null; product_name?: string | null; jobs?: { name: string }[] }) => {
      const rName = (r.product_name || '').trim().toLowerCase();
      const rSku = (r.sku || '').trim().toLowerCase();
      const prod = allProducts.find(
        p =>
          (r.product_id && p.id === r.product_id) ||
          (rSku && p.sku && p.sku.trim().toLowerCase() === rSku) ||
          (rName && p.name && p.name.trim().toLowerCase() === rName)
      );
      return {
        name: r.product_name || '',
        sku: r.sku || prod?.sku || '',
        aliases: prod?.aliases || '',
        internal_code: prod?.internal_code || '',
        internal_name: prod?.internal_name || '',
        notes: (r.jobs || []).map(j => j.name).join(' '),
      };
    },
    [allProducts]
  );

  // Danh sách các tên sản phẩm độc nhất để làm thanh chip lọc nhanh (lọc theo từ khóa tìm kiếm nếu có)
  const uniqueProductNames = useMemo(() => {
    const names = new Set<string>();
    const q = prodSearchQuery.trim();
    rawProductReportRows.forEach(r => {
      if (!r.product_name) return;
      if (q && !matchSearch(buildAggregatedProductSearchObj(r), q)) return;
      names.add(r.product_name.trim());
    });
    return Array.from(names);
  }, [rawProductReportRows, prodSearchQuery, buildAggregatedProductSearchObj]);

  // Lọc theo từ khóa tìm kiếm (hỗ trợ tên viết tắt / aliases, không dấu, SKU, tên nội bộ) và chip sản phẩm đã chọn
  const productReportRows = useMemo(() => {
    let rows = rawProductReportRows;
    if (selectedProductFilter !== 'all') {
      rows = rows.filter(r => (r.product_name || '').trim() === selectedProductFilter);
    }
    const q = prodSearchQuery.trim();
    if (q) {
      rows = rows
        .filter(r => matchSearch(buildAggregatedProductSearchObj(r), q))
        .sort(
          (a, b) =>
            calculateSearchScore(buildAggregatedProductSearchObj(b), q) -
            calculateSearchScore(buildAggregatedProductSearchObj(a), q)
        );
    }
    return rows;
  }, [rawProductReportRows, selectedProductFilter, prodSearchQuery, buildAggregatedProductSearchObj]);

  const productReportUnits = useMemo(() => {
    return aggregateShiftsUnits(productReportRows);
  }, [productReportRows]);

  // Danh sách công việc đã hoàn thành sau khi lọc tìm kiếm
  const filteredPastShifts = useMemo(() => {
    if (!doneSearchQuery.trim()) return pastShifts;
    const q = doneSearchQuery.trim().toLowerCase();
    return pastShifts.filter(s => {
      const name = (s.summary_data?.job_name || s.notes || '').toLowerCase();
      const user = (s.closed_by_name || s.opened_by_name || '').toLowerCase();
      const orderType = (s.summary_data?.order_type_name || s.summary_data?.order_type_code || '').toLowerCase();
      const notes = (s.summary_data?.job_notes || s.notes || '').toLowerCase();
      const prods = Object.values(s.summary_data?.products_summary || {})
        .map((p: any) => (p.product_name || '').toLowerCase())
        .join(' ');
      return name.includes(q) || user.includes(q) || orderType.includes(q) || notes.includes(q) || prods.includes(q);
    });
  }, [pastShifts, doneSearchQuery]);

  // Các ca được chọn trong chế độ Tùy Chọn
  const selectedCustomShifts = useMemo(() => {
    return pastShifts.filter(s => selectedCustomShiftIds.includes(s.id));
  }, [pastShifts, selectedCustomShiftIds]);

  const toggleSelectAllCustom = () => {
    const visibleIds = filteredPastShifts.map(s => s.id);
    const isAllVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedCustomShiftIds.includes(id));
    if (isAllVisibleSelected) {
      setSelectedCustomShiftIds(prev => prev.filter(id => !visibleIds.includes(id)));
    } else {
      setSelectedCustomShiftIds(prev => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const toggleSelectCustomShift = (shiftId: string) => {
    setSelectedCustomShiftIds(prev =>
      prev.includes(shiftId) ? prev.filter(id => id !== shiftId) : [...prev, shiftId]
    );
  };

  const handleOpenCustomReport = async () => {
    if (selectedCustomShiftIds.length === 0) {
      Alert.alert('Chưa chọn công việc', 'Vui lòng tích chọn ít nhất 1 công việc để xem báo cáo gộp.');
      return;
    }
    setIsCustomReportModalVisible(true);
    setLoadingCustomJournals(true);
    try {
      const lines = await getMultiShiftJournals(selectedCustomShiftIds);
      setCustomJournals(lines);
    } catch (e) {
      console.warn('Lỗi tải nhật ký báo cáo tùy chọn:', e);
    } finally {
      setLoadingCustomJournals(false);
    }
  };

  // Nạp dữ liệu ban đầu duy nhất 1 lần khi mount
  const loadInitialRef = useRef(loadInitialData);
  useEffect(() => {
    loadInitialRef.current = loadInitialData;
  }, [loadInitialData]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadInitialRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Ghi nhận người dùng tham gia công việc & lắng nghe Realtime chốt ca tạm từ đồng nghiệp
  useEffect(() => {
    const shiftId = selectedShift?.id;
    if (!shiftId || shiftId.startsWith('offline_shift_')) return;

    if (user) {
      void registerShiftParticipant(shiftId, user);
    }

    let cancelled = false;
    let activeChannel: any = null;
    let sbClient: any = null;

    (async () => {
      try {
        sbClient = await getSupabaseClient();
        if (cancelled || !sbClient) return;
        activeChannel = sbClient
          .channel(`mobile_solieu_shift_${shiftId}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'delivery_shifts', filter: `id=eq.${shiftId}` },
            async () => {
              const freshShifts = await getOpenShifts();
              setOpenShifts(freshShifts);
              const fresh = freshShifts.find(s => s.id === shiftId);
              if (fresh) {
                setSelectedShift(fresh);
                const freshPinned = fresh.summary_data?.pinned_products;
                if (Array.isArray(freshPinned)) {
                  setPinnedProducts(enrichProducts(freshPinned, allProductsRef.current));
                }
                const freshReconcile = (fresh as any)?.summary_data?.reconciliations;
                if (freshReconcile && typeof freshReconcile === 'object' && !Array.isArray(freshReconcile)) {
                  setReconcileMap(freshReconcile);
                }
              }
            }
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'delivery_sub_shifts', filter: `shift_id=eq.${shiftId}` },
            async () => {
              await reloadShiftDataRef.current(shiftId);
              const freshShifts = await getOpenShifts();
              setOpenShifts(freshShifts);
              const fresh = freshShifts.find(s => s.id === shiftId);
              if (fresh) setSelectedShift(fresh);
            }
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'delivery_journal' },
            (payload: any) => {
              const notesStr = String(payload?.new?.notes || payload?.old?.notes || '');
              if (notesStr.includes(`[CV_ID: ${shiftId}]`)) {
                void reloadShiftDataRef.current(shiftId);
              }
            }
          )
          .subscribe();
      } catch {
        // Offline trong kho lạnh -> bỏ qua realtime
      }
    })();

    return () => {
      cancelled = true;
      if (sbClient && activeChannel) {
        void sbClient.removeChannel(activeChannel);
      }
    };
  }, [selectedShift?.id, user]);

  // Danh sách các lượt bấm hiển thị trên bàn làm việc
  // Nếu ở chế độ 'sub-shift' và có đợt chốt tạm: chỉ lấy sau mốc chốt tạm cuối cùng -> TỰ ĐỘNG RESET VỀ 0 KHI CHỐT TẠM!
  const currentBatchJournals = useMemo(() => {
    if (viewMode === 'sub-shift' && subShifts.length > 0) {
      const latestSub = subShifts.reduce((max, s) => {
        return toTimestamp(s.to_time) > toTimestamp(max.to_time) ? s : max;
      }, subShifts[0]);
      const latestTime = toTimestamp(latestSub?.to_time);
      if (latestTime > 0) {
        return allJournals.filter(l => toTimestamp(l.sent_at) > latestTime);
      }
    }
    return allJournals;
  }, [viewMode, subShifts, allJournals]);

  // Thống kê số lượng theo sản phẩm trên bàn làm việc (Chuẩn 100% theo từng Đơn vị tính như Web Mẹ)
  const productStats = useMemo(() => {
    const stats: Record<string, { inQty: number; outQty: number; count: number; unit: string }> = {};

    currentBatchJournals.forEach(item => {
      const name = (item.item_name || '').trim();
      if (!name) return;
      const rawUnit = (item.unit || 'Thùng (20kg)').trim();
      const unit = standardizeUnitLabel(rawUnit);
      const key = `${name.toLowerCase()}___${unit.toLowerCase()}`;

      if (!stats[key]) {
        stats[key] = { inQty: 0, outQty: 0, count: 0, unit };
      }

      const isImport = item.to_department === 'Kho' || (item.notes && item.notes.includes('Nhập kho'));
      const qty = Number(item.quantity_sent || (item as any).result_quantity || 0);

      if (isImport) {
        stats[key].inQty += qty;
      } else {
        stats[key].outQty += qty;
      }
      stats[key].count += 1;
    });

    return stats;
  }, [currentBatchJournals]);

  const getProductCount = (productName: string, unit?: string | null) => {
    const name = (productName || '').trim().toLowerCase();
    const u = standardizeUnitLabel(unit).toLowerCase();
    if (!u) return { inQty: 0, outQty: 0, count: 0, unit: '' };
    const key = `${name}___${u}`;
    return productStats[key] || { inQty: 0, outQty: 0, count: 0, unit: unit || '' };
  };

  // SP vừa thao tác gần nhất trong ca (đẩy lên đầu danh sách & dùng cho Quick Snap)
  const recentProductOrder = useMemo(() => {
    const order = new Map<string, number>();
    allJournals.forEach((j, idx) => {
      const key = (j.item_name || '').trim().toLowerCase();
      if (key && !order.has(key)) {
        order.set(key, idx);
      }
    });
    return order;
  }, [allJournals]);

  const recentProducts = useMemo(() => {
    if (recentProductOrder.size === 0) return [];
    return [...allProducts]
      .filter(p => recentProductOrder.has(p.name.trim().toLowerCase()))
      .sort(
        (a, b) =>
          (recentProductOrder.get(a.name.trim().toLowerCase()) ?? 9999) -
          (recentProductOrder.get(b.name.trim().toLowerCase()) ?? 9999)
      )
      .slice(0, 8);
  }, [allProducts, recentProductOrder]);

  useEffect(() => {
    getAllQuickSnaps().then(setQuickSnaps);
  }, []);

  // Danh sách sản phẩm hiển thị theo thanh tìm kiếm
  const displayedProducts = useMemo(() => {
    const q = searchQuery.trim();
    if (searchMode === 'pin') {
      // Chế độ Ghim: Tìm trong kho
      if (!q) return allProducts.slice(0, 30);
      return allProducts
        .filter(p => matchSearch(p, q))
        .sort((a, b) => calculateSearchScore(b, q) - calculateSearchScore(a, q))
        .slice(0, 30);
    } else {
      // Chế độ Nhập: Tìm trong các sản phẩm đã ghim (đẩy SP vừa làm lên đầu nếu chưa tìm kiếm)
      if (!q) {
        if (recentProductOrder.size === 0) return pinnedProducts;
        return [...pinnedProducts].sort((a, b) => {
          const ia = recentProductOrder.get(a.name.trim().toLowerCase());
          const ib = recentProductOrder.get(b.name.trim().toLowerCase());
          if (ia !== undefined && ib !== undefined) return ia - ib;
          if (ia !== undefined) return -1;
          if (ib !== undefined) return 1;
          return 0;
        });
      }
      return pinnedProducts.filter(p => matchSearch(p, q));
    }
  }, [searchMode, searchQuery, allProducts, pinnedProducts, recentProductOrder]);

  // Ghim / Bỏ ghim 1 sản phẩm
  const togglePin = async (product: ShiftProductItem) => {
    if (!selectedShift) return;
    const isPinned = pinnedProducts.some(p => p.id === product.id);
    let next: ShiftProductItem[];
    if (isPinned) {
      next = pinnedProducts.filter(p => p.id !== product.id);
    } else {
      next = [product, ...pinnedProducts];
    }
    setPinnedProducts(next);
    await syncPinnedProducts(selectedShift.id, selectedShift.summary_data, next);
  };

  // Ghim tất cả sản phẩm đang hiển thị (hoặc toàn bộ kho)
  const handlePinAll = async () => {
    if (!selectedShift) return;
    const targetList = searchQuery.trim() ? displayedProducts : allProducts;
    if (targetList.length === 0) return;
    const existingIds = new Set(pinnedProducts.map(p => p.id));
    const toAdd = targetList.filter(p => !existingIds.has(p.id));
    if (toAdd.length === 0) return;

    const next = [...pinnedProducts, ...toAdd];
    setPinnedProducts(next);
    await syncPinnedProducts(selectedShift.id, selectedShift.summary_data, next);
  };

  // Xóa toàn bộ danh sách ghim
  const handleClearPinned = () => {
    if (!selectedShift || pinnedProducts.length === 0) return;
    Alert.alert(
      'Xóa danh sách ghim',
      `Bạn có chắc chắn muốn xóa toàn bộ ${pinnedProducts.length} sản phẩm đang ghim trên bàn làm việc không?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xác Nhận Xóa',
          style: 'destructive',
          onPress: async () => {
            setPinnedProducts([]);
            await syncPinnedProducts(selectedShift.id, selectedShift.summary_data, []);
          },
        },
      ]
    );
  };

  // Helper lấy danh sách đơn vị của sản phẩm (sắp xếp ưu tiên đơn vị Thùng lên trước)
  const getProductUnits = useCallback((product: ShiftProductItem): string[] => {
    // Luôn ưu tiên tra cứu danh mục allProducts để có đầy đủ danh sách quy đổi đơn vị mới nhất
    const found = allProducts.find(c => c.id === product.id || c.name.trim().toLowerCase() === product.name.trim().toLowerCase());
    let list: string[] = [];
    if (found?.available_units && found.available_units.length > 0) {
      list = found.available_units;
    } else if (product.available_units && product.available_units.length > 0) {
      list = product.available_units;
    } else {
      list = product.unit ? [product.unit] : ['Kg'];
    }
    const standardList = list.map(standardizeUnitLabel).filter(Boolean);
    const unique = Array.from(new Set(standardList));
    return [...unique].sort((a, b) => {
      const aIs = isBoxUnit(a);
      const bIs = isBoxUnit(b);
      if (aIs && !bIs) return -1;
      if (!aIs && bIs) return 1;
      return 0;
    });
  }, [allProducts]);

  // Lấy đơn vị ưu tiên (ưu tiên đơn vị Thùng trước)
  const getPreferredUnit = useCallback((product: ShiftProductItem): string => {
    const units = getProductUnits(product);
    const current = standardizeUnitLabel(selectedUnitMap[product.id]);
    const thungUnit = units.find(u => isBoxUnit(u));

    if (current && units.includes(current) && (!thungUnit || current.includes('('))) {
      return current;
    }
    if (thungUnit) return thungUnit;
    const stdUnit = standardizeUnitLabel(product.unit);
    if (stdUnit && units.includes(stdUnit)) return stdUnit;
    return units[0] || 'Kg';
  }, [selectedUnitMap, getProductUnits]);

  // Mở bàn phím số
  const handleOpenPad = (product: ShiftProductItem, unitToUse?: string) => {
    const unit = unitToUse || getPreferredUnit(product);
    setPadProduct(product);
    setPadDefaultUnit(unit);
    setIsPadVisible(true);
  };

  // Ghi nhận lượt bấm từ Bàn phím số (Siêu tốc 0ms lag - Optimistic Update cho Kho Đông)
  const submitEntryZeroLag = async (
    targetProduct: ShiftProductItem,
    { quantity, unit, type, note, images }: { quantity: number; unit: string; type: 'in' | 'out'; note?: string; images?: LocalPickedImage[] },
    overrideShift?: DeliveryShift
  ) => {
    const targetShift = overrideShift || selectedShift;
    if (!targetShift) return;

    // 1. CẬP NHẬT TỨC THỜI TRÊN GIAO DIỆN (OPTIMISTIC UI UPDATE - 0ms phản hồi tức thì)
    const isCurrentShift = targetShift.id === selectedShift?.id;
    if (isCurrentShift) {
      const tempId = `opt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const optRecord: JournalRecord = {
        id: tempId,
        delivery_code: `SO-LIEU-${Date.now().toString().slice(-6)}`,
        item_name: targetProduct.name,
        quantity_sent: quantity,
        unit: unit,
        from_department: type === 'in' ? 'Sản xuất' : 'Kho',
        to_department: type === 'in' ? 'Kho' : 'Sản xuất',
        status: type === 'in' ? 'received_by_warehouse' : 'received_by_production',
        notes: `[CV_ID: ${targetShift.id}] [PID: ${targetProduct.id}] [SKU: ${targetProduct.sku || ''}] ${type === 'in' ? 'Nhập kho' : 'Xuất kho'}${note ? ` - ${note}` : ''}`,
        sent_by_name: user?.full_name || 'Nhân viên kho',
        sent_at: new Date().toISOString(),
        system_code: targetShift.system_code,
        is_offline: true,
      };
      setAllJournals(prev => [optRecord, ...prev]);
    }

    // 2. GHI NHẬN VÀO BỘ NHỚ LOCAL & HÀNG ĐỢI OFFLINE + UPLOAD NGẦM
    try {
      const journalId = await submitJournalEntry({
        shift: targetShift,
        product: targetProduct,
        quantity,
        unit,
        type,
        user,
        userNote: note,
      });
      if (images && images.length > 0) {
        const count = images.length;
        setBgUploadingCount(c => c + count);
        uploadOperationImages({
          images,
          systemCode: targetShift.system_code,
          companyId: targetShift.company_id || user?.company_id || null,
          shiftId: targetShift.id,
          journalId,
          scope: 'journal',
          direction: type,
          jobName: targetShift.summary_data?.job_name || targetShift.notes || 'Công việc',
          itemName: targetProduct.name,
          itemSku: targetProduct.sku || null,
          quantity,
          unit,
          user,
          notes: note || null,
        })
          .then(() => {
            if (isCurrentShift) setShiftImageCount((c) => c + count);
          })
          .catch((e) => console.warn('Upload journal images error:', e))
          .finally(() => {
            setBgUploadingCount(c => Math.max(0, c - count));
          });
      }
      refreshPendingCount();
      if (isCurrentShift) reloadShiftData(targetShift.id);
    } catch (err: any) {
      console.warn('Lỗi ghi nhật ký ngầm:', err);
    }
  };

  const handlePadSubmit = async (payload: { quantity: number; unit: string; type: 'in' | 'out'; note?: string; images?: LocalPickedImage[] }) => {
    if (!selectedShift || !padProduct) return;
    await submitEntryZeroLag(padProduct, payload);
  };

  const handleQuickSnapCaptured = ({
    shift,
    image,
  }: {
    shift: DeliveryShift;
    image: LocalPickedImage;
  }) => {
    const snap: QuickSnapItem = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      shiftId: shift.id,
      jobName: shift.summary_data?.job_name || shift.notes || 'Công việc',
      systemCode: shift.system_code,
      capturedAt: new Date().toISOString(),
      image,
    };
    setQuickSnaps(prev => [...prev, snap]);
    void addQuickSnap(snap);
  };

  const handleDeleteQuickSnap = async (id: string) => {
    await removeQuickSnap(id);
    setQuickSnaps(prev => prev.filter(s => s.id !== id));
  };

  const handleChangeQuickSnapShift = async (snapId: string, shift: DeliveryShift) => {
    const jobName = shift.summary_data?.job_name || shift.notes || 'Công việc';
    setQuickSnaps(prev =>
      prev.map(s => (s.id === snapId ? { ...s, shiftId: shift.id, jobName } : s))
    );
    await updateQuickSnapShift(snapId, shift.id, jobName);
  };

  const handleSaveQuickSnapToAlbum = (snap: QuickSnapItem) => {
    const targetShift = openShifts.find(s => s.id === snap.shiftId) || selectedShift;
    if (!targetShift) return;

    setBgUploadingCount(c => c + 1);
    uploadOperationImages({
      images: [snap.image],
      systemCode: targetShift.system_code,
      companyId: targetShift.company_id || user?.company_id || null,
      shiftId: targetShift.id,
      scope: 'shift',
      jobName: targetShift.summary_data?.job_name || targetShift.notes || snap.jobName || 'Công việc',
      user,
    })
      .then(() => {
        if (targetShift.id === selectedShift?.id) {
          setShiftImageCount(c => c + 1);
        }
      })
      .catch(e => console.warn('Save quick snap to album error:', e))
      .finally(() => {
        setBgUploadingCount(c => Math.max(0, c - 1));
      });

    void removeQuickSnap(snap.id);
    setQuickSnaps(prev => prev.filter(s => s.id !== snap.id));
  };

  const handleAssignQuickSnap = (
    snap: QuickSnapItem,
    payload: {
      product: ShiftProductItem;
      direction: 'in' | 'out';
      quantity: number;
      unit: string;
      note?: string;
    }
  ) => {
    const targetShift = openShifts.find(s => s.id === snap.shiftId) || selectedShift || undefined;
    void submitEntryZeroLag(
      payload.product,
      {
        quantity: payload.quantity,
        unit: payload.unit,
        type: payload.direction,
        note: payload.note,
        images: [snap.image],
      },
      targetShift
    );
    void removeQuickSnap(snap.id);
    setQuickSnaps(prev => prev.filter(s => s.id !== snap.id));
  };

  // Mở modal sửa dòng nhật ký
  const handleStartEdit = (record: JournalRecord) => {
    setEditingRecord(record);
    setIsEditModalVisible(true);
  };

  // Lưu cập nhật dòng nhật ký
  const handleUpdateJournalSubmit = async ({ id, quantity, unit, type, notes }: { id: string; quantity: number; unit: string; type: 'in' | 'out'; notes?: string }) => {
    if (!selectedShift) return;
    await updateJournalEntry({
      id,
      quantity,
      unit,
      type,
      notes,
      shiftId: selectedShift.id,
    });
    await reloadShiftData(selectedShift.id);
    refreshPendingCount();
  };

  // Xóa lượt ghi nhận
  const handleDeleteJournal = (recordId: string, itemName: string) => {
    Alert.alert(
      'Xóa lượt ghi nhận',
      `Bạn có chắc chắn muốn xóa lượt ghi nhận của "${itemName}" không?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa ngay',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteJournalEntry(recordId, selectedShift?.id);
              if (selectedShift) {
                await reloadShiftData(selectedShift.id);
              }
              refreshPendingCount();
            } catch (err: any) {
              Alert.alert('Lỗi xóa', err?.message || 'Không thể xóa lượt ghi nhận này.');
            }
          },
        },
      ]
    );
  };

  // Bật/tắt mở rộng khung chốt tạm
  const toggleSubShiftExpand = (ssId: string) => {
    setExpandedSubShifts(prev => ({
      ...prev,
      [ssId]: !prev[ssId],
    }));
  };

  const currentJobName = selectedShift?.summary_data?.job_name || selectedShift?.notes || 'Chưa chọn ca';

  return (
    <View style={styles.container}>
      {/* ── BANNER NGOẠI TUYẾN / ĐỒNG BỘ DỮ LIỆU KHO ĐÔNG ── */}
      {pendingSyncCount > 0 && (
        <View style={styles.offlineSyncBanner}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 }}>
            <Ionicons name="cloud-offline" size={20} color="#fbbf24" />
            <View style={{ flex: 1 }}>
              <Text style={styles.offlineSyncTitle} numberOfLines={1}>
                Chế độ Ngoại Tuyến (Kho Đông Lạnh)
              </Text>
              <Text style={styles.offlineSyncSub} numberOfLines={1}>
                {pendingSyncCount} thao tác đang lưu trong máy, sẵn sàng đẩy lên mạng
              </Text>
            </View>
          </View>

          <TouchableOpacity
            onPress={handleSyncOfflineNow}
            disabled={isSyncingOffline}
            style={styles.offlineSyncBtn}
            activeOpacity={0.7}
          >
            {isSyncingOffline ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="cloud-upload" size={14} color="#fff" />
                <Text style={styles.offlineSyncBtnText}>Đồng bộ ngay</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* ── HEADER SÁNG GỌN CHUẨN /SO-LIEU MOBILE (HÌNH 2) ── */}
      <View style={styles.lightHeaderWrapper}>
        {/* Hàng 1: Segmented Pill Đang làm / Đã hoàn thành */}
        <View style={styles.topTabBar}>
          <TouchableOpacity
            onPress={() => setActiveTab('active')}
            style={[styles.tabBtn, activeTab === 'active' && styles.tabBtnActive]}
          >
            <View style={[styles.pulseDot, openShifts.length > 0 && styles.pulseDotActive]} />
            <Text style={[styles.tabBtnText, activeTab === 'active' && styles.tabBtnTextActive]}>
              Đang làm ({openShifts.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setActiveTab('done')}
            style={[styles.tabBtn, activeTab === 'done' && styles.tabBtnActive]}
          >
            <Ionicons
              name="checkmark-circle-outline"
              size={15}
              color={activeTab === 'done' ? '#4f46e5' : '#78716c'}
            />
            <Text style={[styles.tabBtnText, activeTab === 'done' && styles.tabBtnTextActive]}>
              Đã hoàn thành ({pastShifts.length})
            </Text>
          </TouchableOpacity>
        </View>

        {/* Hàng 2 & 3 (khi đang ở tab Đang làm) */}
        {activeTab === 'active' && (
          <>
            <View style={styles.jobBar}>
              {selectedShift ? (
                <TouchableOpacity
                  onPress={() => setIsShiftDropdownOpen(!isShiftDropdownOpen)}
                  style={styles.jobDropdownBtn}
                  activeOpacity={0.85}
                >
                  <Ionicons name="briefcase-outline" size={16} color="rgba(255,255,255,0.9)" style={{ marginRight: 8 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.jobLabel}>
                      Công việc {openShifts.length > 1 ? `(${openShifts.length} đang mở)` : ''}
                    </Text>
                    <Text style={styles.jobTitle} numberOfLines={1}>
                      {currentJobName}
                    </Text>
                  </View>
                  <Ionicons
                    name={isShiftDropdownOpen ? 'caret-up' : 'caret-down'}
                    size={14}
                    color="rgba(255,255,255,0.85)"
                  />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={() => setIsOpenJobModal(true)}
                  style={styles.jobDropdownBtn}
                  activeOpacity={0.85}
                >
                  <Ionicons name="add-circle-outline" size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13, marginLeft: 8 }}>
                    Tạo Công Việc Mới
                  </Text>
                </TouchableOpacity>
              )}

              {/* Nút tròn Đồng bộ / Tải đầy đủ dữ liệu phiên làm việc (nằm giữa Công việc và Menu ⋯) */}
              <TouchableOpacity
                onPress={handleSyncCurrentShift}
                disabled={syncingShift}
                style={styles.syncShiftBtn}
                activeOpacity={0.75}
                accessibilityLabel="Đồng bộ dữ liệu phiên làm việc"
              >
                {syncingShift ? (
                  <ActivityIndicator size="small" color={isDark ? '#34d399' : '#059669'} />
                ) : (
                  <Ionicons name="sync-outline" size={20} color={isDark ? '#34d399' : '#059669'} />
                )}
                {pendingSyncCount > 0 && !syncingShift && (
                  <View style={styles.moreActionDot} />
                )}
              </TouchableOpacity>

              {/* Nút tròn ⋯ gọn gàng gom toàn bộ thao tác */}
              <TouchableOpacity
                onPress={() => setIsActionMenuOpen(true)}
                style={styles.moreActionBtn}
                activeOpacity={0.75}
                accessibilityLabel="Thao tác công việc"
              >
                <Ionicons name="ellipsis-horizontal" size={20} color={isDark ? '#cbd5e1' : '#57534e'} />
                {(selectedShift?.summary_data?.pending_interim_close || pendingSyncCount > 0) && (
                  <View style={styles.moreActionDot} />
                )}
              </TouchableOpacity>
            </View>

            {/* Sổ danh sách các công việc đang mở */}
            {isShiftDropdownOpen && (
              <View style={styles.dropdownSheet}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <Text style={styles.dropdownHeader}>Chọn công việc để ghi nhận:</Text>
                  <TouchableOpacity
                    onPress={() => {
                      setIsShiftDropdownOpen(false);
                      setIsOpenJobModal(true);
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '800', color: '#4f46e5' }}>+ Thêm mới</Text>
                  </TouchableOpacity>
                </View>
                {openShifts.map(s => {
                  const isCur = selectedShift?.id === s.id;
                  const name = s.summary_data?.job_name || s.notes || 'Công việc';
                  return (
                    <TouchableOpacity
                      key={s.id}
                      onPress={() => selectShift(s)}
                      style={[styles.dropdownItem, isCur && styles.dropdownItemActive]}
                    >
                      <View style={[styles.dot, isCur ? { backgroundColor: '#4f46e5' } : { backgroundColor: '#10b981' }]} />
                      <Text style={[styles.dropdownItemText, isCur && { color: '#4338ca', fontWeight: '800' }]} numberOfLines={1}>
                        {name}
                      </Text>
                      {isCur && <Ionicons name="checkmark" size={16} color="#4f46e5" />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Hàng 3: Thanh tìm kiếm bo tròn pill (Nhập / Ghim) */}
            {selectedShift && (
              <View
                style={[
                  styles.searchBarWrapper,
                  searchMode === 'pin' && { borderColor: '#f59e0b' },
                ]}
              >
                <TouchableOpacity
                  onPress={() => {
                    setSearchMode(prev => (prev === 'filter' ? 'pin' : 'filter'));
                    setSearchQuery('');
                  }}
                  style={[styles.modeToggleBtn, searchMode === 'filter' ? styles.modeFilter : styles.modePin]}
                >
                  <Ionicons name="search" size={13} color={searchMode === 'filter' ? '#4338ca' : '#b45309'} />
                  <Text style={[styles.modeToggleText, searchMode === 'filter' ? { color: '#4338ca' } : { color: '#b45309' }]}>
                    {searchMode === 'filter' ? 'Nhập' : 'Ghim'}
                  </Text>
                </TouchableOpacity>

                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder={
                    searchMode === 'filter'
                      ? 'Tìm SP đã ghim (Bấm 🔍 đổi chế độ)'
                      : 'Tìm SP từ kho để ghim (Bấm 🔍 đổi chế độ)'
                  }
                  placeholderTextColor="#a8a29e"
                />

                {searchQuery ? (
                  <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearSearchBtn}>
                    <Ionicons name="close-circle" size={16} color="#a8a29e" />
                  </TouchableOpacity>
                ) : null}
              </View>
            )}
          </>
        )}
      </View>

      {bgUploadingCount > 0 && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 5,
            backgroundColor: '#f0f9ff',
            borderBottomWidth: 1,
            borderBottomColor: '#bae6fd',
          }}
        >
          <ActivityIndicator size="small" color="#0284c7" />
          <Text style={{ color: '#0369a1', fontSize: 11, fontWeight: '700' }}>
            Đang đẩy ngầm {bgUploadingCount} ảnh lên hệ thống...
          </Text>
        </View>
      )}

      {activeTab === 'active' ? (
        <>

          {/* Subheader: Chạm vào sản phẩm để nhập số | N = Nhập  X = Xuất */}
          {selectedShift && (
            <View style={styles.subHeaderHintRow}>
              <Text style={styles.subHeaderHintLeft}>Chạm vào sản phẩm để nhập số</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.hintIn}>N = Nhập</Text>
                <Text style={styles.hintOut}>X = Xuất</Text>
              </View>
            </View>
          )}

          {/* Thanh trạng thái Ghim (chỉ hiện khi ở chế độ Ghim SP để giữ giao diện Nhập thật gọn như hình 1) */}
          {selectedShift && searchMode === 'pin' && (
            <View style={styles.pinnedStatusRow}>
              <Text style={styles.pinnedCountText}>
                Đang duyệt kho để ghim:{' '}
                <Text style={{ color: '#1c1917', fontWeight: '800' }}>
                  {pinnedProducts.length}/{allProducts.length} SP
                </Text>
              </Text>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <TouchableOpacity
                  onPress={() => void handlePinAll()}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 8,
                    backgroundColor: '#f59e0b',
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '800', color: '#fff' }}>
                    {searchQuery.trim() ? `Ghim lọc (${displayedProducts.length})` : 'Ghim tất cả'}
                  </Text>
                </TouchableOpacity>

                {pinnedProducts.length > 0 && (
                  <TouchableOpacity
                    onPress={handleClearPinned}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 8,
                      backgroundColor: '#fff1f2',
                      borderWidth: 1,
                      borderColor: '#fecdd3',
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#e11d48' }}>
                      Bỏ ghim tất cả
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}

          {/* ── DANH SÁCH SẢN PHẨM (FLATLIST GIAO DIỆN CHUẨN WEB MẸ) ── */}
          {loading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color="#6366f1" />
              <Text style={styles.loadingText}>Đang tải dữ liệu số liệu...</Text>
            </View>
          ) : !selectedShift ? (
            <View style={styles.emptyShiftBox}>
              <Ionicons name="briefcase-outline" size={56} color="#475569" />
              <Text style={styles.emptyShiftTitle}>Chưa có Công Việc nào đang mở</Text>
              <Text style={styles.emptyShiftDesc}>
                Bạn có thể tạo công việc mới để bắt đầu ghi nhận số lượng hoặc kiểm tra lại các ca đã hoàn thành.
              </Text>
              <TouchableOpacity
                onPress={() => setIsOpenJobModal(true)}
                style={styles.createBigBtn}
              >
                <Ionicons name="play" size={18} color="#fff" />
                <Text style={styles.createBigBtnText}>+ Tạo Công Việc Mới</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <FlatList
              data={displayedProducts}
              keyExtractor={item => item.id}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#6366f1" />}
              contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 100 }}
              ListEmptyComponent={
                <View style={styles.emptyListBox}>
                  <Text style={styles.emptyListText}>
                    {searchMode === 'pin'
                      ? 'Không tìm thấy sản phẩm nào trong kho.'
                      : 'Chưa có sản phẩm nào được ghim. Bấm vào icon "Nhập" đổi sang "Ghim" để thêm sản phẩm vào bàn làm việc!'}
                  </Text>
                </View>
              }
              renderItem={({ item, index }) => {
                const isPinned = pinnedProducts.some(p => p.id === item.id);
                const isAltRow = index % 2 === 1;
                const productUnits = getProductUnits(item);
                const currentUnit = getPreferredUnit(item);

                // Lấy tất cả các đơn vị đã phát sinh số liệu trong ca
                const activeUnits = productUnits.filter(u => {
                  const s = getProductCount(item.name, u);
                  return s.inQty > 0 || s.outQty > 0;
                });

                // Hiển thị tất cả các đơn vị có số liệu + đơn vị đang chọn (ưu tiên đơn vị Thùng)
                const displayUnits = Array.from(new Set([
                  ...(activeUnits.length > 0 ? activeUnits : [currentUnit]),
                  currentUnit,
                ]));

                return (
                  <View style={[styles.productCard, isAltRow ? styles.cardAmber : styles.cardIndigo]}>
                    {/* HÀNG TRÊN: STT, TÊN SẢN PHẨM, SKU, CON MẮT & NÚT GHIM */}
                    <View style={styles.cardTopRow}>
                      <View style={[styles.sttBadge, isAltRow ? styles.sttAmber : styles.sttIndigo]}>
                        <Text style={[styles.sttBadgeText, isAltRow ? styles.sttAmberText : styles.sttIndigoText]}>
                          {index + 1}
                        </Text>
                      </View>

                      <TouchableOpacity
                        onPress={() => handleOpenPad(item, currentUnit)}
                        style={styles.cardTitleCol}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.cardProductName} numberOfLines={2}>
                          {item.name}
                        </Text>
                        {item.sku ? (
                          <Text style={styles.cardProductSku}>{item.sku}</Text>
                        ) : null}
                      </TouchableOpacity>

                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <TouchableOpacity
                          onPress={() => {
                            setHistoryProduct(item);
                            setIsHistoryVisible(true);
                          }}
                          style={styles.cardEyeBtn}
                          accessibilityLabel="Xem lịch sử"
                        >
                          <Ionicons name="eye-outline" size={16} color="#94a3b8" />
                        </TouchableOpacity>

                        {searchMode === 'pin' && (
                          <TouchableOpacity
                            onPress={() => togglePin(item)}
                            style={[styles.pinToggleBtn, isPinned && styles.pinToggleBtnActive]}
                          >
                            <Ionicons
                              name={isPinned ? 'pin' : 'pin-outline'}
                              size={15}
                              color={isPinned ? '#fff' : '#94a3b8'}
                            />
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>

                    {/* HÀNG DƯỚI: DANH SÁCH CÁC ĐƠN VỊ TÍNH VÀ SỐ LIỆU TƯƠNG ỨNG */}
                    <View style={styles.cardUnitsList}>
                      {displayUnits.map(u => {
                        const uStats = getProductCount(item.name, u);
                        const isSelected = currentUnit === u;
                        return (
                          <TouchableOpacity
                            key={u}
                            onPress={() => {
                              setSelectedUnitMap(prev => ({ ...prev, [item.id]: u }));
                              handleOpenPad(item, u);
                            }}
                            style={[styles.unitRowPill, isSelected && styles.unitRowPillActive]}
                            activeOpacity={0.7}
                          >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Text style={[styles.unitRowName, isSelected && styles.unitRowNameActive]}>
                                {u}
                              </Text>
                              {isSelected && (
                                <View
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 3,
                                    backgroundColor: '#6366f1',
                                  }}
                                />
                              )}
                            </View>

                            <View style={styles.statsWrapper}>
                              <View style={[styles.statBadgeIn, uStats.inQty > 0 && styles.statBadgeInActive]}>
                                <Text style={[styles.statTextIn, uStats.inQty > 0 && styles.statTextInActive]}>
                                  Nhập: +{uStats.inQty}
                                </Text>
                              </View>
                              <Text style={styles.statDivider}>|</Text>
                              <View style={[styles.statBadgeOut, uStats.outQty > 0 && styles.statBadgeOutActive]}>
                                <Text style={[styles.statTextOut, uStats.outQty > 0 && styles.statTextOutActive]}>
                                  Xuất: -{uStats.outQty}
                                </Text>
                              </View>
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                );
              }}
              ListFooterComponent={
                <View style={styles.footerReportWrapper}>
                  {/* Banner trạng thái đang chờ chốt ca tạm đa người dùng */}
                  {selectedShift?.summary_data?.pending_interim_close && (() => {
                    const pend = selectedShift.summary_data!.pending_interim_close!;
                    const confs = pend.confirmations || [];
                    const myId = user?.id ? String(user.id) : '';
                    const myName = (user?.full_name || user?.email || '').trim().toLowerCase();
                    const iDone = confs.some(
                      c =>
                        (myId && c.user_id && String(c.user_id) === myId) ||
                        (myName && (c.user_name || '').trim().toLowerCase() === myName)
                    );
                    return (
                      <TouchableOpacity
                        onPress={() => setIsInterimCloseModal(true)}
                        activeOpacity={0.8}
                        style={{
                          marginBottom: 8,
                          paddingHorizontal: 12,
                          paddingVertical: 10,
                          borderRadius: 12,
                          borderWidth: 1,
                          backgroundColor: iDone
                            ? 'rgba(16, 185, 129, 0.12)'
                            : 'rgba(245, 158, 11, 0.16)',
                          borderColor: iDone
                            ? 'rgba(16, 185, 129, 0.45)'
                            : 'rgba(245, 158, 11, 0.55)',
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '800',
                              color: iDone ? '#34d399' : '#fcd34d',
                            }}
                          >
                            {iDone
                              ? `✅ Bạn đã chốt tạm Đợt #${pend.sub_shift_number} (${confs.length} người đã chốt) — Đang chờ người khác`
                              : `⏳ Đợt #${pend.sub_shift_number} đang chờ bạn chốt (${confs.map(c => c.user_name).join(', ')} đã chốt)`}
                          </Text>
                          <Text style={{ fontSize: 10, color: '#cbd5e1', marginTop: 2 }}>
                            Chạm để xem chi tiết danh sách ai đã chốt / ai chưa chốt
                          </Text>
                        </View>
                        <View
                          style={{
                            backgroundColor: '#f59e0b',
                            paddingHorizontal: 10,
                            paddingVertical: 5,
                            borderRadius: 8,
                          }}
                        >
                          <Text style={{ fontSize: 11, fontWeight: '800', color: '#0f172a' }}>
                            Xem
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })()}

                  {/* Thanh chuyển đổi chế độ xem: Đợt hiện tại vs Toàn ca (Nếu có đợt chốt tạm) */}
                  {subShifts.length > 0 && (
                    <View style={styles.viewModeNoticeRow}>
                      <View style={styles.viewModeNoticeLeft}>
                        <Ionicons name="time-outline" size={14} color="#f59e0b" />
                        <Text style={styles.viewModeNoticeText}>
                          {viewMode === 'sub-shift'
                            ? `Đang xem: Đợt #${subShifts.length + 1} (sau chốt tạm)`
                            : `Đang xem: Toàn ca (${allJournals.length} lượt)`}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => setViewMode(prev => (prev === 'sub-shift' ? 'shift' : 'sub-shift'))}
                        style={styles.viewModeToggleBtn}
                      >
                        <Text style={styles.viewModeToggleBtnText}>
                          {viewMode === 'sub-shift' ? 'Xem toàn ca' : 'Xem đợt này'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* ── CARD BÁO CÁO CUỐI TRANG: 2 TAB ── */}
                  <View style={styles.reportCard}>
                    {/* Header 2 Tab */}
                    <View style={styles.reportTabHeader}>
                      <TouchableOpacity
                        onPress={() => setReportTab('feed')}
                        style={[styles.reportTabBtn, reportTab === 'feed' && styles.reportTabBtnActive]}
                      >
                        <Ionicons
                          name="time"
                          size={15}
                          color={reportTab === 'feed' ? '#6366f1' : '#94a3b8'}
                        />
                        <Text style={[styles.reportTabBtnText, reportTab === 'feed' && styles.reportTabBtnTextActive]}>
                          Lịch sử đợt ({allJournals.length})
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => setReportTab('summary')}
                        style={[styles.reportTabBtn, reportTab === 'summary' && styles.reportTabBtnActive]}
                      >
                        <Ionicons
                          name="bar-chart"
                          size={15}
                          color={reportTab === 'summary' ? '#6366f1' : '#94a3b8'}
                        />
                        <Text style={[styles.reportTabBtnText, reportTab === 'summary' && styles.reportTabBtnTextActive]}>
                          Báo cáo
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => setReportTab('reconcile')}
                        style={[styles.reportTabBtn, reportTab === 'reconcile' && styles.reportTabBtnActive]}
                      >
                        <Ionicons
                          name="checkmark-done-circle"
                          size={15}
                          color={reportTab === 'reconcile' ? '#f59e0b' : '#94a3b8'}
                        />
                        <Text style={[styles.reportTabBtnText, reportTab === 'reconcile' && { color: '#fbbf24' }]}>
                          Tham chiếu
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* ── NỘI DUNG TAB 1: LỊCH SỬ ĐỢT ── */}
                    {reportTab === 'feed' && (
                      <View style={styles.feedTabContainer}>
                        {/* 3 Nút lọc: Tất cả / Nhập / Xuất */}
                        <View style={styles.filterPillsRow}>
                          <TouchableOpacity
                            onPress={() => setJournalFilter('all')}
                            style={[styles.filterPill, journalFilter === 'all' && styles.filterPillAllActive]}
                          >
                            <Text style={[styles.filterPillText, journalFilter === 'all' && styles.filterPillTextWhite]}>
                              Tất cả ({allJournals.length})
                            </Text>
                          </TouchableOpacity>

                          <TouchableOpacity
                            onPress={() => setJournalFilter('in')}
                            style={[styles.filterPill, journalFilter === 'in' && styles.filterPillInActive]}
                          >
                            <Text style={[styles.filterPillArrow, journalFilter === 'in' ? styles.filterPillTextWhite : { color: '#4ade80' }]}>
                              ↙
                            </Text>
                            <Text style={[styles.filterPillText, journalFilter === 'in' ? styles.filterPillTextWhite : { color: '#4ade80' }]}>
                              Nhập ({allJournals.filter(l => l.to_department === 'Kho' || (l.notes && l.notes.includes('Nhập kho'))).length})
                            </Text>
                          </TouchableOpacity>

                          <TouchableOpacity
                            onPress={() => setJournalFilter('out')}
                            style={[styles.filterPill, journalFilter === 'out' && styles.filterPillOutActive]}
                          >
                            <Text style={[styles.filterPillArrow, journalFilter === 'out' ? styles.filterPillTextWhite : { color: '#f87171' }]}>
                              ↗
                            </Text>
                            <Text style={[styles.filterPillText, journalFilter === 'out' ? styles.filterPillTextWhite : { color: '#f87171' }]}>
                              Xuất ({allJournals.filter(l => l.to_department !== 'Kho' && (!l.notes || !l.notes.includes('Nhập kho'))).length})
                            </Text>
                          </TouchableOpacity>
                        </View>

                        {allJournals.length === 0 ? (
                          <View style={styles.emptyFeedBox}>
                            <Ionicons name="document-text-outline" size={32} color="#475569" />
                            <Text style={styles.emptyFeedText}>Chưa có lượt ghi nhận nào trong ca này.</Text>
                          </View>
                        ) : (
                          <View style={styles.journalListContainer}>
                            {/* 1. Nếu có các đợt chốt tạm: hiển thị các khối chốt tạm trước */}
                            {subShifts.map((ss, sIdx) => {
                              const isExpanded = !!expandedSubShifts[ss.id];
                              const ssFrom = toTimestamp(ss.from_time);
                              const ssTo = toTimestamp(ss.to_time);
                              const prevTo = sIdx > 0 ? toTimestamp(subShifts[sIdx - 1].to_time) : ssFrom;
                              const ssRecords = allJournals.filter(l => {
                                const lTime = toTimestamp(l.sent_at);
                                return sIdx === 0
                                  ? (lTime >= ssFrom && lTime <= ssTo)
                                  : (lTime > prevTo && lTime <= ssTo);
                              });
                              const filteredSubRecords = ssRecords.filter(l => {
                                const isImport = l.to_department === 'Kho' || (l.notes && l.notes.includes('Nhập kho'));
                                if (journalFilter === 'in') return isImport;
                                if (journalFilter === 'out') return !isImport;
                                return true;
                              });

                              const ssTotalIn = ssRecords.filter(l => l.to_department === 'Kho' || (l.notes && l.notes.includes('Nhập kho'))).reduce((s, l) => s + (Number(l.quantity_sent) || 0), 0);
                              const ssTotalOut = ssRecords.filter(l => l.to_department !== 'Kho' && (!l.notes || !l.notes.includes('Nhập kho'))).reduce((s, l) => s + (Number(l.quantity_sent) || 0), 0);

                              return (
                                <View key={ss.id} style={styles.subShiftCard}>
                                  <TouchableOpacity
                                    onPress={() => toggleSubShiftExpand(ss.id)}
                                    style={styles.subShiftCardHeader}
                                    activeOpacity={0.7}
                                  >
                                    <View style={{ flex: 1 }}>
                                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <Text style={styles.subShiftCardTitle}>
                                          Lần chốt ca tạm #{ss.sub_shift_number}
                                        </Text>
                                        <View style={styles.subShiftCountBadge}>
                                          <Text style={styles.subShiftCountBadgeText}>
                                            {ssRecords.length} đợt
                                          </Text>
                                        </View>
                                      </View>
                                      <Text style={styles.subShiftRangeText}>
                                        <Ionicons name="time-outline" size={11} color="#94a3b8" /> {formatCompactRange(ss.from_time, ss.to_time)}
                                      </Text>
                                    </View>

                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                      <View style={styles.subShiftSumBadge}>
                                        <Text style={styles.subShiftSumIn}>+{ssTotalIn}</Text>
                                        <Text style={styles.subShiftSumDivider}>|</Text>
                                        <Text style={styles.subShiftSumOut}>-{ssTotalOut}</Text>
                                      </View>
                                      <Ionicons
                                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                                        size={16}
                                        color="#94a3b8"
                                      />
                                    </View>
                                  </TouchableOpacity>

                                  {isExpanded && (
                                    <View style={styles.subShiftDetails}>
                                      {filteredSubRecords.length === 0 ? (
                                        <Text style={styles.emptySubRecordsText}>
                                          Không có lượt {journalFilter === 'in' ? 'Nhập' : 'Xuất'} nào trong đợt này.
                                        </Text>
                                      ) : (
                                        filteredSubRecords.map(record => {
                                          const isImport = record.to_department === 'Kho' || (record.notes && record.notes.includes('Nhập kho'));
                                          const userNote = cleanUserNotes(record.notes);
                                          const rawUnit = record.unit || 'Thùng (20kg)';
                                          const stdUnit = standardizeUnitLabel(rawUnit);
                                          return (
                                            <View key={record.id} style={styles.journalRow}>
                                              {/* Icon Nhập/Xuất tròn */}
                                              <View style={[styles.arrowCircle, isImport ? styles.arrowCircleIn : styles.arrowCircleOut]}>
                                                <Text style={[styles.arrowCircleText, isImport ? styles.arrowCircleTextIn : styles.arrowCircleTextOut]}>
                                                  {isImport ? '↙' : '↗'}
                                                </Text>
                                              </View>

                                              {/* Nội dung chính */}
                                              <View style={{ flex: 1, minWidth: 0 }}>
                                                <View style={styles.journalRowTop}>
                                                  <Text style={styles.journalItemName} numberOfLines={2}>
                                                    {record.item_name}
                                                  </Text>
                                                  <View style={styles.rowActions}>
                                                    <TouchableOpacity
                                                      onPress={() => {
                                                        setJournalTargetForImages({
                                                          id: record.id,
                                                          itemName: record.item_name,
                                                          quantity: record.quantity_sent,
                                                          unit: stdUnit,
                                                          direction: isImport ? 'in' : 'out',
                                                        });
                                                        setIsImagesModalVisible(true);
                                                      }}
                                                      style={styles.actionPencilBtn}
                                                      accessibilityLabel="Ảnh đợt này"
                                                    >
                                                      <Ionicons name="camera-outline" size={14} color="#38bdf8" />
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                      onPress={() => handleStartEdit(record)}
                                                      style={styles.actionPencilBtn}
                                                    >
                                                      <Ionicons name="pencil" size={13} color="#94a3b8" />
                                                    </TouchableOpacity>
                                                    <TouchableOpacity
                                                      onPress={() => handleDeleteJournal(record.id, record.item_name)}
                                                      style={styles.actionTrashBtn}
                                                    >
                                                      <Ionicons name="trash-outline" size={13} color="#f43f5e" />
                                                    </TouchableOpacity>
                                                  </View>
                                                </View>

                                                <View style={styles.journalRowMid}>
                                                  <View style={[styles.qtyBadge, isImport ? styles.qtyBadgeIn : styles.qtyBadgeOut]}>
                                                    <Text style={[styles.qtyBadgeText, isImport ? styles.qtyBadgeTextIn : styles.qtyBadgeTextOut]}>
                                                      {isImport ? `+${record.quantity_sent}` : `-${record.quantity_sent}`} {stdUnit}
                                                    </Text>
                                                  </View>
                                                </View>

                                                <Text style={styles.journalMetaText}>
                                                  {formatDateTime(record.sent_at)} • {record.sent_by_name || 'Nhân viên'}
                                                  {userNote ? ` • 💬 ${userNote}` : ''}
                                                </Text>
                                              </View>
                                            </View>
                                          );
                                        })
                                      )}
                                      <View style={styles.subShiftFooterInfo}>
                                        <Text style={styles.subShiftFooterText}>
                                          👤 Người chốt: <Text style={{ color: '#f8fafc', fontWeight: '700' }}>{ss.closed_by_name || 'Nhân viên'}</Text>
                                          {ss.notes ? ` • 💬 "${ss.notes}"` : ''}
                                        </Text>
                                      </View>
                                    </View>
                                  )}
                                </View>
                              );
                            })}

                            {/* 2. Đợt hiện tại (các lượt bấm sau lần chốt tạm gần nhất, hoặc toàn bộ nếu chưa chốt tạm) */}
                            {(() => {
                              const latestSub = subShifts.length > 0
                                ? subShifts.reduce((max, s) => toTimestamp(s.to_time) > toTimestamp(max.to_time) ? s : max, subShifts[0])
                                : null;
                              const latestTime = toTimestamp(latestSub?.to_time);
                              const currentBatch = latestTime > 0
                                ? allJournals.filter(l => toTimestamp(l.sent_at) > latestTime)
                                : allJournals;
                              const filteredCurrent = currentBatch.filter(l => {
                                const isImport = l.to_department === 'Kho' || (l.notes && l.notes.includes('Nhập kho'));
                                if (journalFilter === 'in') return isImport;
                                if (journalFilter === 'out') return !isImport;
                                return true;
                              });

                              if (subShifts.length > 0 && currentBatch.length === 0) {
                                return (
                                  <View style={styles.currentBatchEmptyBox}>
                                    <Text style={styles.currentBatchEmptyText}>
                                      Đợt mới chưa có lượt bấm nào (đã reset về 0 sau Chốt ca tạm #{subShifts.length}).
                                    </Text>
                                  </View>
                                );
                              }

                              return filteredCurrent.map(record => {
                                const isImport = record.to_department === 'Kho' || (record.notes && record.notes.includes('Nhập kho'));
                                const userNote = cleanUserNotes(record.notes);
                                const rawUnit = record.unit || 'Thùng (20kg)';
                                const stdUnit = standardizeUnitLabel(rawUnit);
                                return (
                                  <View key={record.id} style={styles.journalRow}>
                                    {/* Icon Nhập/Xuất tròn */}
                                    <View style={[styles.arrowCircle, isImport ? styles.arrowCircleIn : styles.arrowCircleOut]}>
                                      <Text style={[styles.arrowCircleText, isImport ? styles.arrowCircleTextIn : styles.arrowCircleTextOut]}>
                                        {isImport ? '↙' : '↗'}
                                      </Text>
                                    </View>

                                    {/* Nội dung chính */}
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                      <View style={styles.journalRowTop}>
                                        <Text style={styles.journalItemName} numberOfLines={2}>
                                          {record.item_name}
                                        </Text>
                                        <View style={styles.rowActions}>
                                          <TouchableOpacity
                                            onPress={() => {
                                              setJournalTargetForImages({
                                                id: record.id,
                                                itemName: record.item_name,
                                                quantity: record.quantity_sent,
                                                unit: stdUnit,
                                                direction: isImport ? 'in' : 'out',
                                              });
                                              setIsImagesModalVisible(true);
                                            }}
                                            style={styles.actionPencilBtn}
                                            accessibilityLabel="Ảnh đợt này"
                                          >
                                            <Ionicons name="camera-outline" size={14} color="#38bdf8" />
                                          </TouchableOpacity>
                                          <TouchableOpacity
                                            onPress={() => handleStartEdit(record)}
                                            style={styles.actionPencilBtn}
                                            accessibilityLabel="Sửa"
                                          >
                                            <Ionicons name="pencil" size={13} color="#94a3b8" />
                                          </TouchableOpacity>
                                          <TouchableOpacity
                                            onPress={() => handleDeleteJournal(record.id, record.item_name)}
                                            style={styles.actionTrashBtn}
                                            accessibilityLabel="Xóa"
                                          >
                                            <Ionicons name="trash-outline" size={13} color="#f43f5e" />
                                          </TouchableOpacity>
                                        </View>
                                      </View>

                                      <View style={styles.journalRowMid}>
                                        <View style={[styles.qtyBadge, isImport ? styles.qtyBadgeIn : styles.qtyBadgeOut]}>
                                          <Text style={[styles.qtyBadgeText, isImport ? styles.qtyBadgeTextIn : styles.qtyBadgeTextOut]}>
                                            {isImport ? `+${record.quantity_sent}` : `-${record.quantity_sent}`} {stdUnit}
                                          </Text>
                                        </View>
                                      </View>

                                      <Text style={styles.journalMetaText}>
                                        {formatDateTime(record.sent_at)} • {record.sent_by_name || 'Nhân viên'}
                                        {userNote ? ` • 💬 ${userNote}` : ''}
                                      </Text>
                                    </View>
                                  </View>
                                );
                              });
                            })()}
                          </View>
                        )}
                      </View>
                    )}

                    {/* ── NỘI DUNG TAB 2: BÁO CÁO TỔNG HỢP (THU & MỞ RỘNG THEO CARD, MẶC ĐỊNH LÀ THU) ── */}
                    {reportTab === 'summary' && (
                      <View style={styles.summaryTabContainer}>
                        {/* 1. Chi tiết theo Mặt hàng */}
                        {(() => {
                          const prodMap: Record<string, { name: string; unit: string; inQty: number; outQty: number }> = {};
                          allJournals.forEach(j => {
                            const name = (j.item_name || '').trim();
                            if (!name) return;
                            const rawUnit = (j.unit || 'Thùng (20kg)').trim();
                            const u = standardizeUnitLabel(rawUnit);
                            const key = `${name}___${u}`;
                            if (!prodMap[key]) prodMap[key] = { name, unit: u, inQty: 0, outQty: 0 };
                            const isImport = j.to_department === 'Kho' || (j.notes && j.notes.includes('Nhập kho'));
                            const qty = Number(j.quantity_sent || (j as any).result_quantity || 0);
                            if (isImport) prodMap[key].inQty += qty;
                            else prodMap[key].outQty += qty;
                          });
                          const list = Object.values(prodMap);

                          return (
                            <View style={styles.accordionCard}>
                              <TouchableOpacity
                                onPress={() => setExpandProductSummary(prev => !prev)}
                                style={styles.accordionHeader}
                                activeOpacity={0.7}
                              >
                                <View style={styles.accordionHeaderLeft}>
                                  <Ionicons name="cube-outline" size={16} color="#38bdf8" />
                                  <Text style={styles.accordionTitle}>1. Chi tiết theo Mặt Hàng</Text>
                                  <View style={styles.accordionBadge}>
                                    <Text style={styles.accordionBadgeText}>{list.length} SP</Text>
                                  </View>
                                </View>
                                <Ionicons
                                  name={expandProductSummary ? 'chevron-up' : 'chevron-down'}
                                  size={18}
                                  color="#94a3b8"
                                />
                              </TouchableOpacity>

                              {expandProductSummary && (
                                <View style={styles.accordionBody}>
                                  {list.length === 0 ? (
                                    <Text style={styles.summaryEmptyText}>Chưa có phát sinh số liệu trong ca.</Text>
                                  ) : (
                                    <View style={styles.summaryTable}>
                                      <View style={styles.summaryTableHeader}>
                                        <Text style={[styles.summaryTh, { flex: 3 }]}>Sản phẩm / ĐVT</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: colors.success }]}>Nhập (+)</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: colors.danger }]}>Xuất (-)</Text>
                                      </View>
                                      {list.map(row => (
                                        <View key={`${row.name}_${row.unit}`} style={styles.summaryTableRow}>
                                          <View style={{ flex: 3 }}>
                                            <Text style={[styles.summaryTd, { fontWeight: '700', color: colors.text }]} numberOfLines={2}>
                                              {row.name}
                                            </Text>
                                            <Text style={{ fontSize: 10, color: colors.primarySoftText, fontWeight: '800' }}>
                                              {row.unit}
                                            </Text>
                                          </View>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: colors.success, fontWeight: '800' }]}>+{row.inQty}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: colors.danger, fontWeight: '800' }]}>-{row.outQty}</Text>
                                        </View>
                                      ))}
                                    </View>
                                  )}
                                </View>
                              )}
                            </View>
                          );
                        })()}

                        {/* 2. Tổng hợp theo Đơn vị tính */}
                        {(() => {
                          const unitMap: Record<string, { unit: string; inQty: number; outQty: number }> = {};
                          allJournals.forEach(j => {
                            const rawUnit = (j.unit || 'Thùng (20kg)').trim();
                            const u = standardizeUnitLabel(rawUnit);
                            if (!unitMap[u]) unitMap[u] = { unit: u, inQty: 0, outQty: 0 };
                            const isImport = j.to_department === 'Kho' || (j.notes && j.notes.includes('Nhập kho'));
                            const qty = Number(j.quantity_sent || (j as any).result_quantity || 0);
                            if (isImport) unitMap[u].inQty += qty;
                            else unitMap[u].outQty += qty;
                          });
                          const list = Object.values(unitMap);

                          return (
                            <View style={styles.accordionCard}>
                              <TouchableOpacity
                                onPress={() => setExpandUnitSummary(prev => !prev)}
                                style={styles.accordionHeader}
                                activeOpacity={0.7}
                              >
                                <View style={styles.accordionHeaderLeft}>
                                  <Ionicons name="layers-outline" size={16} color="#818cf8" />
                                  <Text style={styles.accordionTitle}>2. Tổng hợp theo Đơn Vị Tính</Text>
                                  <View style={styles.accordionBadge}>
                                    <Text style={styles.accordionBadgeText}>{list.length} ĐVT</Text>
                                  </View>
                                </View>
                                <Ionicons
                                  name={expandUnitSummary ? 'chevron-up' : 'chevron-down'}
                                  size={18}
                                  color="#94a3b8"
                                />
                              </TouchableOpacity>

                              {expandUnitSummary && (
                                <View style={styles.accordionBody}>
                                  {list.length === 0 ? (
                                    <Text style={styles.summaryEmptyText}>Chưa có phát sinh số liệu trong ca.</Text>
                                  ) : (
                                    <View style={styles.summaryTable}>
                                      <View style={styles.summaryTableHeader}>
                                        <Text style={[styles.summaryTh, { flex: 2 }]}>Đơn vị</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: colors.success }]}>Nhập (+)</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: colors.danger }]}>Xuất (-)</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: colors.primary }]}>Tồn ca</Text>
                                      </View>
                                      {list.map(row => (
                                        <View key={row.unit} style={styles.summaryTableRow}>
                                          <Text style={[styles.summaryTd, { flex: 2, fontWeight: '700', color: colors.text }]}>{row.unit}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: colors.success, fontWeight: '800' }]}>+{row.inQty}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: colors.danger, fontWeight: '800' }]}>-{row.outQty}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: colors.primary, fontWeight: '800' }]}>{row.inQty - row.outQty}</Text>
                                        </View>
                                      ))}
                                    </View>
                                  )}
                                </View>
                              )}
                            </View>
                          );
                        })()}

                        {/* 3. Lịch sử các lần chốt tạm */}
                        <View style={styles.accordionCard}>
                          <TouchableOpacity
                            onPress={() => setExpandSubShiftsSummary(prev => !prev)}
                            style={styles.accordionHeader}
                            activeOpacity={0.7}
                          >
                            <View style={styles.accordionHeaderLeft}>
                              <Ionicons name="time-outline" size={16} color="#f59e0b" />
                              <Text style={styles.accordionTitle}>3. Các Lần Chốt Ca Tạm</Text>
                              <View style={[styles.accordionBadge, { backgroundColor: colors.amberSoftBg }]}>
                                <Text style={[styles.accordionBadgeText, { color: colors.amberSoftText }]}>{subShifts.length} Đợt</Text>
                              </View>
                            </View>
                            <Ionicons
                              name={expandSubShiftsSummary ? 'chevron-up' : 'chevron-down'}
                              size={18}
                              color="#94a3b8"
                            />
                          </TouchableOpacity>

                          {expandSubShiftsSummary && (
                            <View style={styles.accordionBody}>
                              {subShifts.length === 0 ? (
                                <Text style={styles.summaryEmptyText}>Chưa có lần chốt ca tạm nào trong ca này.</Text>
                              ) : (
                                <View style={styles.subShiftSummaryBox}>
                                  {subShifts.map(ss => (
                                    <View key={ss.id} style={styles.subShiftSummaryRow}>
                                      <View style={{ flex: 1 }}>
                                        <Text style={styles.subShiftSummaryTitle}>
                                          Đợt #{ss.sub_shift_number}: {ss.notes || 'Chốt tạm'}
                                        </Text>
                                        <Text style={styles.subShiftSummaryTime}>
                                          {formatCompactRange(ss.from_time, ss.to_time)} • Bởi: {ss.closed_by_name || 'Nhân viên'}
                                        </Text>
                                      </View>
                                    </View>
                                  ))}
                                </View>
                              )}
                            </View>
                          )}
                        </View>
                      </View>
                    )}

                    {/* ── NỘI DUNG TAB 3: THAM CHIẾU SỐ ĐẦU - SỐ ĐUÔI ── */}
                    {reportTab === 'reconcile' && (
                      <ReconcileTabView
                        allJournals={allJournals}
                        pinnedProducts={pinnedProducts}
                        reconcileMap={reconcileMap}
                        setReconcileMap={setReconcileMap}
                        reconcileImagesMap={reconcileImagesMap}
                        uploadingReconcileKey={uploadingReconcileKey}
                        savingReconcile={savingReconcile}
                        expandedReconcileKeys={expandedReconcileKeys}
                        setExpandedReconcileKeys={setExpandedReconcileKeys}
                        standardizeUnitLabel={standardizeUnitLabel}
                        onSaveReconcile={handleSaveReconcile}
                        onPickReconcileImage={handlePickReconcileImage}
                        onPreviewImage={setPreviewReconcileImage}
                      />
                    )}
                  </View>
                </View>
              }
            />
          )}
        </>
      ) : (
        /* ── TAB ĐÃ HOÀN THÀNH ── */
        <View style={{ flex: 1 }}>
          {/* Thanh chuyển chế độ: Từng CV | Theo Ngày | Tùy Chọn */}
          <View style={styles.doneModeBar}>
            <TouchableOpacity
              style={[styles.doneModeBtn, doneMode === 'single' && styles.doneModeBtnActive]}
              onPress={() => setDoneMode('single')}
              activeOpacity={0.7}
            >
              <Ionicons
                name="document-text-outline"
                size={14}
                color={doneMode === 'single' ? '#818cf8' : '#94a3b8'}
              />
              <Text style={[styles.doneModeBtnText, doneMode === 'single' && styles.doneModeBtnTextActive]}>
                Từng CV ({pastShifts.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.doneModeBtn, doneMode === 'daily' && styles.doneModeBtnActive]}
              onPress={() => setDoneMode('daily')}
              activeOpacity={0.7}
            >
              <Ionicons
                name="calendar-outline"
                size={14}
                color={doneMode === 'daily' ? '#818cf8' : '#94a3b8'}
              />
              <Text style={[styles.doneModeBtnText, doneMode === 'daily' && styles.doneModeBtnTextActive]}>
                Theo Ngày
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.doneModeBtn, doneMode === 'product' && styles.doneModeBtnActive]}
              onPress={() => setDoneMode('product')}
              activeOpacity={0.7}
            >
              <Ionicons
                name="cube-outline"
                size={14}
                color={doneMode === 'product' ? '#818cf8' : '#94a3b8'}
              />
              <Text style={[styles.doneModeBtnText, doneMode === 'product' && styles.doneModeBtnTextActive]}>
                Theo SP
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.doneModeBtn, doneMode === 'custom' && styles.doneModeBtnActive]}
              onPress={() => setDoneMode('custom')}
              activeOpacity={0.7}
            >
              <Ionicons
                name="checkbox-outline"
                size={14}
                color={doneMode === 'custom' ? '#818cf8' : '#94a3b8'}
              />
              <Text style={[styles.doneModeBtnText, doneMode === 'custom' && styles.doneModeBtnTextActive]}>
                Tùy Chọn {selectedCustomShiftIds.length > 0 ? `(${selectedCustomShiftIds.length})` : ''}
              </Text>
            </TouchableOpacity>
          </View>

          {/* ── CHẾ ĐỘ 1: TỪNG CÔNG VIỆC ── */}
          {doneMode === 'single' && (
            <View style={{ flex: 1 }}>
              {/* Ô TÌM KIẾM CÔNG VIỆC */}
              <View style={styles.customSearchBar}>
                <Ionicons name="search" size={15} color="#818cf8" />
                <TextInput
                  style={styles.customSearchInput}
                  value={doneSearchQuery}
                  onChangeText={setDoneSearchQuery}
                  placeholder="Tìm tên công việc, người làm, loại phiếu..."
                  placeholderTextColor="#64748b"
                />
                {doneSearchQuery ? (
                  <TouchableOpacity onPress={() => setDoneSearchQuery('')} style={styles.doneClearSearchBtn}>
                    <Ionicons name="close-circle" size={16} color="#94a3b8" />
                  </TouchableOpacity>
                ) : null}
              </View>

              <FlatList
                data={filteredPastShifts}
                keyExtractor={item => item.id}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#6366f1" />}
                contentContainerStyle={{ padding: 12, paddingBottom: 100 }}
                ListEmptyComponent={
                  <View style={styles.centerBox}>
                    <Text style={{ color: '#64748b', fontSize: 13 }}>
                      {doneSearchQuery.trim()
                        ? `Không tìm thấy công việc nào khớp với "${doneSearchQuery}".`
                        : 'Chưa có công việc nào hoàn thành.'}
                    </Text>
                  </View>
                }
                renderItem={({ item }) => {
                  const name = item.summary_data?.job_name || item.notes || 'Công việc';
                  const closeTime = item.closed_at ? new Date(item.closed_at).toLocaleDateString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '-';
                  const orderType = item.summary_data?.order_type_name;
                  const recordsCount = item.summary_data?.total_records || 0;

                  return (
                    <TouchableOpacity
                      style={styles.doneCard}
                      onPress={() => handleOpenPastShiftDetail(item)}
                      activeOpacity={0.7}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={styles.doneJobName} numberOfLines={1}>{name}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <View style={styles.doneBadge}>
                            <Text style={styles.doneBadgeText}>Hoàn thành</Text>
                          </View>
                          <Ionicons name="chevron-forward" size={16} color="#94a3b8" />
                        </View>
                      </View>

                      <View style={{ marginTop: 6, gap: 3 }}>
                        {isOvernightShift(item) && (
                          <View style={styles.overnightBadge}>
                            <Ionicons name="moon" size={10} color="#fbbf24" />
                            <Text style={styles.overnightBadgeText}>
                              Đóng ca vào ngày hôm sau ({formatDateTime(item.closed_at)})
                            </Text>
                          </View>
                        )}
                        <Text style={styles.doneDetailText}>
                          <Ionicons name="time-outline" size={12} color="#94a3b8" /> Đóng lúc: {closeTime} • Bởi: {item.closed_by_name || 'Nhân viên'}
                        </Text>
                        {orderType && (
                          <Text style={[styles.doneDetailText, { color: '#818cf8', fontWeight: '700' }]}>
                            <Ionicons name="document-text-outline" size={12} color="#818cf8" /> Loại phiếu: {item.summary_data?.order_type_code ? `${item.summary_data.order_type_code} - ` : ''}{orderType}
                          </Text>
                        )}
                        <Text style={styles.doneDetailText}>
                          <Ionicons name="layers-outline" size={12} color="#94a3b8" /> Tổng phát sinh: {recordsCount} lượt (Bấm để xem chi tiết)
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                }}
              />
            </View>
          )}

          {/* ── CHẾ ĐỘ 2: BÁO CÁO THEO NGÀY / KHOẢNG NGÀY / NHIỀU NGÀY ── */}
          {doneMode === 'daily' && (
            <View style={{ flex: 1 }}>
              {/* Thanh chuyển chế độ: Tùy chọn nhiều ngày HOẶC Khoảng ngày */}
              <View style={styles.dailySubModeBar}>
                <TouchableOpacity
                  onPress={() => setDailyFilterType('multi')}
                  style={[styles.dailySubModeBtn, dailyFilterType === 'multi' && styles.dailySubModeBtnActive]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="calendar" size={13} color={dailyFilterType === 'multi' ? '#818cf8' : '#94a3b8'} />
                  <Text style={[styles.dailySubModeBtnText, dailyFilterType === 'multi' && styles.dailySubModeBtnTextActive]}>
                    Chọn nhiều ngày {selectedDates.length > 0 && `(${selectedDates.length})`}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => setDailyFilterType('range')}
                  style={[styles.dailySubModeBtn, dailyFilterType === 'range' && styles.dailySubModeBtnActive]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="swap-horizontal" size={13} color={dailyFilterType === 'range' ? '#818cf8' : '#94a3b8'} />
                  <Text style={[styles.dailySubModeBtnText, dailyFilterType === 'range' && styles.dailySubModeBtnTextActive]}>
                    Khoảng ngày (Từ - Đến)
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Điều khiển thời gian chi tiết */}
              {dailyFilterType === 'multi' ? (
                <View style={styles.dailyDateBar}>
                  {/* Hàng nút bấm nhanh */}
                  <View style={styles.dailyQuickActionsRow}>
                    <Text style={styles.dailyQuickLabel}>
                      Bấm ngày để chọn/bỏ chọn:
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                      <TouchableOpacity
                        onPress={() => setSelectedDates(availableDates.map(d => d.dateKey))}
                        style={styles.dailyQuickBtn}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.dailyQuickBtnText}>Tất cả ({availableDates.length})</Text>
                      </TouchableOpacity>
                      {availableDates.length > 0 && (
                        <TouchableOpacity
                          onPress={() => setSelectedDates([availableDates[0].dateKey])}
                          style={styles.dailyQuickBtn}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.dailyQuickBtnText}>Gần nhất</Text>
                        </TouchableOpacity>
                      )}
                      {/* Nút Thêm ngày khác mở Modal Lịch */}
                      <TouchableOpacity
                        onPress={() => {
                          setCalendarTarget('multi');
                          setIsCalendarModalVisible(true);
                        }}
                        style={[styles.dailyQuickBtn, { backgroundColor: '#4f46e5', borderColor: '#6366f1', flexDirection: 'row', alignItems: 'center', gap: 4 }]}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="calendar" size={11} color="#fff" />
                        <Text style={[styles.dailyQuickBtnText, { color: '#fff', fontWeight: '800' }]}>+ Thêm ngày</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Thanh cuộn chọn nhiều ngày */}
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingVertical: 4 }}
                  >
                    {/* Thẻ Thêm ngày luôn nằm đầu danh sách để bấm ngay */}
                    <TouchableOpacity
                      onPress={() => {
                        setCalendarTarget('multi');
                        setIsCalendarModalVisible(true);
                      }}
                      style={[styles.datePill, { borderColor: '#818cf8', borderStyle: 'dashed' }]}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="add-circle" size={14} color="#818cf8" />
                      <Text style={[styles.datePillText, { color: '#818cf8', fontWeight: '800' }]}>
                        + Thêm ngày
                      </Text>
                    </TouchableOpacity>

                    {/* Các ngày người dùng tự chọn từ lịch ngoài danh sách availableDates */}
                    {selectedDates
                      .filter(d => !availableDates.some(ad => ad.dateKey === d))
                      .map(d => (
                        <TouchableOpacity
                          key={d}
                          onPress={() => toggleSelectDate(d)}
                          style={[styles.datePill, styles.datePillActive]}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="checkmark-circle" size={13} color="#fff" />
                          <Text style={[styles.datePillText, styles.datePillTextActive]}>
                            {formatDateDisplay(d)}
                          </Text>
                          <View style={[styles.datePillBadge, styles.datePillBadgeActive]}>
                            <Text style={[styles.datePillBadgeText, styles.datePillBadgeTextActive]}>
                              Tùy chọn
                            </Text>
                          </View>
                        </TouchableOpacity>
                      ))}

                    {/* Danh sách các ngày có dữ liệu phát sinh */}
                    {availableDates.map(d => {
                      const isSelected = selectedDates.includes(d.dateKey);
                      return (
                        <TouchableOpacity
                          key={d.dateKey}
                          onPress={() => toggleSelectDate(d.dateKey)}
                          style={[styles.datePill, isSelected && styles.datePillActive]}
                          activeOpacity={0.7}
                        >
                          <Ionicons
                            name={isSelected ? 'checkmark-circle' : 'calendar-outline'}
                            size={13}
                            color={isSelected ? '#fff' : '#818cf8'}
                          />
                          <Text style={[styles.datePillText, isSelected && styles.datePillTextActive]}>
                            {d.label}
                          </Text>
                          <View style={[styles.datePillBadge, isSelected && styles.datePillBadgeActive]}>
                            <Text style={[styles.datePillBadgeText, isSelected && styles.datePillBadgeTextActive]}>
                              {d.count}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : (
                /* Chế độ Khoảng ngày Từ - Đến */
                <View style={styles.dailyRangeBar}>
                  <View style={styles.dailyRangeInputsRow}>
                    <View style={styles.dailyRangeInputBox}>
                      <Text style={styles.dailyRangeLabel}>Từ ngày (YYYY-MM-DD):</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <TextInput
                          style={[styles.dailyRangeInput, { flex: 1 }]}
                          value={dailyRangeFrom}
                          onChangeText={setDailyRangeFrom}
                          placeholder="2026-11-01"
                          placeholderTextColor="#64748b"
                        />
                        <TouchableOpacity
                          onPress={() => {
                            setCalendarTarget('from');
                            setIsCalendarModalVisible(true);
                          }}
                          style={styles.calendarPickIconBtn}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="calendar" size={16} color="#818cf8" />
                        </TouchableOpacity>
                      </View>
                    </View>
                    <Ionicons name="arrow-forward" size={14} color="#64748b" style={{ marginTop: 14 }} />
                    <View style={styles.dailyRangeInputBox}>
                      <Text style={styles.dailyRangeLabel}>Đến ngày (YYYY-MM-DD):</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <TextInput
                          style={[styles.dailyRangeInput, { flex: 1 }]}
                          value={dailyRangeTo}
                          onChangeText={setDailyRangeTo}
                          placeholder="2026-11-12"
                          placeholderTextColor="#64748b"
                        />
                        <TouchableOpacity
                          onPress={() => {
                            setCalendarTarget('to');
                            setIsCalendarModalVisible(true);
                          }}
                          style={styles.calendarPickIconBtn}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="calendar" size={16} color="#818cf8" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>

                  {/* Nút bấm nhanh cho khoảng ngày */}
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 6, paddingTop: 4 }}
                  >
                    {availableDates.length > 0 && (
                      <TouchableOpacity
                        onPress={() => {
                          const today = availableDates[0].dateKey;
                          setDailyRangeFrom(today);
                          setDailyRangeTo(today);
                        }}
                        style={styles.dailyQuickBtn}
                      >
                        <Text style={styles.dailyQuickBtnText}>Gần nhất</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      onPress={() => {
                        const today = new Date();
                        const past7 = new Date();
                        past7.setDate(today.getDate() - 6);
                        const format = (dt: Date) => dt.toISOString().split('T')[0];
                        setDailyRangeFrom(format(past7));
                        setDailyRangeTo(format(today));
                      }}
                      style={styles.dailyQuickBtn}
                    >
                      <Text style={styles.dailyQuickBtnText}>7 ngày qua</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        const today = new Date();
                        const past30 = new Date();
                        past30.setDate(today.getDate() - 29);
                        const format = (dt: Date) => dt.toISOString().split('T')[0];
                        setDailyRangeFrom(format(past30));
                        setDailyRangeTo(format(today));
                      }}
                      style={styles.dailyQuickBtn}
                    >
                      <Text style={styles.dailyQuickBtnText}>30 ngày qua</Text>
                    </TouchableOpacity>
                    {availableDates.slice(0, 4).map(d => (
                      <TouchableOpacity
                        key={d.dateKey}
                        onPress={() => {
                          setDailyRangeFrom(d.dateKey);
                          setDailyRangeTo(d.dateKey);
                        }}
                        style={styles.dailyQuickBtn}
                      >
                        <Text style={styles.dailyQuickBtnText}>{d.label.slice(0, 5)}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              {/* Nội dung báo cáo của ngày */}
              {loadingDailyJournals ? (
                <View style={styles.centerBox}>
                  <ActivityIndicator size="large" color="#6366f1" />
                  <Text style={styles.loadingText}>Đang tổng hợp {dailyReportTitle.toLowerCase()}...</Text>
                </View>
              ) : dailyShifts.length === 0 ? (
                <View style={styles.centerBox}>
                  <Text style={{ color: '#64748b', fontSize: 13 }}>Không có công việc nào trong mốc thời gian này.</Text>
                </View>
              ) : (
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ padding: 12, paddingBottom: 100 }}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#6366f1" />}
                >
                  {/* Card thông tin Header */}
                  <View style={styles.reportSummaryHeaderCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={styles.reportHeaderIconBox}>
                        <Ionicons name="bar-chart" size={18} color="#6366f1" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.reportHeaderTitle}>
                          {dailyReportTitle}
                        </Text>
                        <Text style={styles.reportHeaderSub}>
                          Tổng số: <Text style={{ color: '#818cf8', fontWeight: '700' }}>{dailyShifts.length} công việc</Text> • Phát sinh: <Text style={{ color: '#34d399', fontWeight: '700' }}>{dailyProductRows.length} mặt hàng</Text>
                        </Text>
                      </View>
                    </View>
                  </View>

                  {/* 1. Chi tiết theo Mặt hàng */}
                  <View style={styles.dailyCard}>
                    <TouchableOpacity
                      onPress={() => setExpandDailyProducts(prev => !prev)}
                      style={styles.dailyCardHeader}
                      activeOpacity={0.7}
                    >
                      <View style={styles.dailyCardHeaderLeft}>
                        <Ionicons name="cube-outline" size={16} color="#38bdf8" />
                        <Text style={styles.dailyCardTitle}>1. Chi tiết theo Mặt Hàng</Text>
                        <View style={styles.reportBadge}>
                          <Text style={styles.reportBadgeText}>{dailyProductRows.length} SP</Text>
                        </View>
                      </View>
                      <Ionicons
                        name={expandDailyProducts ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color="#94a3b8"
                      />
                    </TouchableOpacity>

                    {expandDailyProducts && (
                      <View style={styles.dailyCardBody}>
                        {dailyProductRows.length === 0 ? (
                          <Text style={styles.reportEmptyText}>Không có phát sinh sản phẩm nào trong ngày.</Text>
                        ) : (
                          <View style={styles.reportTable}>
                            <View style={styles.reportTableHeader}>
                              <Text style={[styles.reportTh, { width: 28, textAlign: 'center' }]}>STT</Text>
                              <Text style={[styles.reportTh, { flex: 3 }]}>Sản phẩm & Công việc</Text>
                              <Text style={[styles.reportTh, { flex: 1.1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                              <Text style={[styles.reportTh, { flex: 1.1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                              <Text style={[styles.reportTh, { width: 38, textAlign: 'right' }]}>Đợt</Text>
                            </View>
                            {dailyProductRows.map((r, idx) => (
                              <View key={`${r.product_name}___${r.unit}`} style={styles.reportTableRow}>
                                <Text style={[styles.reportTd, { width: 28, textAlign: 'center', color: '#64748b', fontSize: 11 }]}>
                                  {idx + 1}
                                </Text>
                                <View style={{ flex: 3, paddingRight: 4 }}>
                                  <Text style={styles.reportProdName} numberOfLines={2}>
                                    {r.product_name}
                                  </Text>
                                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, flexWrap: 'wrap', gap: 4 }}>
                                    <View style={styles.reportUnitBadge}>
                                      <Text style={styles.reportUnitBadgeText}>{r.unit}</Text>
                                    </View>
                                  </View>

                                  {/* Tên công việc phát sinh sản phẩm này */}
                                  <View style={styles.reportJobsList}>
                                    {r.jobs && r.jobs.length > 0 ? (
                                      r.jobs.map(j => (
                                        <View key={j.id} style={styles.reportJobItem}>
                                          <Ionicons name="briefcase-outline" size={10} color="#818cf8" />
                                          <Text style={styles.reportJobNameText} numberOfLines={1}>
                                            {j.name}
                                          </Text>
                                          {r.jobs.length > 1 && (
                                            <Text style={styles.reportJobQtyBreakdown}>
                                              ({j.in_qty > 0 ? `+${j.in_qty}` : '0'}{j.out_qty > 0 ? ` / -${j.out_qty}` : ''})
                                            </Text>
                                          )}
                                        </View>
                                      ))
                                    ) : (
                                      <Text style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic' }}>
                                        Từ chốt ca
                                      </Text>
                                    )}
                                  </View>
                                </View>

                                <Text style={[styles.reportTd, { flex: 1.1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>
                                  {r.in_qty > 0 ? `+${r.in_qty}` : '0'}
                                </Text>
                                <Text style={[styles.reportTd, { flex: 1.1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>
                                  {r.out_qty > 0 ? `-${r.out_qty}` : '0'}
                                </Text>
                                <Text style={[styles.reportTd, { width: 38, textAlign: 'right', color: '#cbd5e1', fontSize: 11 }]}>
                                  {r.count}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    )}
                  </View>

                  {/* 2. Tổng hợp theo Đơn vị tính */}
                  <View style={styles.dailyCard}>
                    <TouchableOpacity
                      onPress={() => setExpandDailyUnits(prev => !prev)}
                      style={styles.dailyCardHeader}
                      activeOpacity={0.7}
                    >
                      <View style={styles.dailyCardHeaderLeft}>
                        <Ionicons name="layers-outline" size={16} color="#818cf8" />
                        <Text style={styles.dailyCardTitle}>2. Tổng hợp theo Đơn Vị Tính</Text>
                        <View style={styles.reportBadge}>
                          <Text style={styles.reportBadgeText}>{dailyUnitRows.length} ĐVT</Text>
                        </View>
                      </View>
                      <Ionicons
                        name={expandDailyUnits ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color="#94a3b8"
                      />
                    </TouchableOpacity>

                    {expandDailyUnits && (
                      <View style={styles.dailyCardBody}>
                        {dailyUnitRows.length === 0 ? (
                          <Text style={styles.reportEmptyText}>Chưa có phát sinh số liệu theo ĐVT.</Text>
                        ) : (
                          <View style={styles.reportTable}>
                            <View style={styles.reportTableHeader}>
                              <Text style={[styles.reportTh, { flex: 2 }]}>Đơn vị tính</Text>
                              <Text style={[styles.reportTh, { flex: 1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                              <Text style={[styles.reportTh, { flex: 1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                              <Text style={[styles.reportTh, { width: 44, textAlign: 'right' }]}>Số đợt</Text>
                            </View>
                            {dailyUnitRows.map(u => (
                              <View key={u.unit} style={styles.reportTableRow}>
                                <Text style={[styles.reportTd, { flex: 2, fontWeight: '700', color: '#f8fafc' }]}>
                                  {u.unit}
                                </Text>
                                <Text style={[styles.reportTd, { flex: 1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>
                                  +{u.in_qty}
                                </Text>
                                <Text style={[styles.reportTd, { flex: 1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>
                                  -{u.out_qty}
                                </Text>
                                <Text style={[styles.reportTd, { width: 44, textAlign: 'right', color: '#cbd5e1' }]}>
                                  {u.count}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    )}
                  </View>

                  {/* 3. Danh sách các công việc trong ngày */}
                  <View style={styles.dailyCard}>
                    <TouchableOpacity
                      onPress={() => setExpandDailyShifts(prev => !prev)}
                      style={styles.dailyCardHeader}
                      activeOpacity={0.7}
                    >
                      <View style={styles.dailyCardHeaderLeft}>
                        <Ionicons name="folder-open-outline" size={16} color="#fbbf24" />
                        <Text style={styles.dailyCardTitle}>3. Danh sách các Công Việc</Text>
                        <View style={[styles.reportBadge, { backgroundColor: 'rgba(251, 191, 36, 0.2)' }]}>
                          <Text style={[styles.reportBadgeText, { color: '#fbbf24' }]}>{dailyShifts.length} CV</Text>
                        </View>
                      </View>
                      <Ionicons
                        name={expandDailyShifts ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color="#94a3b8"
                      />
                    </TouchableOpacity>

                    {expandDailyShifts && (
                      <View style={styles.dailyCardBody}>
                        {dailyShifts.map((s, sIdx) => {
                          const name = s.summary_data?.job_name || s.notes || `Công việc #${sIdx + 1}`;
                          const prodCount = Object.keys(s.summary_data?.products_summary || {}).length;
                          const recordsCount = s.summary_data?.total_records || 0;

                          return (
                            <View key={s.id} style={styles.reportShiftRow}>
                              <View style={{ flex: 1 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <Text style={styles.reportShiftName} numberOfLines={1}>
                                    {name}
                                  </Text>
                                  <View style={styles.reportShiftBadge}>
                                    <Text style={styles.reportShiftBadgeText}>Đã chốt</Text>
                                  </View>
                                  {isOvernightShift(s) && (
                                    <View style={styles.overnightBadge}>
                                      <Ionicons name="moon" size={9} color="#fbbf24" />
                                      <Text style={styles.overnightBadgeText}>
                                        Đóng ca ngày hôm sau ({formatDateTime(s.closed_at)})
                                      </Text>
                                    </View>
                                  )}
                                </View>
                                <Text style={styles.reportShiftMeta}>
                                  Chốt bởi: {s.closed_by_name || 'Nhân viên'} • {prodCount} SP • {recordsCount} đợt
                                </Text>
                              </View>

                              <TouchableOpacity
                                onPress={() => handleOpenPastShiftDetail(s)}
                                style={styles.reportShiftDetailBtn}
                                activeOpacity={0.7}
                              >
                                <Ionicons name="eye-outline" size={13} color="#818cf8" />
                                <Text style={styles.reportShiftDetailBtnText}>Chi tiết ca</Text>
                              </TouchableOpacity>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                </ScrollView>
              )}
            </View>
          )}

          {/* ── CHẾ ĐỘ 2.5: BÁO CÁO THEO SẢN PHẨM ── */}
          {doneMode === 'product' && (
            <View style={{ flex: 1 }}>
              {/* Thanh chọn mốc thời gian cuộn ngang */}
              <View style={styles.dailyDateBar}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 12, gap: 6, alignItems: 'center' }}
                >
                  {(
                    [
                      { id: 'today', label: 'Hôm nay', icon: 'today-outline' },
                      { id: 'yesterday', label: 'Hôm qua', icon: 'time-outline' },
                      { id: 'range', label: 'Khoảng ngày', icon: 'swap-horizontal' },
                      { id: '7days', label: '7 ngày qua', icon: 'calendar-outline' },
                      { id: '30days', label: '30 ngày', icon: 'calendar-outline' },
                      { id: 'all', label: 'Tất cả', icon: 'infinite-outline' },
                    ] as const
                  ).map(item => {
                    const isActive = prodTimeFilter === item.id;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        onPress={() => setProdTimeFilter(item.id)}
                        style={[styles.datePill, isActive && styles.datePillActive]}
                        activeOpacity={0.7}
                      >
                        <Ionicons
                          name={item.icon as any}
                          size={12}
                          color={isActive ? '#fff' : '#818cf8'}
                        />
                        <Text style={[styles.datePillText, isActive && styles.datePillTextActive]}>
                          {item.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {/* Nếu chọn chế độ Khoảng ngày (range): hiển thị thanh chọn Từ ngày ➔ Đến ngày */}
              {prodTimeFilter === 'range' && (
                <View style={styles.dailyRangeBar}>
                  <View style={styles.dailyRangeInputsRow}>
                    <View style={styles.dailyRangeInputBox}>
                      <Text style={styles.dailyRangeLabel}>Từ ngày (YYYY-MM-DD):</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <TextInput
                          style={[styles.dailyRangeInput, { flex: 1 }]}
                          value={prodRangeFrom}
                          onChangeText={setProdRangeFrom}
                          placeholder="2026-11-01"
                          placeholderTextColor="#64748b"
                        />
                        <TouchableOpacity
                          onPress={() => {
                            setCalendarTarget('prodFrom');
                            setIsCalendarModalVisible(true);
                          }}
                          style={styles.calendarPickIconBtn}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="calendar" size={16} color="#818cf8" />
                        </TouchableOpacity>
                      </View>
                    </View>
                    <Ionicons name="arrow-forward" size={14} color="#64748b" style={{ marginTop: 14 }} />
                    <View style={styles.dailyRangeInputBox}>
                      <Text style={styles.dailyRangeLabel}>Đến ngày (YYYY-MM-DD):</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <TextInput
                          style={[styles.dailyRangeInput, { flex: 1 }]}
                          value={prodRangeTo}
                          onChangeText={setProdRangeTo}
                          placeholder="2026-11-12"
                          placeholderTextColor="#64748b"
                        />
                        <TouchableOpacity
                          onPress={() => {
                            setCalendarTarget('prodTo');
                            setIsCalendarModalVisible(true);
                          }}
                          style={styles.calendarPickIconBtn}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="calendar" size={16} color="#818cf8" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                </View>
              )}

              {/* Ô tìm kiếm mặt hàng */}
              <View style={styles.customSearchBar}>
                <Ionicons name="search" size={15} color="#818cf8" />
                <TextInput
                  style={styles.customSearchInput}
                  value={prodSearchQuery}
                  onChangeText={setProdSearchQuery}
                  placeholder="Tìm theo tên sản phẩm hoặc công việc..."
                  placeholderTextColor="#64748b"
                />
                {prodSearchQuery ? (
                  <TouchableOpacity onPress={() => setProdSearchQuery('')} style={styles.doneClearSearchBtn}>
                    <Ionicons name="close-circle" size={16} color="#94a3b8" />
                  </TouchableOpacity>
                ) : null}
              </View>

              {/* Thanh chip lọc nhanh theo từng sản phẩm cụ thể nếu có nhiều SP */}
              {uniqueProductNames.length > 1 && (
                <View style={{ paddingVertical: 4, backgroundColor: '#0f172a' }}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }}
                  >
                    <TouchableOpacity
                      onPress={() => setSelectedProductFilter('all')}
                      style={[
                        styles.dailyQuickBtn,
                        selectedProductFilter === 'all' && { backgroundColor: '#4f46e5', borderColor: '#6366f1' },
                      ]}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.dailyQuickBtnText,
                          selectedProductFilter === 'all' && { color: '#fff', fontWeight: '800' },
                        ]}
                      >
                        Tất cả SP ({uniqueProductNames.length})
                      </Text>
                    </TouchableOpacity>
                    {uniqueProductNames.map(pName => {
                      const isSelected = selectedProductFilter === pName;
                      return (
                        <TouchableOpacity
                          key={pName}
                          onPress={() => setSelectedProductFilter(isSelected ? 'all' : pName)}
                          style={[
                            styles.dailyQuickBtn,
                            isSelected && { backgroundColor: '#4f46e5', borderColor: '#6366f1' },
                          ]}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.dailyQuickBtnText,
                              isSelected && { color: '#fff', fontWeight: '800' },
                            ]}
                            numberOfLines={1}
                          >
                            {pName}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              {/* Nội dung báo cáo theo sản phẩm */}
              {loadingProdJournals ? (
                <View style={styles.centerBox}>
                  <ActivityIndicator size="large" color="#6366f1" />
                  <Text style={styles.loadingText}>Đang tổng hợp báo cáo theo mặt hàng...</Text>
                </View>
              ) : productReportRows.length === 0 ? (
                <View style={styles.centerBox}>
                  <Text style={{ color: '#64748b', fontSize: 13 }}>
                    {prodSearchQuery.trim()
                      ? `Không tìm thấy mặt hàng nào khớp với "${prodSearchQuery}".`
                      : 'Không có phát sinh sản phẩm nào trong mốc thời gian này.'}
                  </Text>
                </View>
              ) : (
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ padding: 12, paddingBottom: 100 }}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#6366f1" />}
                >
                  {/* Card thông tin Header */}
                  <View style={styles.reportSummaryHeaderCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={styles.reportHeaderIconBox}>
                        <Ionicons name="layers" size={18} color="#6366f1" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.reportHeaderTitle}>
                          Báo Cáo Sản Phẩm: {prodReportTitle}
                        </Text>
                        <Text style={styles.reportHeaderSub}>
                          Phát sinh: <Text style={{ color: '#38bdf8', fontWeight: '700' }}>{productReportRows.length} mặt hàng</Text> • Gom từ: <Text style={{ color: '#818cf8', fontWeight: '700' }}>{prodShifts.length} công việc</Text>
                        </Text>
                      </View>
                    </View>
                  </View>

                  {/* 1. Chi tiết theo Mặt hàng */}
                  <View style={styles.dailyCard}>
                    <TouchableOpacity
                      onPress={() => setExpandProdProducts(prev => !prev)}
                      style={styles.dailyCardHeader}
                      activeOpacity={0.7}
                    >
                      <View style={styles.dailyCardHeaderLeft}>
                        <Ionicons name="cube-outline" size={16} color="#38bdf8" />
                        <Text style={styles.dailyCardTitle}>1. Chi tiết từng Mặt Hàng</Text>
                        <View style={styles.reportBadge}>
                          <Text style={styles.reportBadgeText}>{productReportRows.length} SP</Text>
                        </View>
                      </View>
                      <Ionicons
                        name={expandProdProducts ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color="#94a3b8"
                      />
                    </TouchableOpacity>

                    {expandProdProducts && (
                      <View style={styles.dailyCardBody}>
                        {productReportRows.length === 0 ? (
                          <Text style={styles.reportEmptyText}>Không có phát sinh sản phẩm nào.</Text>
                        ) : (
                          <View style={styles.reportTable}>
                            <View style={styles.reportTableHeader}>
                              <Text style={[styles.reportTh, { width: 28, textAlign: 'center' }]}>STT</Text>
                              <Text style={[styles.reportTh, { flex: 3 }]}>Sản phẩm & Công việc</Text>
                              <Text style={[styles.reportTh, { flex: 1.1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                              <Text style={[styles.reportTh, { flex: 1.1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                              <Text style={[styles.reportTh, { width: 38, textAlign: 'right' }]}>Đợt</Text>
                            </View>
                            {productReportRows.map((r, idx) => (
                              <View key={`${r.product_name}___${r.unit}___${idx}`} style={styles.reportTableRow}>
                                <Text style={[styles.reportTd, { width: 28, textAlign: 'center', color: '#64748b', fontSize: 11 }]}>
                                  {idx + 1}
                                </Text>
                                <View style={{ flex: 3, paddingRight: 4 }}>
                                  <Text style={styles.reportProdName} numberOfLines={2}>
                                    {r.product_name}
                                  </Text>
                                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, flexWrap: 'wrap', gap: 4 }}>
                                    <View style={styles.reportUnitBadge}>
                                      <Text style={styles.reportUnitBadgeText}>{r.unit}</Text>
                                    </View>
                                  </View>

                                  {/* Tên công việc phát sinh sản phẩm này */}
                                  <View style={styles.reportJobsList}>
                                    {r.jobs && r.jobs.length > 0 ? (
                                      r.jobs.map(j => (
                                        <View key={j.id} style={styles.reportJobItem}>
                                          <Ionicons name="briefcase-outline" size={10} color="#818cf8" />
                                          <Text style={styles.reportJobNameText} numberOfLines={1}>
                                            {j.name}
                                          </Text>
                                          {r.jobs.length > 1 && (
                                            <Text style={styles.reportJobQtyBreakdown}>
                                              ({j.in_qty > 0 ? `+${j.in_qty}` : '0'}{j.out_qty > 0 ? ` / -${j.out_qty}` : ''})
                                            </Text>
                                          )}
                                        </View>
                                      ))
                                    ) : (
                                      <Text style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic' }}>
                                        Từ chốt ca
                                      </Text>
                                    )}
                                  </View>
                                </View>

                                <Text style={[styles.reportTd, { flex: 1.1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>
                                  +{r.in_qty}
                                </Text>
                                <Text style={[styles.reportTd, { flex: 1.1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>
                                  -{r.out_qty}
                                </Text>
                                <Text style={[styles.reportTd, { width: 38, textAlign: 'right', color: '#cbd5e1' }]}>
                                  {r.count}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    )}
                  </View>

                  {/* 2. Tổng hợp theo ĐVT */}
                  <View style={styles.dailyCard}>
                    <TouchableOpacity
                      onPress={() => setExpandProdUnits(prev => !prev)}
                      style={styles.dailyCardHeader}
                      activeOpacity={0.7}
                    >
                      <View style={styles.dailyCardHeaderLeft}>
                        <Ionicons name="layers-outline" size={16} color="#818cf8" />
                        <Text style={styles.dailyCardTitle}>2. Tổng hợp theo Đơn Vị Tính</Text>
                        <View style={styles.reportBadge}>
                          <Text style={styles.reportBadgeText}>{productReportUnits.length} ĐVT</Text>
                        </View>
                      </View>
                      <Ionicons
                        name={expandProdUnits ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color="#94a3b8"
                      />
                    </TouchableOpacity>

                    {expandProdUnits && (
                      <View style={styles.dailyCardBody}>
                        {productReportUnits.length === 0 ? (
                          <Text style={styles.reportEmptyText}>Chưa có phát sinh số liệu theo ĐVT.</Text>
                        ) : (
                          <View style={styles.reportTable}>
                            <View style={styles.reportTableHeader}>
                              <Text style={[styles.reportTh, { flex: 2 }]}>Đơn vị tính</Text>
                              <Text style={[styles.reportTh, { flex: 1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                              <Text style={[styles.reportTh, { flex: 1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                              <Text style={[styles.reportTh, { width: 44, textAlign: 'right' }]}>Số đợt</Text>
                            </View>
                            {productReportUnits.map(u => (
                              <View key={u.unit} style={styles.reportTableRow}>
                                <Text style={[styles.reportTd, { flex: 2, fontWeight: '700', color: '#f8fafc' }]}>
                                  {u.unit}
                                </Text>
                                <Text style={[styles.reportTd, { flex: 1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>
                                  +{u.in_qty}
                                </Text>
                                <Text style={[styles.reportTd, { flex: 1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>
                                  -{u.out_qty}
                                </Text>
                                <Text style={[styles.reportTd, { width: 44, textAlign: 'right', color: '#cbd5e1' }]}>
                                  {u.count}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                </ScrollView>
              )}
            </View>
          )}

          {/* ── CHẾ ĐỘ 3: BÁO CÁO TÙY CHỌN ── */}
          {doneMode === 'custom' && (
            <View style={{ flex: 1 }}>
              {/* Ô TÌM KIẾM CÔNG VIỆC ĐỂ TÍCH CHỌN */}
              <View style={styles.customSearchBar}>
                <Ionicons name="search" size={15} color="#818cf8" />
                <TextInput
                  style={styles.customSearchInput}
                  value={doneSearchQuery}
                  onChangeText={setDoneSearchQuery}
                  placeholder="Tìm công việc, người làm, sản phẩm để tích chọn..."
                  placeholderTextColor="#64748b"
                />
                {doneSearchQuery ? (
                  <TouchableOpacity onPress={() => setDoneSearchQuery('')} style={styles.doneClearSearchBtn}>
                    <Ionicons name="close-circle" size={16} color="#94a3b8" />
                  </TouchableOpacity>
                ) : null}
              </View>

              {/* Thanh công cụ Chọn tất cả / Bỏ chọn */}
              <View style={styles.customToolBar}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <TouchableOpacity
                    onPress={toggleSelectAllCustom}
                    style={styles.customToolBtn}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={
                        filteredPastShifts.length > 0 && filteredPastShifts.every(s => selectedCustomShiftIds.includes(s.id))
                          ? 'close-circle-outline'
                          : 'checkmark-done-outline'
                      }
                      size={14}
                      color="#818cf8"
                    />
                    <Text style={styles.customToolBtnText}>
                      {filteredPastShifts.length > 0 && filteredPastShifts.every(s => selectedCustomShiftIds.includes(s.id))
                        ? 'Bỏ chọn tất cả'
                        : 'Chọn tất cả'}
                    </Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.customSelectedCount}>
                  Đã chọn: <Text style={{ color: '#818cf8', fontWeight: '800' }}>{selectedCustomShiftIds.length}</Text> / {pastShifts.length}
                </Text>
              </View>

              {/* Danh sách các công việc có checkbox */}
              <FlatList
                data={filteredPastShifts}
                keyExtractor={item => item.id}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#6366f1" />}
                contentContainerStyle={{ padding: 12, paddingBottom: 110 }}
                ListEmptyComponent={
                  <View style={styles.centerBox}>
                    <Text style={{ color: '#64748b', fontSize: 13 }}>
                      {doneSearchQuery.trim()
                        ? `Không tìm thấy công việc nào khớp với "${doneSearchQuery}".`
                        : 'Chưa có công việc nào hoàn thành.'}
                    </Text>
                  </View>
                }
                renderItem={({ item }) => {
                  const isChecked = selectedCustomShiftIds.includes(item.id);
                  const name = item.summary_data?.job_name || item.notes || 'Công việc';
                  const closeTime = item.closed_at ? new Date(item.closed_at).toLocaleDateString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '-';
                  const orderType = item.summary_data?.order_type_name;
                  const recordsCount = item.summary_data?.total_records || 0;

                  return (
                    <TouchableOpacity
                      style={[styles.customCard, isChecked && styles.customCardSelected]}
                      onPress={() => toggleSelectCustomShift(item.id)}
                      activeOpacity={0.7}
                    >
                      {/* Checkbox tròn bên trái */}
                      <View style={{ marginRight: 10 }}>
                        <Ionicons
                          name={isChecked ? 'checkbox' : 'square-outline'}
                          size={24}
                          color={isChecked ? '#6366f1' : '#64748b'}
                        />
                      </View>

                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Text style={[styles.doneJobName, isChecked && { color: '#a5b4fc' }]} numberOfLines={1}>
                            {name}
                          </Text>
                          <TouchableOpacity
                            onPress={() => handleOpenPastShiftDetail(item)}
                            style={{ padding: 4 }}
                          >
                            <Ionicons name="information-circle-outline" size={18} color="#94a3b8" />
                          </TouchableOpacity>
                        </View>

                        <View style={{ marginTop: 4, gap: 2 }}>
                          {isOvernightShift(item) && (
                            <View style={styles.overnightBadge}>
                              <Ionicons name="moon" size={10} color="#fbbf24" />
                              <Text style={styles.overnightBadgeText}>
                                Đóng ca vào ngày hôm sau ({formatDateTime(item.closed_at)})
                              </Text>
                            </View>
                          )}
                          <Text style={styles.doneDetailText}>
                            <Ionicons name="time-outline" size={11} color="#94a3b8" /> {closeTime} • {item.closed_by_name || 'Nhân viên'}
                          </Text>
                          {orderType && (
                            <Text style={[styles.doneDetailText, { color: '#818cf8', fontWeight: '700' }]}>
                              <Ionicons name="document-text-outline" size={11} color="#818cf8" /> {orderType}
                            </Text>
                          )}
                          <Text style={styles.doneDetailText}>
                            <Ionicons name="layers-outline" size={11} color="#94a3b8" /> {recordsCount} lượt ghi nhận
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                }}
              />

              {/* Thanh nút nổi cố định ở đáy: XEM BÁO CÁO GỘP */}
              {selectedCustomShiftIds.length > 0 && (
                <View style={styles.customFloatingBar}>
                  <TouchableOpacity
                    style={styles.customFloatingBtn}
                    onPress={handleOpenCustomReport}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="bar-chart" size={18} color="#fff" />
                    <Text style={styles.customFloatingBtnText}>
                      Xem Báo Cáo Gộp ({selectedCustomShiftIds.length} Công Việc)
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {/* ── FLOATING QUICK SNAP BAR (CHỤP NHANH 1 CHẠM KHI DỒN DẬP) ── */}
      {activeTab === 'active' && selectedShift && (
        isQuickSnapBarCollapsed ? (
          <TouchableOpacity
            onPress={() => setIsQuickSnapBarCollapsed(false)}
            activeOpacity={0.85}
            style={{
              position: 'absolute',
              right: 0,
              bottom: 16,
              zIndex: 40,
              height: 42,
              paddingLeft: 10,
              paddingRight: 8,
              borderTopLeftRadius: 21,
              borderBottomLeftRadius: 21,
              backgroundColor: isDark ? 'rgba(15, 23, 42, 0.94)' : '#ffffff',
              borderWidth: 1,
              borderRightWidth: 0,
              borderColor: quickSnaps.length > 0 ? '#f59e0b' : (isDark ? '#38bdf8' : '#0284c7'),
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              elevation: 8,
            }}
          >
            <Ionicons name="chevron-back" size={16} color={isDark ? '#94a3b8' : '#64748b'} />
            <Ionicons name="camera" size={17} color={isDark ? '#38bdf8' : '#0284c7'} />
            {quickSnaps.length > 0 && (
              <View
                style={{
                  backgroundColor: '#f59e0b',
                  minWidth: 18,
                  height: 18,
                  paddingHorizontal: 5,
                  borderRadius: 9,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#0f172a', fontSize: 10, fontWeight: '900' }}>
                  {quickSnaps.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ) : (
          <View
            style={{
              position: 'absolute',
              right: 10,
              bottom: 16,
              zIndex: 40,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {quickSnaps.length > 0 && (
              <TouchableOpacity
                onPress={() => setIsQuickSnapModalVisible(true)}
                activeOpacity={0.85}
                style={{
                  height: 44,
                  paddingHorizontal: 13,
                  borderRadius: 22,
                  backgroundColor: '#f59e0b',
                  borderWidth: 1,
                  borderColor: '#fde68a',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  elevation: 6,
                }}
              >
                <Text style={{ color: '#0f172a', fontSize: 12, fontWeight: '900' }}>Chờ gán</Text>
                <View
                  style={{
                    backgroundColor: '#0f172a',
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 999,
                  }}
                >
                  <Text style={{ color: '#fcd34d', fontSize: 11, fontWeight: '900' }}>
                    {quickSnaps.length}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => setIsQuickCameraVisible(true)}
              activeOpacity={0.85}
              style={{
                height: 44,
                paddingHorizontal: 13,
                borderRadius: 22,
                backgroundColor: '#0284c7',
                borderWidth: 1,
                borderColor: '#38bdf8',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                elevation: 6,
              }}
            >
              <Ionicons name="camera" size={18} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>Chụp nhanh</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setIsQuickSnapBarCollapsed(true)}
              activeOpacity={0.85}
              style={{
                width: 34,
                height: 44,
                borderRadius: 17,
                backgroundColor: isDark ? 'rgba(15, 23, 42, 0.92)' : '#ffffff',
                borderWidth: 1,
                borderColor: isDark ? '#475569' : '#cbd5e1',
                alignItems: 'center',
                justifyContent: 'center',
                elevation: 6,
              }}
            >
              <Ionicons name="chevron-forward" size={18} color={isDark ? '#cbd5e1' : '#475569'} />
            </TouchableOpacity>
          </View>
        )
      )}

      {/* ── CÁC MODAL THAO TÁC ── */}
      <QuickSnapCameraModal
        visible={isQuickCameraVisible}
        openShifts={openShifts}
        initialShiftId={selectedShift?.id || null}
        totalQueueCount={quickSnaps.length}
        lastThumbUri={quickSnaps[quickSnaps.length - 1]?.image?.uri || null}
        onClose={() => setIsQuickCameraVisible(false)}
        onOpenQueue={() => setIsQuickSnapModalVisible(true)}
        onCaptured={handleQuickSnapCaptured}
      />

      <QuickSnapQueueModal
        visible={isQuickSnapModalVisible}
        snaps={quickSnaps}
        openShifts={openShifts}
        allProducts={allProducts}
        recentProducts={recentProducts}
        onClose={() => setIsQuickSnapModalVisible(false)}
        onCaptureMore={() => {
          setIsQuickSnapModalVisible(false);
          setIsQuickCameraVisible(true);
        }}
        onDeleteSnap={handleDeleteQuickSnap}
        onChangeSnapShift={handleChangeQuickSnapShift}
        onSaveToShiftAlbum={handleSaveQuickSnapToAlbum}
        onAssignSnap={handleAssignQuickSnap}
      />

      {/* 1. Bàn phím số nhập nhanh */}
      <OperationNumberPadModal
        visible={isPadVisible}
        product={padProduct}
        defaultUnit={padDefaultUnit}
        onClose={() => setIsPadVisible(false)}
        onSubmit={handlePadSubmit}
        currentStats={padProduct ? getProductCount(padProduct.name, padDefaultUnit || padProduct.unit) : undefined}
      />

      {/* 2. Modal Tạo/Mở ca mới */}
      <OpenJobModal
        visible={isOpenJobModal}
        onClose={() => setIsOpenJobModal(false)}
        onSuccess={loadInitialData}
        user={user}
        allProducts={allProducts}
      />

      {/* 3. Modal Hoàn thành ca chính */}
      <CloseJobModal
        visible={isCloseJobModal}
        shift={selectedShift}
        onClose={() => setIsCloseJobModal(false)}
        onSuccess={loadInitialData}
        user={user}
      />

      {/* 4. Modal Chốt ca tạm (Đợt) */}
      <InterimCloseModal
        visible={isInterimCloseModal}
        shift={selectedShift}
        onClose={() => setIsInterimCloseModal(false)}
        onSyncedReload={async () => {
          if (!selectedShift) return;
          const freshShifts = await getOpenShifts();
          setOpenShifts(freshShifts);
          const fresh = freshShifts.find(s => s.id === selectedShift.id);
          if (fresh) setSelectedShift(fresh);
          await reloadShiftData(selectedShift.id);
          await refreshPendingCount();
        }}
        onSuccess={async () => {
          if (!selectedShift) return;
          const freshShifts = await getOpenShifts();
          setOpenShifts(freshShifts);
          const fresh = freshShifts.find(s => s.id === selectedShift.id);
          if (fresh) setSelectedShift(fresh);
          await reloadShiftData(selectedShift.id);
          await refreshPendingCount();
        }}
        user={user}
      />

      {/* 4.5. Modal Album hình ảnh chứng minh của công việc */}
      <OperationImagesModal
        visible={isImagesModalVisible}
        shift={selectedShift}
        user={user}
        journalTarget={journalTargetForImages}
        onClose={() => {
          setIsImagesModalVisible(false);
          setJournalTargetForImages(null);
        }}
        onChanged={(count) => setShiftImageCount(count)}
      />

      {/* 4.6. Modal Thư viện & Cây Thư Mục Ảnh Tổng Hợp Toàn Kho */}
      <WarehouseAlbumModal
        visible={isWarehouseAlbumVisible}
        systemCode={
          selectedShift?.system_code ||
          openShifts[0]?.system_code ||
          pastShifts[0]?.system_code ||
          albumSystemCode
        }
        companyId={user?.company_id || selectedShift?.company_id || null}
        onClose={() => setIsWarehouseAlbumVisible(false)}
      />

      {/* 5. Modal Con mắt xem lịch sử sản phẩm */}
      <ProductHistoryModal
        visible={isHistoryVisible}
        product={historyProduct}
        shiftId={selectedShift?.id || null}
        onClose={() => setIsHistoryVisible(false)}
      />

      {/* 6. Modal Chỉnh sửa lượt ghi nhận */}
      <EditJournalModal
        visible={isEditModalVisible}
        record={editingRecord}
        onClose={() => {
          setIsEditModalVisible(false);
          setEditingRecord(null);
        }}
        onSubmit={handleUpdateJournalSubmit}
      />

      {/* 7. Modal Xem chi tiết báo cáo công việc đã hoàn thành */}
      <PastShiftDetailModal
        visible={selectedPastShift !== null}
        shift={selectedPastShift}
        journals={pastShiftJournals}
        subShifts={pastSubShifts}
        user={user}
        loading={loadingPastDetail}
        onClose={() => setSelectedPastShift(null)}
        onRefreshAll={handleRefresh}
      />

      {/* 8. Modal Báo Cáo Tổng Hợp Tùy Chọn */}
      <AggregatedReportModal
        visible={isCustomReportModalVisible}
        title={`Báo Cáo Tùy Chọn (${selectedCustomShifts.length} công việc)`}
        shifts={selectedCustomShifts}
        journals={customJournals}
        allProducts={allProducts}
        loading={loadingCustomJournals}
        onClose={() => setIsCustomReportModalVisible(false)}
        onOpenShiftDetail={(s) => {
          setIsCustomReportModalVisible(false);
          handleOpenPastShiftDetail(s);
        }}
      />

      {/* 9. Modal Lịch chọn ngày linh hoạt */}
      <CalendarPickerModal
        visible={isCalendarModalVisible}
        onClose={() => setIsCalendarModalVisible(false)}
        isMultiSelect={calendarTarget === 'multi'}
        title={
          calendarTarget === 'multi'
            ? 'Chọn các ngày cần xem báo cáo'
            : calendarTarget === 'from' || calendarTarget === 'prodFrom'
              ? 'Chọn mốc Từ ngày'
              : 'Chọn mốc Đến ngày'
        }
        selectedDates={
          calendarTarget === 'multi'
            ? selectedDates
            : calendarTarget === 'from'
              ? [dailyRangeFrom].filter(Boolean)
              : calendarTarget === 'to'
                ? [dailyRangeTo].filter(Boolean)
                : calendarTarget === 'prodFrom'
                  ? [prodRangeFrom].filter(Boolean)
                  : [prodRangeTo].filter(Boolean)
        }
        availableDateKeys={availableDates.map(d => d.dateKey)}
        onConfirm={dates => {
          if (calendarTarget === 'multi') {
            setSelectedDates(dates.length > 0 ? dates : selectedDates);
          } else if (calendarTarget === 'from') {
            if (dates[0]) setDailyRangeFrom(dates[0]);
          } else if (calendarTarget === 'to') {
            if (dates[0]) setDailyRangeTo(dates[0]);
          } else if (calendarTarget === 'prodFrom') {
            if (dates[0]) setProdRangeFrom(dates[0]);
          } else if (calendarTarget === 'prodTo') {
            if (dates[0]) setProdRangeTo(dates[0]);
          }
        }}
      />

      {/* Bottom Sheet Menu Thao Tác (nút ⋯ chuẩn /so-lieu mobile) */}
      <Modal
        visible={isActionMenuOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsActionMenuOpen(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsActionMenuOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        >
          <View
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: 28,
            }}
          >
            <View
              style={{
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.border,
                alignSelf: 'center',
                marginBottom: 12,
              }}
            />
            {selectedShift && (
              <View style={{ marginBottom: 10, paddingHorizontal: 4 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: colors.text }} numberOfLines={1}>
                  {currentJobName}
                </Text>
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                  {subShifts.length > 0 ? `${subShifts.length} lần chốt tạm • ` : ''}
                  {pinnedProducts.length} SP đã ghim
                </Text>
              </View>
            )}

            {selectedShift && (
              <>
                <TouchableOpacity
                  onPress={() => {
                    setIsActionMenuOpen(false);
                    setIsInterimCloseModal(true);
                  }}
                  style={styles.actionMenuRow}
                >
                  <Ionicons name="time-outline" size={19} color="#d97706" />
                  <Text style={styles.actionMenuText}>Chốt ca tạm (Đợt #{subShifts.length + 1})</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => {
                    setIsActionMenuOpen(false);
                    setIsCloseJobModal(true);
                  }}
                  style={styles.actionMenuRow}
                >
                  <Ionicons name="stop-circle-outline" size={19} color="#e11d48" />
                  <Text style={[styles.actionMenuText, { color: '#e11d48' }]}>Hoàn thành công việc</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => {
                    setIsActionMenuOpen(false);
                    setIsImagesModalVisible(true);
                  }}
                  style={styles.actionMenuRow}
                >
                  <Ionicons name="camera-outline" size={19} color="#0284c7" />
                  <Text style={styles.actionMenuText}>Album ảnh công việc này ({shiftImageCount})</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              onPress={() => {
                setIsActionMenuOpen(false);
                setIsOpenJobModal(true);
              }}
              style={styles.actionMenuRow}
            >
              <Ionicons name="add-circle-outline" size={19} color="#4f46e5" />
              <Text style={[styles.actionMenuText, { color: '#4f46e5' }]}>Mở công việc mới</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={async () => {
                setIsActionMenuOpen(false);
                const sys = await getCurrentSystemCode().catch(() => '');
                if (sys) setAlbumSystemCode(sys);
                setIsWarehouseAlbumVisible(true);
              }}
              style={styles.actionMenuRow}
            >
              <Ionicons name="images-outline" size={19} color="#059669" />
              <Text style={styles.actionMenuText}>Thư viện ảnh theo ngày & công việc</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                setIsActionMenuOpen(false);
                void handleSyncOperationsOffline();
              }}
              style={styles.actionMenuRow}
            >
              <Ionicons name="cloud-download-outline" size={19} color="#0284c7" />
              <Text style={styles.actionMenuText}>Tải & Đồng bộ dữ liệu ngoại tuyến</Text>
            </TouchableOpacity>

            {selectedShift && pinnedProducts.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setIsActionMenuOpen(false);
                  handleClearPinned();
                }}
                style={[styles.actionMenuRow, { borderBottomWidth: 0 }]}
              >
                <Ionicons name="trash-outline" size={19} color="#78716c" />
                <Text style={[styles.actionMenuText, { color: '#78716c' }]}>
                  Bỏ ghim tất cả ({pinnedProducts.length} SP)
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={Boolean(previewReconcileImage)}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewReconcileImage(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setPreviewReconcileImage(null)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center', padding: 16 }}
        >
          {previewReconcileImage && (
            <Image
              source={{ uri: previewReconcileImage.public_url || '' }}
              style={{ width: '100%', height: '80%', resizeMode: 'contain' }}
            />
          )}
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const createStyles = (c: AppThemeColors, isDark: boolean) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  lightHeaderWrapper: {
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
  },
  topTabBar: {
    flexDirection: 'row',
    padding: 4,
    backgroundColor: c.pillBg,
    borderRadius: 999,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    height: 34,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'transparent',
  },
  tabBtnActive: {
    backgroundColor: isDark ? '#334155' : '#ffffff',
    shadowColor: '#000',
    shadowOpacity: isDark ? 0 : 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: isDark ? 0 : 2,
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
  },
  tabBtnTextActive: {
    color: isDark ? '#ffffff' : c.primary,
    fontWeight: '800',
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: c.border,
  },
  pulseDotActive: {
    backgroundColor: '#10b981',
  },
  jobBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  jobDropdownBtn: {
    flex: 1,
    height: 44,
    backgroundColor: c.primary,
    borderRadius: 999,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: c.primary,
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  jobLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.82)',
    fontWeight: '600',
  },
  jobTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#ffffff',
  },
  syncShiftBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: isDark ? 'rgba(16, 185, 129, 0.14)' : '#ecfdf5',
    borderWidth: 1,
    borderColor: isDark ? '#059669' : '#6ee7b7',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  moreActionBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  moreActionDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#f59e0b',
    borderWidth: 2,
    borderColor: c.surface,
  },
  actionMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
  },
  actionMenuText: {
    fontSize: 13,
    fontWeight: '700',
    color: c.text,
  },
  actionIconBtnDanger: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#e11d48',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIconBtnWarning: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#d97706',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIconBtnPrimary: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropdownSheet: {
    backgroundColor: c.surfaceAlt,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
  },
  dropdownHeader: {
    fontSize: 11,
    color: c.textMuted,
    fontWeight: '700',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 5,
    gap: 8,
  },
  dropdownItemActive: {
    borderWidth: 1,
    borderColor: c.primarySoftBorder,
    backgroundColor: c.primarySoftBg,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dropdownItemText: {
    flex: 1,
    fontSize: 13,
    color: c.text,
    fontWeight: '600',
  },
  searchBarWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    backgroundColor: c.inputBg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.primarySoftBorder,
    paddingHorizontal: 5,
  },
  modeToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  modeFilter: {
    backgroundColor: c.primarySoftBg,
    borderColor: c.primarySoftBorder,
  },
  modePin: {
    backgroundColor: c.amberSoftBg,
    borderColor: c.amberSoftBorder,
  },
  modeToggleText: {
    fontSize: 11,
    fontWeight: '900',
  },
  searchInput: {
    flex: 1,
    height: 38,
    color: c.text,
    fontSize: 12,
    paddingHorizontal: 8,
  },
  clearSearchBtn: {
    padding: 6,
  },
  pinnedStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginHorizontal: 10,
    marginBottom: 6,
    backgroundColor: c.amberSoftBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.amberSoftBorder,
  },
  pinnedCountText: {
    fontSize: 11,
    color: c.textSecondary,
  },
  trashBtn: {
    padding: 4,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  loadingText: {
    color: c.textMuted,
    fontSize: 13,
    marginTop: 10,
  },
  emptyShiftBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyShiftTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: c.text,
    marginTop: 12,
  },
  emptyShiftDesc: {
    fontSize: 12,
    color: c.textMuted,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  createBigBtn: {
    marginTop: 20,
    height: 44,
    paddingHorizontal: 20,
    backgroundColor: c.primary,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  createBigBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  emptyListBox: {
    padding: 30,
    alignItems: 'center',
  },
  emptyListText: {
    color: c.textMuted,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
    backgroundColor: c.surface,
  },
  sttBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  sttText: {
    fontSize: 10,
    fontWeight: '800',
    color: c.textMuted,
  },
  productInfoCol: {
    flex: 1,
    paddingRight: 6,
  },
  rowProductName: {
    fontSize: 13,
    fontWeight: '700',
    color: c.text,
    lineHeight: 17,
  },
  rowProductSku: {
    fontSize: 10,
    color: c.textMuted,
  },
  rowProductUnit: {
    fontSize: 10,
    color: c.primary,
    fontWeight: '600',
  },
  statsCol: {
    alignItems: 'flex-end',
    width: 60,
    marginRight: 8,
  },
  statInText: {
    fontSize: 12,
    fontWeight: '800',
    color: c.success,
  },
  statOutText: {
    fontSize: 12,
    fontWeight: '800',
    color: c.danger,
  },
  eyeBtn: {
    padding: 6,
    marginRight: 6,
    backgroundColor: c.surfaceAlt,
    borderRadius: 8,
  },
  pinToggleBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinToggleBtnActive: {
    backgroundColor: '#6366f1',
  },
  rowEnterBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#16a34a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  doneJobName: {
    fontSize: 14,
    fontWeight: '700',
    color: c.text,
    flex: 1,
  },
  doneBadge: {
    backgroundColor: c.successSoftBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  doneBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: c.successSoftText,
  },
  doneDetailText: {
    fontSize: 11,
    color: '#94a3b8',
  },
  subHeaderHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
  },
  subHeaderHintLeft: {
    fontSize: 11,
    color: c.textMuted,
    fontWeight: '500',
  },
  hintIn: {
    fontSize: 11,
    fontWeight: '800',
    color: c.success,
  },
  hintOut: {
    fontSize: 11,
    fontWeight: '800',
    color: c.danger,
  },
  productCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: '#000',
    shadowOpacity: isDark ? 0 : 0.03,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: isDark ? 0 : 1,
  },
  cardIndigo: {
    backgroundColor: c.surface,
    borderLeftWidth: 4,
    borderLeftColor: c.primary,
  },
  cardAmber: {
    backgroundColor: c.cardAltBg,
    borderLeftWidth: 4,
    borderLeftColor: '#f59e0b',
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  sttBadge: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    borderWidth: 1,
  },
  sttBadgeText: {
    fontSize: 11,
    fontWeight: '900',
  },
  sttIndigo: {
    backgroundColor: c.primarySoftBg,
    borderColor: c.primarySoftBorder,
  },
  sttIndigoText: {
    color: c.primarySoftText,
  },
  sttAmber: {
    backgroundColor: c.amberSoftBg,
    borderColor: c.amberSoftBorder,
  },
  sttAmberText: {
    color: c.amberSoftText,
  },
  cardTitleCol: {
    flex: 1,
  },
  cardProductName: {
    fontSize: 13,
    fontWeight: '700',
    color: c.text,
    lineHeight: 18,
  },
  cardProductSku: {
    fontSize: 10,
    color: c.textMuted,
    marginTop: 2,
  },
  cardEyeBtn: {
    width: 30,
    height: 30,
    backgroundColor: c.pillBg,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardUnitsList: {
    marginTop: 9,
    gap: 6,
  },
  unitRowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
  },
  unitRowPillActive: {
    borderColor: c.primarySoftBorder,
    backgroundColor: c.primarySoftBg,
  },
  unitRowName: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textSecondary,
  },
  unitRowNameActive: {
    color: c.primarySoftText,
    fontWeight: '800',
  },
  statsWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statBadgeIn: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: 'transparent',
  },
  statBadgeInActive: {
    backgroundColor: c.successSoftBg,
    paddingHorizontal: 6,
  },
  statTextIn: {
    fontSize: 12,
    fontWeight: '800',
    color: c.textMuted,
  },
  statTextInActive: {
    color: c.success,
    fontWeight: '900',
  },
  statDivider: {
    color: c.divider,
    fontSize: 11,
    fontWeight: '600',
  },
  statBadgeOut: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: 'transparent',
  },
  statBadgeOutActive: {
    backgroundColor: c.dangerSoftBg,
    paddingHorizontal: 6,
  },
  statTextOut: {
    fontSize: 12,
    fontWeight: '800',
    color: c.textMuted,
  },
  statTextOutActive: {
    color: c.danger,
    fontWeight: '900',
  },

  // ── PHẦN BÁO CÁO VÀ LỊCH SỬ ĐỢT CUỐI TRANG (DYNAMIC LIGHT/DARK) ──
  footerReportWrapper: {
    marginTop: 14,
    marginBottom: 40,
  },
  viewModeNoticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.amberSoftBg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.amberSoftBorder,
  },
  viewModeNoticeLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  viewModeNoticeText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.amberSoftText,
  },
  viewModeToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.amberSoftBorder,
  },
  viewModeToggleBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: c.amberSoftText,
  },
  reportCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  reportTabHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  reportTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  reportTabBtnActive: {
    borderBottomColor: c.primary,
    backgroundColor: c.surface,
  },
  reportTabBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
  },
  reportTabBtnTextActive: {
    color: isDark ? '#ffffff' : c.primary,
    fontWeight: '800',
  },
  feedTabContainer: {
    padding: 10,
  },
  filterPillsRow: {
    flexDirection: 'row',
    backgroundColor: c.pillBg,
    borderRadius: 10,
    padding: 4,
    gap: 4,
    marginBottom: 12,
  },
  filterPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    borderRadius: 8,
  },
  filterPillAllActive: {
    backgroundColor: c.primary,
  },
  filterPillInActive: {
    backgroundColor: '#16a34a',
  },
  filterPillOutActive: {
    backgroundColor: '#dc2626',
  },
  filterPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: c.textSecondary,
  },
  filterPillTextWhite: {
    color: '#fff',
  },
  filterPillArrow: {
    fontSize: 12,
    fontWeight: '900',
  },
  emptyFeedBox: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyFeedText: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 8,
  },
  journalListContainer: {
    gap: 8,
  },
  journalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: c.surfaceAlt,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: c.border,
  },
  arrowCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  arrowCircleIn: {
    backgroundColor: c.successSoftBg,
  },
  arrowCircleOut: {
    backgroundColor: c.dangerSoftBg,
  },
  arrowCircleText: {
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 16,
  },
  arrowCircleTextIn: {
    color: c.success,
  },
  arrowCircleTextOut: {
    color: c.danger,
  },
  journalRowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 6,
  },
  journalItemName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: c.text,
    lineHeight: 18,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionPencilBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: c.pillBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionTrashBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: c.dangerSoftBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  journalRowMid: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
  },
  qtyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  qtyBadgeIn: {
    backgroundColor: c.successSoftBg,
    borderWidth: 1,
    borderColor: c.successSoftBorder,
  },
  qtyBadgeOut: {
    backgroundColor: c.dangerSoftBg,
    borderWidth: 1,
    borderColor: c.dangerSoftBorder,
  },
  qtyBadgeText: {
    fontSize: 12,
    fontWeight: '900',
  },
  qtyBadgeTextIn: {
    color: c.successSoftText,
  },
  qtyBadgeTextOut: {
    color: c.dangerSoftText,
  },
  journalMetaText: {
    fontSize: 10,
    color: c.textMuted,
    marginTop: 2,
  },
  subShiftCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.amberSoftBorder,
    overflow: 'hidden',
    marginBottom: 4,
  },
  subShiftCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.amberSoftBg,
    padding: 10,
  },
  subShiftCardTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: c.amberSoftText,
  },
  subShiftCountBadge: {
    backgroundColor: isDark ? 'rgba(245, 158, 11, 0.25)' : '#fef3c7',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  subShiftCountBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: c.amberSoftText,
  },
  subShiftRangeText: {
    fontSize: 10,
    color: c.textMuted,
    marginTop: 2,
  },
  subShiftSumBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.surface,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
  },
  subShiftSumIn: {
    fontSize: 11,
    fontWeight: '800',
    color: c.success,
  },
  subShiftSumDivider: {
    fontSize: 10,
    color: c.divider,
  },
  subShiftSumOut: {
    fontSize: 11,
    fontWeight: '800',
    color: c.danger,
  },
  subShiftDetails: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    padding: 8,
    gap: 6,
  },
  emptySubRecordsText: {
    fontSize: 11,
    color: c.textMuted,
    textAlign: 'center',
    paddingVertical: 8,
    fontStyle: 'italic',
  },
  subShiftFooterInfo: {
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: c.borderSubtle,
  },
  subShiftFooterText: {
    fontSize: 10,
    color: c.textMuted,
  },
  currentBatchEmptyBox: {
    padding: 12,
    backgroundColor: c.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
  },
  currentBatchEmptyText: {
    fontSize: 11,
    color: c.textMuted,
    textAlign: 'center',
  },
  summaryTabContainer: {
    padding: 10,
    gap: 8,
  },
  accordionCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: isDark ? '#1e293b' : '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  accordionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  accordionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: c.text,
    letterSpacing: 0.3,
  },
  accordionBadge: {
    backgroundColor: c.primarySoftBg,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  accordionBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: c.primarySoftText,
  },
  accordionBody: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  summaryEmptyText: {
    fontSize: 11,
    color: c.textMuted,
    fontStyle: 'italic',
    paddingVertical: 6,
  },
  summaryTable: {
    backgroundColor: c.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  summaryTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#1e293b' : '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  summaryTh: {
    fontSize: 11,
    fontWeight: '800',
    color: c.textMuted,
  },
  summaryTableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
  },
  summaryTd: {
    fontSize: 11,
    color: c.textSecondary,
  },
  subShiftSummaryBox: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    padding: 10,
    gap: 8,
  },
  subShiftSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
    paddingBottom: 6,
  },
  subShiftSummaryTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: c.amber,
  },
  subShiftSummaryTime: {
    fontSize: 10,
    color: c.textMuted,
    marginTop: 2,
  },

  // ── PHONG CÁCH BÁO CÁO MỚI (THEO NGÀY & TÙY CHỌN) ──
  doneModeBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: 8,
  },
  doneModeBtn: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
  },
  doneModeBtnActive: {
    backgroundColor: c.primarySoftBg,
    borderColor: c.primary,
  },
  doneModeBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textMuted,
  },
  doneModeBtnTextActive: {
    color: c.primarySoftText,
    fontWeight: '800',
  },

  // Ô tìm kiếm công việc tab Đã hoàn thành
  customSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    height: 38,
  },
  customSearchInput: {
    flex: 1,
    color: c.text,
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 0,
  },
  doneClearSearchBtn: {
    padding: 4,
  },

  // Thanh chọn ngày & khoảng ngày
  dailySubModeBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: c.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
    gap: 8,
  },
  dailySubModeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderSubtle,
  },
  dailySubModeBtnActive: {
    backgroundColor: c.primarySoftBg,
    borderWidth: 1,
    borderColor: c.primary,
  },
  dailySubModeBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textMuted,
  },
  dailySubModeBtnTextActive: {
    color: c.primarySoftText,
    fontWeight: '800',
  },
  dailyQuickActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  dailyQuickLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textMuted,
  },
  dailyQuickBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  dailyQuickBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: c.textSecondary,
  },
  dailyRangeBar: {
    padding: 10,
    paddingHorizontal: 12,
    backgroundColor: c.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
    gap: 8,
  },
  dailyRangeInputsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dailyRangeInputBox: {
    flex: 1,
  },
  dailyRangeLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: c.textMuted,
    marginBottom: 4,
  },
  dailyRangeInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 34,
    color: c.text,
    fontSize: 12,
    fontWeight: '700',
  },
  calendarPickIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Thanh chọn ngày
  dailyDateBar: {
    paddingVertical: 10,
    backgroundColor: c.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
  },
  datePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  datePillActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  datePillText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textSecondary,
  },
  datePillTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  datePillBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: c.primarySoftBg,
  },
  datePillBadgeActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  datePillBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: c.primarySoftText,
  },
  datePillBadgeTextActive: {
    color: '#fff',
  },

  overnightBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: c.amberSoftBg,
    borderWidth: 1,
    borderColor: c.amberSoftBorder,
    marginTop: 2,
  },
  overnightBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: c.amberSoftText,
  },

  // Card Header tổng hợp ngày
  reportSummaryHeaderCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 12,
    marginBottom: 10,
  },
  reportHeaderIconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: c.primarySoftBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reportHeaderTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: c.text,
  },
  reportHeaderSub: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 2,
  },

  // Card báo cáo (Khối Accordion)
  dailyCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 10,
    overflow: 'hidden',
  },
  dailyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: isDark ? '#1e293b' : '#f8fafc',
  },
  dailyCardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dailyCardTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: c.text,
  },
  reportBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: c.primarySoftBg,
  },
  reportBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: c.primarySoftText,
  },
  dailyCardBody: {
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  reportEmptyText: {
    color: c.textMuted,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 12,
    fontStyle: 'italic',
  },

  // Bảng chi tiết
  reportTable: {
    borderRadius: 6,
    overflow: 'hidden',
  },
  reportTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 6,
    backgroundColor: isDark ? 'rgba(51, 65, 85, 0.6)' : '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  reportTh: {
    fontSize: 10,
    fontWeight: '800',
    color: c.textMuted,
    textTransform: 'uppercase',
  },
  reportTableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
  },
  reportTd: {
    fontSize: 11,
    color: c.textSecondary,
  },
  reportProdName: {
    fontSize: 12,
    fontWeight: '700',
    color: c.text,
    lineHeight: 16,
  },
  reportUnitBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: c.primarySoftBg,
  },
  reportUnitBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: c.primarySoftText,
  },
  reportJobsList: {
    marginTop: 4,
    gap: 2,
  },
  reportJobItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  reportJobNameText: {
    fontSize: 10,
    color: c.textMuted,
    fontWeight: '600',
    flexShrink: 1,
  },
  reportJobQtyBreakdown: {
    fontSize: 9,
    fontWeight: '800',
    color: c.textSecondary,
  },

  // Danh sách ca trong báo cáo ngày
  reportShiftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 8,
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.5)' : '#f8fafc',
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: c.border,
  },
  reportShiftName: {
    fontSize: 12,
    fontWeight: '700',
    color: c.text,
    flexShrink: 1,
  },
  reportShiftBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: c.successSoftBg,
  },
  reportShiftBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: c.successSoftText,
  },
  reportShiftMeta: {
    fontSize: 10,
    color: c.textMuted,
    marginTop: 2,
  },
  reportShiftDetailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: c.primarySoftBg,
    borderWidth: 1,
    borderColor: c.primarySoftBorder,
  },
  reportShiftDetailBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: c.primarySoftText,
  },

  // Chế độ Tùy Chọn
  customToolBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: c.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
  },
  customToolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  customToolBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.primarySoftText,
  },
  customSelectedCount: {
    fontSize: 11,
    color: c.textMuted,
  },
  customCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  customCardSelected: {
    borderColor: c.primary,
    backgroundColor: c.primarySoftBg,
  },
  customFloatingBar: {
    position: 'absolute',
    bottom: 20,
    left: 14,
    right: 14,
  },
  customFloatingBtn: {
    height: 48,
    borderRadius: 24,
    backgroundColor: '#6366f1',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  customFloatingBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
  offlineSyncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.amberSoftBg,
    borderColor: c.amberSoftBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 10,
    marginTop: 6,
    marginBottom: 4,
    gap: 8,
  },
  offlineSyncTitle: {
    color: c.amberSoftText,
    fontSize: 12,
    fontWeight: '800',
  },
  offlineSyncSub: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  offlineSyncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#d97706',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  offlineSyncBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },
  reconcileTabContainer: {
    padding: 12,
    gap: 10,
  },
  reconcileHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  reconcileTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: c.text,
  },
  reconcileSub: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 2,
  },
  reconcileSaveBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  reconcileSaveBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  reconcileCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 10,
    gap: 8,
  },
  reconcileCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  reconcileProdName: {
    fontSize: 13,
    fontWeight: '700',
    color: c.text,
  },
  reconcileSysStats: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 2,
  },
  reconcileStatusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  reconcileMatchPill: {
    backgroundColor: c.successSoftBg,
  },
  reconcileDiffPill: {
    backgroundColor: c.dangerSoftBg,
  },
  reconcileStatusText: {
    fontSize: 11,
    fontWeight: '800',
  },
  reconcileTargetRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  reconcileMiniChip: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 8,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
  },
  reconcileMiniChipActive: {
    borderColor: '#0284c7',
    backgroundColor: isDark ? 'rgba(56, 189, 248, 0.12)' : '#e0f2fe',
  },
  reconcileCalcChipActive: {
    borderColor: '#f59e0b',
    backgroundColor: c.amberSoftBg,
  },
  reconcileMiniChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: c.textSecondary,
  },
  reconcileInputsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  reconcileInputLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: c.textMuted,
    marginBottom: 3,
  },
  reconcileInput: {
    height: 38,
    backgroundColor: c.inputBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 10,
    color: c.text,
    fontSize: 15,
    fontWeight: '800',
  },
  reconcileHintText: {
    fontSize: 10,
    color: c.textMuted,
  },
});

