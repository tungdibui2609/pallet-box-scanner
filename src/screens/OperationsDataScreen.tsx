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
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
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
  normalizeUnitMatch,
  getSubShifts,
  reopenShift,
  deleteShift,
  aggregateShiftsProducts,
  aggregateShiftsUnits,
  AggregatedProductItem,
  AggregatedUnitItem,
} from '../services/operationsService';
import OperationNumberPadModal from '../components/operations/OperationNumberPadModal';
import OpenJobModal from '../components/operations/OpenJobModal';
import CloseJobModal from '../components/operations/CloseJobModal';
import InterimCloseModal from '../components/operations/InterimCloseModal';
import ProductHistoryModal from '../components/operations/ProductHistoryModal';
import EditJournalModal from '../components/operations/EditJournalModal';
import PastShiftDetailModal from '../components/operations/PastShiftDetailModal';
import AggregatedReportModal from '../components/operations/AggregatedReportModal';
import { CalendarPickerModal } from '../components/operations/CalendarPickerModal';
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

// Helper định dạng ngày hiển thị (DD/MM/YYYY)
function formatDateDisplay(dateKey: string): string {
  if (!dateKey) return '';
  const parts = dateKey.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateKey;
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

// Helper chuyển chuỗi thời gian thành timestamp mili-giây an toàn tuyệt đối
function toTimestamp(dateStr?: string | null): number {
  if (!dateStr) return 0;
  let s = String(dateStr).trim();
  if (s.includes(' ')) s = s.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) {
    s = `${s}:00`;
  }
  const t = new Date(s).getTime();
  if (!isNaN(t)) return t;
  const fallback = new Date(dateStr).getTime();
  return isNaN(fallback) ? 0 : fallback;
}

// Helper định dạng ngày giờ chuẩn Việt Nam (HH:mm:ss DD/MM/YYYY)
function formatDateTime(isoString?: string | null): string {
  if (!isoString) return '-';
  try {
    const ts = toTimestamp(isoString);
    if (!ts) return isoString;
    const d = new Date(ts);
    const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `${time} ${date}`;
  } catch {
    return isoString;
  }
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

  // Quản lý ca công việc
  const [openShifts, setOpenShifts] = useState<DeliveryShift[]>([]);
  const [selectedShift, setSelectedShift] = useState<DeliveryShift | null>(null);
  const [pastShifts, setPastShifts] = useState<DeliveryShift[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Danh mục sản phẩm & Bàn làm việc
  const [allProducts, setAllProducts] = useState<ShiftProductItem[]>([]);
  const allProductsRef = useRef<ShiftProductItem[]>([]);
  allProductsRef.current = allProducts;
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
  const [reportTab, setReportTab] = useState<'feed' | 'summary'>('feed');
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
  const [calendarTarget, setCalendarTarget] = useState<'multi' | 'from' | 'to'>('multi');

  // Cho Báo Cáo Theo Sản Phẩm:
  const [prodSearchQuery, setProdSearchQuery] = useState<string>('');
  const [prodTimeFilter, setProdTimeFilter] = useState<'7days' | '30days' | 'all'>('7days');
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
      const [jList, sList] = await Promise.all([
        getShiftJournals(shiftId),
        getSubShifts(shiftId),
      ]);
      setAllJournals(jList);
      setSubShifts(sList);
    } catch (e) {
      console.warn('Lỗi lấy nhật ký & đợt chốt tạm:', e);
    }
  }, []);

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
    await reloadShiftData(shift.id);
  }, [enrichProducts, reloadShiftData]);

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
    if (availableDates.length > 0) {
      if (selectedDates.length === 0) {
        const latest = availableDates[0].dateKey;
        setSelectedDates([latest]);
        setDailyRangeFrom(latest);
        setDailyRangeTo(latest);
      }
    }
  }, [availableDates]);

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
      return () => { cancelled = true; };
    } else if (dailyShifts.length === 0) {
      setDailyJournals([]);
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
  // Danh sách các ca theo mốc thời gian lọc
  const prodShifts = useMemo(() => {
    if (prodTimeFilter === 'all') return pastShifts;
    const now = new Date();
    const daysAgo = prodTimeFilter === '7days' ? 7 : 30;
    const cutoff = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    return pastShifts.filter(s => {
      const t = new Date(s.closed_at || s.opened_at || 0);
      return t >= cutoff;
    });
  }, [pastShifts, prodTimeFilter]);

  // Tự động tải nhật ký các ca cho Báo Cáo Theo Sản Phẩm
  useEffect(() => {
    if (activeTab === 'done' && doneMode === 'product' && prodShifts.length > 0) {
      let cancelled = false;
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
      return () => { cancelled = true; };
    } else if (prodShifts.length === 0) {
      setProdJournals([]);
    }
  }, [activeTab, doneMode, prodShifts]);

  // Tính số liệu mặt hàng tổng hợp cho Báo Cáo Theo Sản Phẩm có lọc từ khóa
  const productReportRows = useMemo(() => {
    const rows = aggregateShiftsProducts(prodShifts, prodJournals, allProducts);
    if (!prodSearchQuery.trim()) return rows;
    const q = prodSearchQuery.trim().toLowerCase();
    return rows.filter(r => {
      const name = (r.product_name || '').toLowerCase();
      const sku = (r.sku || '').toLowerCase();
      const jobs = (r.jobs || []).map(j => j.name.toLowerCase()).join(' ');
      return name.includes(q) || sku.includes(q) || jobs.includes(q);
    });
  }, [prodShifts, prodJournals, allProducts, prodSearchQuery]);

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
  useEffect(() => {
    loadInitialData();
  }, []);

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
      // Chế độ Nhập: Tìm trong các sản phẩm đã ghim
      if (!q) return pinnedProducts;
      return pinnedProducts.filter(p => matchSearch(p, q));
    }
  }, [searchMode, searchQuery, allProducts, pinnedProducts]);

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

  // Ghi nhận lượt bấm từ Bàn phím số
  const handlePadSubmit = async ({ quantity, unit, type, note }: { quantity: number; unit: string; type: 'in' | 'out'; note?: string }) => {
    if (!selectedShift || !padProduct) return;
    try {
      await submitJournalEntry({
        shift: selectedShift,
        product: padProduct,
        quantity,
        unit,
        type,
        user,
        userNote: note,
      });
      // Nạp lại dữ liệu ca ngay sau khi bấm
      await reloadShiftData(selectedShift.id);
    } catch (err: any) {
      console.warn('Lỗi ghi nhật ký:', err);
      Alert.alert('Lỗi ghi nhận', err?.message || 'Không thể lưu lượt nhập/xuất này.');
      throw err;
    }
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
              await deleteJournalEntry(recordId);
              if (selectedShift) {
                await reloadShiftData(selectedShift.id);
              }
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
      {/* ── TOP NAV BAR: TABS ĐANG LÀM / ĐÃ HOÀN THÀNH ── */}
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
          <Ionicons name="checkmark-circle-outline" size={15} color={activeTab === 'done' ? '#6366f1' : '#94a3b8'} />
          <Text style={[styles.tabBtnText, activeTab === 'done' && styles.tabBtnTextActive]}>
            Đã hoàn thành ({pastShifts.length})
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'active' ? (
        <>
          {/* ── SELECTOR CÔNG VIỆC ĐANG LÀM ── */}
          <View style={styles.jobBar}>
            {selectedShift ? (
              <TouchableOpacity
                onPress={() => setIsShiftDropdownOpen(!isShiftDropdownOpen)}
                style={styles.jobDropdownBtn}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.jobLabel}>
                    Công việc {openShifts.length > 1 ? `(${openShifts.length} đang mở)` : ''}
                  </Text>
                  <Text style={styles.jobTitle} numberOfLines={1}>
                    {currentJobName}
                  </Text>
                </View>
                <Ionicons
                  name={isShiftDropdownOpen ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#94a3b8"
                />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={() => setIsOpenJobModal(true)}
                style={[styles.jobDropdownBtn, { backgroundColor: '#6366f1' }]}
              >
                <Ionicons name="add-circle-outline" size={20} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14, marginLeft: 8 }}>
                  Tạo Công Việc Mới
                </Text>
              </TouchableOpacity>
            )}

            {/* Nút Chốt tạm (Cam), Hoàn thành ca (Đỏ), Thêm mới (Tím) */}
            {selectedShift && (
              <View style={{ flexDirection: 'row', gap: 6, marginLeft: 6 }}>
                <TouchableOpacity
                  onPress={() => setIsInterimCloseModal(true)}
                  style={styles.actionIconBtnWarning}
                  accessibilityLabel="Chốt ca tạm"
                >
                  <Ionicons name="time-outline" size={18} color="#fff" />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => setIsCloseJobModal(true)}
                  style={styles.actionIconBtnDanger}
                  accessibilityLabel="Hoàn thành công việc"
                >
                  <Ionicons name="stop-circle" size={18} color="#fff" />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => setIsOpenJobModal(true)}
                  style={styles.actionIconBtnPrimary}
                  accessibilityLabel="Thêm công việc khác"
                >
                  <Ionicons name="add" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Sổ danh sách các công việc đang mở */}
          {isShiftDropdownOpen && (
            <View style={styles.dropdownSheet}>
              <Text style={styles.dropdownHeader}>Chọn công việc để ghi nhận:</Text>
              {openShifts.map(s => {
                const isCur = selectedShift?.id === s.id;
                const name = s.summary_data?.job_name || s.notes || 'Công việc';
                return (
                  <TouchableOpacity
                    key={s.id}
                    onPress={() => selectShift(s)}
                    style={[styles.dropdownItem, isCur && styles.dropdownItemActive]}
                  >
                    <View style={[styles.dot, isCur ? { backgroundColor: '#6366f1' } : { backgroundColor: '#22c55e' }]} />
                    <Text style={[styles.dropdownItemText, isCur && { color: '#6366f1', fontWeight: '800' }]} numberOfLines={1}>
                      {name}
                    </Text>
                    {isCur && <Ionicons name="checkmark" size={16} color="#6366f1" />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* ── THANH TÌM KIẾM 2 CHẾ ĐỘ: NHẬP (Lọc SP ghim) & GHIM (Tìm kho) ── */}
          {selectedShift && (
            <View style={styles.searchBarWrapper}>
              {/* Nút kính lúp chuyển đổi chế độ */}
              <TouchableOpacity
                onPress={() => {
                  setSearchMode(prev => (prev === 'filter' ? 'pin' : 'filter'));
                  setSearchQuery('');
                }}
                style={[styles.modeToggleBtn, searchMode === 'filter' ? styles.modeFilter : styles.modePin]}
              >
                <Ionicons name="search" size={13} color={searchMode === 'filter' ? '#818cf8' : '#fbbf24'} />
                <Text style={[styles.modeToggleText, searchMode === 'filter' ? { color: '#818cf8' } : { color: '#fbbf24' }]}>
                  {searchMode === 'filter' ? 'Nhập' : 'Ghim'}
                </Text>
              </TouchableOpacity>

              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={
                  searchMode === 'filter'
                    ? 'Tìm SP đã ghim (Bấm 🔍 đổi chế độ)...'
                    : 'Tìm SP từ kho để ghim (Bấm 🔍 đổi chế độ)...'
                }
                placeholderTextColor="#64748b"
              />

              {searchQuery ? (
                <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearSearchBtn}>
                  <Ionicons name="close-circle" size={16} color="#64748b" />
                </TouchableOpacity>
              ) : null}
            </View>
          )}

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

          {/* Thanh trạng thái Ghim & Nút thùng rác */}
          {selectedShift && (
            <View style={styles.pinnedStatusRow}>
              <Text style={styles.pinnedCountText}>
                {searchMode === 'pin' ? 'Đang duyệt kho để ghim:' : 'Đã ghim:'}{' '}
                <Text style={{ color: '#f8fafc', fontWeight: '800' }}>
                  {pinnedProducts.length} SP
                </Text>
              </Text>

              {pinnedProducts.length > 0 && searchMode === 'filter' && (
                <TouchableOpacity onPress={handleClearPinned} style={styles.trashBtn}>
                  <Ionicons name="trash-outline" size={15} color="#f43f5e" />
                </TouchableOpacity>
              )}
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
                            <Text style={[styles.unitRowName, isSelected && styles.unitRowNameActive]}>
                              {u}
                            </Text>

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
                          Báo cáo tổng hợp
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
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                                      </View>
                                      {list.map(row => (
                                        <View key={`${row.name}_${row.unit}`} style={styles.summaryTableRow}>
                                          <View style={{ flex: 3 }}>
                                            <Text style={[styles.summaryTd, { fontWeight: '700', color: '#f8fafc' }]} numberOfLines={2}>
                                              {row.name}
                                            </Text>
                                            <Text style={{ fontSize: 10, color: '#a5b4fc', fontWeight: '800' }}>
                                              {row.unit}
                                            </Text>
                                          </View>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>+{row.inQty}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>-{row.outQty}</Text>
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
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                                        <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#818cf8' }]}>Tồn ca</Text>
                                      </View>
                                      {list.map(row => (
                                        <View key={row.unit} style={styles.summaryTableRow}>
                                          <Text style={[styles.summaryTd, { flex: 2, fontWeight: '700', color: '#f8fafc' }]}>{row.unit}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>+{row.inQty}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>-{row.outQty}</Text>
                                          <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#818cf8', fontWeight: '800' }]}>{row.inQty - row.outQty}</Text>
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
                              <View style={[styles.accordionBadge, { backgroundColor: 'rgba(245, 158, 11, 0.2)' }]}>
                                <Text style={[styles.accordionBadgeText, { color: '#fbbf24' }]}>{subShifts.length} Đợt</Text>
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
              {/* Thanh chọn thời gian cho sản phẩm */}
              <View style={styles.dailySubModeBar}>
                {(['7days', '30days', 'all'] as const).map(tf => {
                  const label = tf === '7days' ? '7 ngày qua' : tf === '30days' ? '30 ngày' : 'Tất cả';
                  const isActive = prodTimeFilter === tf;
                  return (
                    <TouchableOpacity
                      key={tf}
                      onPress={() => setProdTimeFilter(tf)}
                      style={[styles.dailySubModeBtn, isActive && styles.dailySubModeBtnActive]}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="time-outline" size={13} color={isActive ? '#818cf8' : '#94a3b8'} />
                      <Text style={[styles.dailySubModeBtnText, isActive && styles.dailySubModeBtnTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

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
                          Báo Cáo Theo Mặt Hàng
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

      {/* ── CÁC MODAL THAO TÁC ── */}
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
        onSuccess={async () => {
          if (selectedShift) {
            await reloadShiftData(selectedShift.id);
          }
        }}
        user={user}
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
            : calendarTarget === 'from'
              ? 'Chọn mốc Từ ngày'
              : 'Chọn mốc Đến ngày'
        }
        selectedDates={
          calendarTarget === 'multi'
            ? selectedDates
            : calendarTarget === 'from'
              ? [dailyRangeFrom].filter(Boolean)
              : [dailyRangeTo].filter(Boolean)
        }
        availableDateKeys={availableDates.map(d => d.dateKey)}
        onConfirm={dates => {
          if (calendarTarget === 'multi') {
            setSelectedDates(dates.length > 0 ? dates : selectedDates);
          } else if (calendarTarget === 'from') {
            if (dates[0]) setDailyRangeFrom(dates[0]);
          } else if (calendarTarget === 'to') {
            if (dates[0]) setDailyRangeTo(dates[0]);
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  topTabBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    gap: 8,
  },
  tabBtn: {
    flex: 1,
    height: 34,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0f172a',
  },
  tabBtnActive: {
    backgroundColor: '#334155',
    borderWidth: 1,
    borderColor: '#6366f1',
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
  },
  tabBtnTextActive: {
    color: '#f8fafc',
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#475569',
  },
  pulseDotActive: {
    backgroundColor: '#22c55e',
  },
  jobBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  jobDropdownBtn: {
    flex: 1,
    height: 42,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#334155',
  },
  jobLabel: {
    fontSize: 9,
    color: '#64748b',
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  jobTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#f8fafc',
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
    backgroundColor: '#6366f1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropdownSheet: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  dropdownHeader: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '700',
    marginBottom: 6,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    marginBottom: 4,
    gap: 8,
  },
  dropdownItemActive: {
    borderWidth: 1,
    borderColor: '#6366f1',
    backgroundColor: '#1e1b4b',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dropdownItemText: {
    flex: 1,
    fontSize: 13,
    color: '#f8fafc',
    fontWeight: '600',
  },
  searchBarWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 8,
    height: 38,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 4,
  },
  modeToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    paddingHorizontal: 8,
    borderRadius: 7,
  },
  modeFilter: {
    backgroundColor: '#312e81',
  },
  modePin: {
    backgroundColor: '#451a03',
  },
  modeToggleText: {
    fontSize: 11,
    fontWeight: '900',
  },
  searchInput: {
    flex: 1,
    height: 38,
    color: '#f8fafc',
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
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  pinnedCountText: {
    fontSize: 11,
    color: '#94a3b8',
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
    color: '#94a3b8',
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
    color: '#f8fafc',
    marginTop: 12,
  },
  emptyShiftDesc: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  createBigBtn: {
    marginTop: 20,
    height: 44,
    paddingHorizontal: 20,
    backgroundColor: '#6366f1',
    borderRadius: 12,
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
    color: '#64748b',
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
    borderBottomColor: '#1e293b',
    backgroundColor: '#0f172a',
  },
  sttBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  sttText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94a3b8',
  },
  productInfoCol: {
    flex: 1,
    paddingRight: 6,
  },
  rowProductName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f8fafc',
    lineHeight: 17,
  },
  rowProductSku: {
    fontSize: 10,
    color: '#64748b',
  },
  rowProductUnit: {
    fontSize: 10,
    color: '#818cf8',
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
    color: '#22c55e',
  },
  statOutText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#f43f5e',
  },
  eyeBtn: {
    padding: 6,
    marginRight: 6,
    backgroundColor: '#1e293b',
    borderRadius: 8,
  },
  pinToggleBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#1e293b',
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
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  doneJobName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#f8fafc',
    flex: 1,
  },
  doneBadge: {
    backgroundColor: '#14532d',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  doneBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#4ade80',
  },
  doneDetailText: {
    fontSize: 11,
    color: '#94a3b8',
  },
  subHeaderHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  subHeaderHintLeft: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '500',
  },
  hintIn: {
    fontSize: 11,
    fontWeight: '700',
    color: '#22c55e',
  },
  hintOut: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ef4444',
  },
  productCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardIndigo: {
    borderLeftWidth: 4,
    borderLeftColor: '#6366f1',
  },
  cardAmber: {
    borderLeftWidth: 4,
    borderLeftColor: '#f59e0b',
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  sttBadge: {
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  sttBadgeText: {
    fontSize: 10,
    fontWeight: '900',
  },
  sttIndigo: {
    backgroundColor: '#312e81',
  },
  sttIndigoText: {
    color: '#a5b4fc',
  },
  sttAmber: {
    backgroundColor: '#78350f',
  },
  sttAmberText: {
    color: '#fcd34d',
  },
  cardTitleCol: {
    flex: 1,
  },
  cardProductName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f8fafc',
    lineHeight: 18,
  },
  cardProductSku: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 2,
  },
  cardEyeBtn: {
    padding: 6,
    backgroundColor: '#0f172a',
    borderRadius: 8,
  },
  cardUnitsList: {
    marginTop: 8,
    gap: 5,
  },
  unitRowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  unitRowPillActive: {
    borderColor: '#6366f1',
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
  },
  unitRowName: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
  },
  unitRowNameActive: {
    color: '#a5b4fc',
    fontWeight: '800',
  },
  statsWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statBadgeIn: {
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 6,
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
  },
  statBadgeInActive: {
    backgroundColor: 'rgba(34, 197, 94, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.4)',
  },
  statTextIn: {
    fontSize: 12,
    fontWeight: '800',
    color: '#4ade80',
  },
  statTextInActive: {
    color: '#22c55e',
    fontWeight: '900',
  },
  statDivider: {
    color: '#475569',
    fontSize: 11,
    fontWeight: '600',
  },
  statBadgeOut: {
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  statBadgeOutActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.4)',
  },
  statTextOut: {
    fontSize: 12,
    fontWeight: '800',
    color: '#f87171',
  },
  statTextOutActive: {
    color: '#ef4444',
    fontWeight: '900',
  },

  // ── PHẦN BÁO CÁO VÀ LỊCH SỬ ĐỢT CUỐI TRANG ──
  footerReportWrapper: {
    marginTop: 18,
    marginBottom: 40,
  },
  viewModeNoticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
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
    color: '#f59e0b',
  },
  viewModeToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#334155',
  },
  viewModeToggleBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#f8fafc',
  },
  reportCard: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  reportTabHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    backgroundColor: '#0f172a',
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
    borderBottomColor: '#6366f1',
    backgroundColor: '#1e293b',
  },
  reportTabBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
  },
  reportTabBtnTextActive: {
    color: '#f8fafc',
    fontWeight: '800',
  },
  feedTabContainer: {
    padding: 10,
  },
  filterPillsRow: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
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
    backgroundColor: '#334155',
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
    color: '#94a3b8',
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
    color: '#64748b',
    marginTop: 8,
  },
  journalListContainer: {
    gap: 8,
  },
  journalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#334155',
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
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
  },
  arrowCircleOut: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  arrowCircleText: {
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 16,
  },
  arrowCircleTextIn: {
    color: '#22c55e',
  },
  arrowCircleTextOut: {
    color: '#ef4444',
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
    color: '#f8fafc',
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
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionTrashBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: '#1e293b',
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
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.3)',
  },
  qtyBadgeOut: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.3)',
  },
  qtyBadgeText: {
    fontSize: 12,
    fontWeight: '900',
  },
  qtyBadgeTextIn: {
    color: '#4ade80',
  },
  qtyBadgeTextOut: {
    color: '#f87171',
  },
  journalMetaText: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  subShiftCard: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#78350f',
    overflow: 'hidden',
    marginBottom: 4,
  },
  subShiftCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    padding: 10,
  },
  subShiftCardTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#f59e0b',
  },
  subShiftCountBadge: {
    backgroundColor: 'rgba(245, 158, 11, 0.25)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  subShiftCountBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fde68a',
  },
  subShiftRangeText: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  subShiftSumBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e293b',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  subShiftSumIn: {
    fontSize: 11,
    fontWeight: '800',
    color: '#4ade80',
  },
  subShiftSumDivider: {
    fontSize: 10,
    color: '#475569',
  },
  subShiftSumOut: {
    fontSize: 11,
    fontWeight: '800',
    color: '#f87171',
  },
  subShiftDetails: {
    borderTopWidth: 1,
    borderTopColor: '#334155',
    padding: 8,
    gap: 6,
  },
  emptySubRecordsText: {
    fontSize: 11,
    color: '#64748b',
    textAlign: 'center',
    paddingVertical: 8,
    fontStyle: 'italic',
  },
  subShiftFooterInfo: {
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  subShiftFooterText: {
    fontSize: 10,
    color: '#94a3b8',
  },
  currentBatchEmptyBox: {
    padding: 12,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
  },
  currentBatchEmptyText: {
    fontSize: 11,
    color: '#94a3b8',
    textAlign: 'center',
  },
  summaryTabContainer: {
    padding: 10,
    gap: 8,
  },
  accordionCard: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1e293b',
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
    color: '#f8fafc',
    letterSpacing: 0.3,
  },
  accordionBadge: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  accordionBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#a5b4fc',
  },
  accordionBody: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  summaryEmptyText: {
    fontSize: 11,
    color: '#64748b',
    fontStyle: 'italic',
    paddingVertical: 6,
  },
  summaryTable: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  summaryTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  summaryTh: {
    fontSize: 11,
    fontWeight: '800',
    color: '#94a3b8',
  },
  summaryTableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  summaryTd: {
    fontSize: 11,
    color: '#cbd5e1',
  },
  subShiftSummaryBox: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 10,
    gap: 8,
  },
  subShiftSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingBottom: 6,
  },
  subShiftSummaryTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#f59e0b',
  },
  subShiftSummaryTime: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },

  // ── PHONG CÁCH BÁO CÁO MỚI (THEO NGÀY & TÙY CHỌN) ──
  doneModeBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
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
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  doneModeBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.25)',
    borderColor: '#6366f1',
  },
  doneModeBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
  },
  doneModeBtnTextActive: {
    color: '#a5b4fc',
    fontWeight: '800',
  },

  // Ô tìm kiếm công việc tab Đã hoàn thành
  customSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    height: 38,
  },
  customSearchInput: {
    flex: 1,
    color: '#f8fafc',
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
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
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
    backgroundColor: '#1e293b',
  },
  dailySubModeBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    borderWidth: 1,
    borderColor: '#6366f1',
  },
  dailySubModeBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
  },
  dailySubModeBtnTextActive: {
    color: '#818cf8',
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
    color: '#94a3b8',
  },
  dailyQuickBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  dailyQuickBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#cbd5e1',
  },
  dailyRangeBar: {
    padding: 10,
    paddingHorizontal: 12,
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
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
    color: '#94a3b8',
    marginBottom: 4,
  },
  dailyRangeInput: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 34,
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
  },
  calendarPickIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Thanh chọn ngày
  dailyDateBar: {
    paddingVertical: 10,
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  datePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  datePillActive: {
    backgroundColor: '#6366f1',
    borderColor: '#818cf8',
  },
  datePillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
  },
  datePillTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  datePillBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: '#0f172a',
  },
  datePillBadgeActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  datePillBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#a5b4fc',
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
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    marginTop: 2,
  },
  overnightBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fbbf24',
  },

  // Card Header tổng hợp ngày
  reportSummaryHeaderCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 12,
    marginBottom: 10,
  },
  reportHeaderIconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reportHeaderTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#f8fafc',
  },
  reportHeaderSub: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },

  // Card báo cáo (Khối Accordion)
  dailyCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
    overflow: 'hidden',
  },
  dailyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
  },
  dailyCardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dailyCardTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#f1f5f9',
  },
  reportBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
  },
  reportBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#818cf8',
  },
  dailyCardBody: {
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  reportEmptyText: {
    color: '#64748b',
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
    backgroundColor: 'rgba(51, 65, 85, 0.6)',
    borderBottomWidth: 1,
    borderBottomColor: '#475569',
  },
  reportTh: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94a3b8',
    textTransform: 'uppercase',
  },
  reportTableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(51, 65, 85, 0.4)',
  },
  reportTd: {
    fontSize: 11,
    color: '#e2e8f0',
  },
  reportProdName: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f8fafc',
    lineHeight: 16,
  },
  reportUnitBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(99, 102, 241, 0.25)',
  },
  reportUnitBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#a5b4fc',
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
    color: '#94a3b8',
    fontWeight: '600',
    flexShrink: 1,
  },
  reportJobQtyBreakdown: {
    fontSize: 9,
    fontWeight: '800',
    color: '#cbd5e1',
  },

  // Danh sách ca trong báo cáo ngày
  reportShiftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  reportShiftName: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f8fafc',
    flexShrink: 1,
  },
  reportShiftBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
  },
  reportShiftBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#4ade80',
  },
  reportShiftMeta: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  reportShiftDetailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
  },
  reportShiftDetailBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#a5b4fc',
  },

  // Chế độ Tùy Chọn
  customToolBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  customToolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  customToolBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#a5b4fc',
  },
  customSelectedCount: {
    fontSize: 11,
    color: '#94a3b8',
  },
  customCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  customCardSelected: {
    borderColor: '#6366f1',
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
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
});

