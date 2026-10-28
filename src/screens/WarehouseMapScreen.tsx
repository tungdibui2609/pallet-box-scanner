import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
  FlatList,
  Platform,
  Alert
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  getSupabaseClient,
  syncWarehouseMapOffline,
  getWarehouseMapOfflineData,
  getLastWarehouseMapOfflineSyncInfo,
  getMemoryWarehouseMapCache
} from '../services/supabase';
import { decodeSTT } from '../utils/numberUtils';
import { groupWarehouseData } from '../utils/warehouseUtils';
import { matchPalletSearch, calculateSearchScore, matchSearch, normalizeSearchString } from '../utils/searchUtils';
import { formatMaterialZoneList } from '../utils/provinces';

export type DateFilterType = 'packaging_date' | 'peeling_date' | 'raw_material_date' | 'inbound_date';

export const DATE_FILTER_OPTIONS: { id: DateFilterType; label: string; shortLabel: string }[] = [
  { id: 'packaging_date', label: '📦 Ngày đóng gói (DD/MM)', shortLabel: 'Đóng gói' },
  { id: 'peeling_date', label: '🔪 Ngày sản xuất (bóc múi)', shortLabel: 'Sản xuất' },
  { id: 'raw_material_date', label: '🚛 Ngày nhập nguyên liệu', shortLabel: 'Nguyên liệu' },
  { id: 'inbound_date', label: '📥 Ngày nhập kho lạnh', shortLabel: 'Nhập kho' }
];

export interface UniqueProductItem {
  name: string;
  sku: string | null;
  aliases: string | null;
  unit: string;
  positionCount: number;
  totalQuantity: number;
  unitsMap: Map<string, number>;
  normName: string;
  unaccName: string;
  normSku: string;
  unaccSku: string;
  aliasList: Array<{
    raw: string;
    norm: string;
    unacc: string;
  }>;
}

export interface UniqueSttItem {
  stt: string;
  normStt: string;
  productName: string;
  sku: string | null;
  lotCode: string | null;
  positionCodes: string[];
  positionCount: number;
  totalQuantity: number;
  unit: string;
}

interface ZoneItem {
  id: string;
  name: string;
  code?: string;
  parent_id: string | null;
  system_type: string;
  display_order?: number | null;
  is_hall?: boolean | null;
}

export const isHallZone = (z: ZoneItem | null | undefined): boolean => {
  if (!z) return false;
  if (z.is_hall) return true;
  const nameUpper = (z.name || '').trim().toUpperCase();
  return (
    nameUpper.startsWith('SẢNH') ||
    nameUpper.startsWith('SÀNH') ||
    nameUpper.startsWith('SANH') ||
    nameUpper.includes('SẢNH') ||
    nameUpper.includes('SÀNH')
  );
};

interface PositionItem {
  id: string;
  code: string;
  lot_id: string | null;
  zone_ids: string[];
  stt?: string | null;
  lot_code?: string | null;
  product_name?: string | null;
  sku?: string | null;
  aliases?: string | null;
  unit?: string | null;
  tags?: string[];
  packaging_date?: string | null;
  peeling_date?: string | null;
  raw_material_date?: string | null;
  inbound_date?: string | null;
  material_zones?: string[];
  material_zone?: string | null;
  production_code?: string | null;
  batch_code?: string | null;
  production_place?: string | null;
  extra_info?: string | null;
  quantity?: number | null;
}

// ── CHUẨN HÓA VÀ ĐỊNH DẠNG ĐƠN VỊ TÍNH (Thùng / Kg / Sọt...) ──────────────
export const getCleanUnitCategory = (rawUnit?: string | null): string => {
  const u = (rawUnit || '').trim();
  if (!u) return 'Thùng';
  const lower = u.toLowerCase();
  if (lower.startsWith('thùng') || lower.startsWith('thung') || lower === 'th') return 'Thùng';
  if (lower === 'kg' || lower === 'kilogram' || lower === 'kí' || lower === 'ký') return 'Kg';
  if (lower.startsWith('sọt') || lower.startsWith('sot')) return 'Sọt';
  return u;
};

export const formatUnitsSummary = (
  unitsMap?: Map<string, number> | Record<string, number> | null,
  options?: { short?: boolean }
): string => {
  if (!unitsMap) return options?.short ? '0 th' : '0 Thùng';
  const entries =
    unitsMap instanceof Map ? Array.from(unitsMap.entries()) : Object.entries(unitsMap);
  const valid = entries.filter(([_, q]) => q > 0);
  if (valid.length === 0) return options?.short ? '0 th' : '0 Thùng';

  // Ưu tiên hiển thị Thùng trước, sau đó Kg, Sọt
  valid.sort(([uA], [uB]) => {
    const priority = (u: string) => (u === 'Thùng' ? 1 : u === 'Kg' ? 2 : u === 'Sọt' ? 3 : 4);
    const pA = priority(uA);
    const pB = priority(uB);
    if (pA !== pB) return pA - pB;
    return uA.localeCompare(uB);
  });

  return valid
    .map(([u, q]) => {
      const numStr = Number.isInteger(q)
        ? q.toLocaleString('vi-VN')
        : Number(q.toFixed(2)).toLocaleString('vi-VN');
      const label = options?.short && u === 'Thùng' ? 'th' : u;
      return `${numStr} ${label}`;
    })
    .join(' · ');
};

export const formatPositionQtyUnit = (qty?: number | null, unit?: string | null): string => {
  if (!qty) return '';
  const cleanCat = getCleanUnitCategory(unit);
  const shortU = cleanCat === 'Thùng' ? 'th' : cleanCat;
  const numStr = Number.isInteger(qty)
    ? qty.toLocaleString('vi-VN')
    : Number(qty.toFixed(2)).toLocaleString('vi-VN');
  return `${numStr} ${shortU}`;
};

export const formatDateVN = (d?: string | null): string => {
  if (!d) return '--/--/----';
  const clean = String(d).split('T')[0];
  const parts = clean.split('-');
  if (parts.length === 3) {
    const [y, m, day] = parts;
    if (y.length === 4) return `${day.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
  }
  return d;
};

export const formatDateShortVN = (d?: string | null): string => {
  if (!d) return '';
  const clean = String(d).split('T')[0];
  const parts = clean.split('-');
  if (parts.length === 3) {
    const [y, m, day] = parts;
    const shortYear = y.length === 4 ? y.slice(2) : y;
    return `${day.padStart(2, '0')}/${m.padStart(2, '0')}/${shortYear}`;
  }
  return d;
};

export const getPositionTag = (pos: PositionItem): string | null => {
  if (pos.tags && pos.tags.length > 0) {
    const validTags = pos.tags.filter(t => t && !t.startsWith('MERGED_FROM:') && !t.startsWith('MERGED_DATA:'));
    if (validTags.length > 0) return validTags.join(', ');
  }
  return null;
};

// ── ISOLATED MEMOIZED SEARCH BAR (0ms Latency: typing updates only this component) ──
const MobileWarehouseSearchBar = React.memo(function MobileWarehouseSearchBar({
  uniqueProducts,
  uniqueStts,
  searchQuery,
  onExecuteSearch,
  onClearSearch,
  filterDateType,
  onFilterDateTypeChange,
  filterStartDate,
  onFilterStartDateChange,
  filterEndDate,
  onFilterEndDateChange,
  filterRegion,
  onFilterRegionChange,
  availableRegions,
  hasActiveFilters,
  onSetDatePreset,
  onResetFilters,
  isFilterOpen,
  onToggleFilterOpen
}: {
  uniqueProducts: UniqueProductItem[];
  uniqueStts: UniqueSttItem[];
  searchQuery: string;
  onExecuteSearch: (query: string) => void;
  onClearSearch: () => void;
  filterDateType: DateFilterType;
  onFilterDateTypeChange: (type: DateFilterType) => void;
  filterStartDate: string;
  onFilterStartDateChange: (val: string) => void;
  filterEndDate: string;
  onFilterEndDateChange: (val: string) => void;
  filterRegion: string;
  onFilterRegionChange: (val: string) => void;
  availableRegions: { name: string; count: number }[];
  hasActiveFilters: boolean;
  onSetDatePreset: (preset: 'today' | 3 | 7 | 'this_month' | 'clear') => void;
  onResetFilters: () => void;
  isFilterOpen: boolean;
  onToggleFilterOpen: () => void;
}) {
  const [inputValue, setInputValue] = useState(searchQuery);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Calendar picker state for mobile Từ ngày / Đến ngày
  const [calendarTarget, setCalendarTarget] = useState<'start' | 'end' | null>(null);
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    setInputValue(searchQuery);
  }, [searchQuery]);

  const openCalendar = (target: 'start' | 'end') => {
    const currentVal = target === 'start' ? filterStartDate : filterEndDate;
    if (currentVal && /^\d{4}-\d{2}-\d{2}$/.test(currentVal)) {
      const [y, m] = currentVal.split('-').map(Number);
      setCalYear(y);
      setCalMonth(m - 1);
    } else {
      const now = new Date();
      setCalYear(now.getFullYear());
      setCalMonth(now.getMonth());
    }
    setCalendarTarget(target);
  };

  const sttSuggestions = useMemo(() => {
    const q = inputValue.trim();
    if (!q || q.length < 1) return [];

    const unaccQ = normalizeSearchString(q, true);
    const cleanSttQ = unaccQ.replace(/^(#|stt[:\s-#]*)/i, '').trim();
    if (!cleanSttQ) return [];

    const list: Array<{
      item: UniqueSttItem;
      score: number;
    }> = [];

    for (let i = 0; i < uniqueStts.length; i++) {
      const sttItem = uniqueStts[i];
      let score = 0;

      if (sttItem.normStt === cleanSttQ) {
        score = 5000;
      } else if (sttItem.normStt.startsWith(cleanSttQ)) {
        score = 4000 - sttItem.normStt.length;
      } else if (sttItem.normStt.includes(cleanSttQ)) {
        score = 3000 - sttItem.normStt.length;
      }

      if (score > 0) {
        list.push({ item: sttItem, score });
      }
    }

    return list.sort((a, b) => b.score - a.score).slice(0, 6);
  }, [inputValue, uniqueStts]);

  const suggestions = useMemo(() => {
    const q = inputValue.trim();
    if (!q || q.length < 1) return [];
    // Nếu người dùng gõ tiền tố # hoặc stt để tìm đích danh STT thì chỉ hiện gợi ý STT
    if (/^(#|stt[:\s-#]+)/i.test(q)) return [];

    const normQ = normalizeSearchString(q);
    const unaccQ = normalizeSearchString(q, true);
    if (!normQ && !unaccQ) return [];

    const list: Array<{
      product: UniqueProductItem;
      score: number;
      matchedAlias?: string;
    }> = [];

    for (let i = 0; i < uniqueProducts.length; i++) {
      const prod = uniqueProducts[i];
      let matched = false;
      let score = 0;
      let matchedAlias: string | undefined;

      // 1. Alias check (tên viết tắt / gõ tắt: VD "đô c" -> "đô c có hạt")
      for (let j = 0; j < prod.aliasList.length; j++) {
        const al = prod.aliasList[j];
        if (al.norm === normQ || al.unacc === unaccQ) {
          matched = true;
          score = 3000;
          matchedAlias = al.raw;
          break;
        } else if (al.norm.startsWith(normQ) || al.unacc.startsWith(unaccQ)) {
          matched = true;
          score = 2200;
          matchedAlias = al.raw;
          break;
        } else if (al.norm.includes(normQ) || al.unacc.includes(unaccQ)) {
          matched = true;
          score = 1500;
          matchedAlias = al.raw;
          break;
        }
      }

      // 2. Name check
      if (!matched) {
        if (prod.normName === normQ || prod.unaccName === unaccQ) {
          matched = true;
          score = 2000;
        } else if (prod.normName.startsWith(normQ) || prod.unaccName.startsWith(unaccQ)) {
          matched = true;
          score = 1200;
        } else if (prod.normName.includes(normQ) || prod.unaccName.includes(unaccQ)) {
          matched = true;
          score = 800;
        }
      }

      // 3. SKU check
      if (!matched && (prod.normSku || prod.unaccSku)) {
        if (prod.normSku === normQ || prod.unaccSku === unaccQ) {
          matched = true;
          score = 1000;
        } else if (prod.normSku.includes(normQ) || prod.unaccSku.includes(unaccQ)) {
          matched = true;
          score = 500;
        }
      }

      if (matched) {
        list.push({ product: prod, score, matchedAlias });
      }
    }

    return list.sort((a, b) => b.score - a.score).slice(0, 6);
  }, [inputValue, uniqueProducts]);

  const totalSuggestionCount = sttSuggestions.length + suggestions.length;

  const handleSelect = (name: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputValue(name);
    setShowSuggestions(false);
    onExecuteSearch(name);
  };

  const handleSelectStt = (stt: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const sttQuery = `#${stt}`;
    setInputValue(sttQuery);
    setShowSuggestions(false);
    onExecuteSearch(sttQuery);
  };

  const handleSubmit = (customTerm?: string) => {
    const term = (customTerm !== undefined ? customTerm : inputValue).trim();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowSuggestions(false);
    onExecuteSearch(term);
  };

  const activeDateOption = DATE_FILTER_OPTIONS.find(o => o.id === filterDateType) || DATE_FILTER_OPTIONS[0];

  return (
    <View style={styles.searchSection}>
      <View style={styles.searchInputRow}>
        <View style={styles.searchInputWrap}>
          <Ionicons name="search" size={16} color="#94a3b8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={inputValue}
            onChangeText={txt => {
              setInputValue(txt);
              setShowSuggestions(true);
            }}
            onFocus={() => {
              if (inputValue.trim().length > 0) setShowSuggestions(true);
            }}
            onSubmitEditing={() => handleSubmit()}
            returnKeyType="search"
            placeholder="Tìm STT lot (VD: G44), tên/mã SP, vị trí..."
            placeholderTextColor="#64748b"
          />
          {inputValue.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setInputValue('');
                setShowSuggestions(false);
                onClearSearch();
              }}
              style={styles.clearSearchBtn}
            >
              <Ionicons name="close-circle" size={18} color="#94a3b8" />
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={styles.searchSubmitBtn}
          onPress={() => handleSubmit()}
        >
          <Ionicons name="search" size={13} color="#0f172a" />
          <Text style={styles.searchSubmitBtnText}>Tìm</Text>
        </TouchableOpacity>

        {/* Nút Bật/Tắt Bộ Lọc Ngày Tháng & Vùng Miền (Chuẩn Web /scanner) */}
        <TouchableOpacity
          style={[
            styles.filterToggleBtn,
            hasActiveFilters && styles.filterToggleBtnActiveAmber,
            !hasActiveFilters && isFilterOpen && styles.filterToggleBtnActiveCyan
          ]}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onToggleFilterOpen();
          }}
        >
          <Ionicons
            name="calendar-outline"
            size={14}
            color={hasActiveFilters ? '#0f172a' : isFilterOpen ? '#22d3ee' : '#cbd5e1'}
          />
          <Text
            style={[
              styles.filterToggleBtnText,
              hasActiveFilters && { color: '#0f172a', fontWeight: '900' },
              !hasActiveFilters && isFilterOpen && { color: '#22d3ee' }
            ]}
          >
            Lọc ngày
          </Text>
          {hasActiveFilters && <View style={styles.filterActiveDot} />}
        </TouchableOpacity>
      </View>

      {/* Thanh Chip hiển thị nhanh các bộ lọc đang áp dụng (Khi đóng bảng lọc) */}
      {hasActiveFilters && !isFilterOpen && (
        <View style={styles.activeFilterChipsBar}>
          <Text style={styles.activeFilterLabel}>Đang lọc:</Text>
          {(filterStartDate || filterEndDate) && (
            <TouchableOpacity
              style={styles.activeFilterChipAmber}
              onPress={onToggleFilterOpen}
            >
              <Ionicons name="calendar" size={11} color="#fcd34d" />
              <Text style={styles.activeFilterChipAmberText}>
                {activeDateOption.shortLabel}:{' '}
                {filterStartDate ? formatDateShortVN(filterStartDate) : '...'}
                {' → '}
                {filterEndDate ? formatDateShortVN(filterEndDate) : '...'}
              </Text>
              <TouchableOpacity
                onPress={() => onSetDatePreset('clear')}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name="close" size={12} color="#fcd34d" />
              </TouchableOpacity>
            </TouchableOpacity>
          )}

          {filterRegion && filterRegion !== 'all' && (
            <TouchableOpacity
              style={styles.activeFilterChipEmerald}
              onPress={onToggleFilterOpen}
            >
              <Ionicons name="location" size={11} color="#6ee7b7" />
              <Text style={styles.activeFilterChipEmeraldText}>Vùng: {filterRegion}</Text>
              <TouchableOpacity
                onPress={() => onFilterRegionChange('all')}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name="close" size={12} color="#6ee7b7" />
              </TouchableOpacity>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={onResetFilters} style={{ marginLeft: 'auto' }}>
            <Text style={styles.resetFilterLinkText}>Đặt lại</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── BẢNG BỘ LỌC NGÀY THÁNG & VÙNG MIỀN MỞ RỘNG (CHUẨN WEB /SCANNER) ── */}
      {isFilterOpen && (
        <View style={styles.filterDrawerCard}>
          <View style={styles.filterDrawerHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="options-outline" size={14} color="#22d3ee" />
              <Text style={styles.filterDrawerTitle}>BỘ LỌC NGÀY THÁNG & VÙNG MIỀN</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {hasActiveFilters && (
                <TouchableOpacity onPress={onResetFilters}>
                  <Text style={styles.filterDrawerResetText}>Xóa hết lọc</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onToggleFilterOpen}>
                <Ionicons name="close" size={16} color="#94a3b8" />
              </TouchableOpacity>
            </View>
          </View>

          {/* 1. Chọn loại ngày cần lọc */}
          <View style={{ gap: 5 }}>
            <Text style={styles.filterFieldLabel}>Mốc ngày:</Text>
            <View style={styles.dateTypeOptionsWrap}>
              {DATE_FILTER_OPTIONS.map(opt => {
                const isSel = filterDateType === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[styles.dateTypeOptionBtn, isSel && styles.dateTypeOptionBtnActive]}
                    onPress={() => onFilterDateTypeChange(opt.id)}
                  >
                    <Text style={[styles.dateTypeOptionText, isSel && styles.dateTypeOptionTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* 2. Từ ngày - Đến ngày */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.filterFieldLabel}>Từ ngày:</Text>
              <TouchableOpacity
                style={styles.datePickerTriggerBtn}
                onPress={() => openCalendar('start')}
              >
                <Ionicons name="calendar-outline" size={13} color="#38bdf8" />
                <Text style={[styles.datePickerTriggerText, !filterStartDate && { color: '#64748b' }]}>
                  {filterStartDate ? formatDateVN(filterStartDate) : 'Chọn ngày...'}
                </Text>
                {filterStartDate ? (
                  <TouchableOpacity onPress={() => onFilterStartDateChange('')}>
                    <Ionicons name="close-circle" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                ) : null}
              </TouchableOpacity>
            </View>

            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.filterFieldLabel}>Đến ngày:</Text>
              <TouchableOpacity
                style={styles.datePickerTriggerBtn}
                onPress={() => openCalendar('end')}
              >
                <Ionicons name="calendar-outline" size={13} color="#38bdf8" />
                <Text style={[styles.datePickerTriggerText, !filterEndDate && { color: '#64748b' }]}>
                  {filterEndDate ? formatDateVN(filterEndDate) : 'Chọn ngày...'}
                </Text>
                {filterEndDate ? (
                  <TouchableOpacity onPress={() => onFilterEndDateChange('')}>
                    <Ionicons name="close-circle" size={14} color="#94a3b8" />
                  </TouchableOpacity>
                ) : null}
              </TouchableOpacity>
            </View>
          </View>

          {/* Nút chọn nhanh khoảng ngày */}
          <View style={styles.datePresetsRow}>
            {[
              { id: 'today' as const, label: 'Hôm nay' },
              { id: 3 as const, label: '3 ngày' },
              { id: 7 as const, label: '7 ngày' },
              { id: 'this_month' as const, label: 'Tháng này' }
            ].map(p => (
              <TouchableOpacity
                key={String(p.id)}
                style={styles.datePresetBtn}
                onPress={() => onSetDatePreset(p.id)}
              >
                <Text style={styles.datePresetBtnText}>{p.label}</Text>
              </TouchableOpacity>
            ))}
            {(filterStartDate || filterEndDate) && (
              <TouchableOpacity
                style={[styles.datePresetBtn, { borderColor: '#f43f5e55', backgroundColor: '#4c051966' }]}
                onPress={() => onSetDatePreset('clear')}
              >
                <Text style={[styles.datePresetBtnText, { color: '#fda4af' }]}>✕ Xóa ngày</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* 3. Lọc theo Vùng miền / Vùng nguyên liệu */}
          <View style={{ gap: 5, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#1e293b' }}>
            <Text style={styles.filterFieldLabel}>Vùng miền / Vùng nguyên liệu:</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              <TouchableOpacity
                style={[
                  styles.regionOptionPill,
                  (!filterRegion || filterRegion === 'all') && styles.regionOptionPillActive
                ]}
                onPress={() => onFilterRegionChange('all')}
              >
                <Text
                  style={[
                    styles.regionOptionPillText,
                    (!filterRegion || filterRegion === 'all') && styles.regionOptionPillTextActive
                  ]}
                >
                  Tất cả vùng miền
                </Text>
              </TouchableOpacity>
              {availableRegions.map(r => {
                const isSel = filterRegion === r.name;
                return (
                  <TouchableOpacity
                    key={r.name}
                    style={[styles.regionOptionPill, isSel && styles.regionOptionPillActive]}
                    onPress={() => onFilterRegionChange(r.name)}
                  >
                    <Text style={[styles.regionOptionPillText, isSel && styles.regionOptionPillTextActive]}>
                      {r.name} ({r.count})
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      )}

      {/* Modal chọn ngày lịch cho Từ ngày / Đến ngày */}
      <Modal
        visible={calendarTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setCalendarTarget(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setCalendarTarget(null)}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={[styles.modalContent, { padding: 14 }]}
            onPress={e => e.stopPropagation()}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {calendarTarget === 'start' ? '📅 CHỌN TỪ NGÀY' : '📅 CHỌN ĐẾN NGÀY'}
              </Text>
              <TouchableOpacity onPress={() => setCalendarTarget(null)}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {/* Điều hướng Tháng / Năm */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
              <TouchableOpacity
                style={styles.calNavBtn}
                onPress={() => {
                  if (calMonth === 0) {
                    setCalMonth(11);
                    setCalYear(y => y - 1);
                  } else {
                    setCalMonth(m => m - 1);
                  }
                }}
              >
                <Ionicons name="chevron-back" size={18} color="#38bdf8" />
              </TouchableOpacity>
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>
                Tháng {calMonth + 1} / {calYear}
              </Text>
              <TouchableOpacity
                style={styles.calNavBtn}
                onPress={() => {
                  if (calMonth === 11) {
                    setCalMonth(0);
                    setCalYear(y => y + 1);
                  } else {
                    setCalMonth(m => m + 1);
                  }
                }}
              >
                <Ionicons name="chevron-forward" size={18} color="#38bdf8" />
              </TouchableOpacity>
            </View>

            {/* Lưới ngày trong tháng */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-start' }}>
              {Array.from({ length: new Date(calYear, calMonth + 1, 0).getDate() }, (_, i) => i + 1).map(day => {
                const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const currentVal = calendarTarget === 'start' ? filterStartDate : filterEndDate;
                const isSelected = currentVal === dateStr;
                return (
                  <TouchableOpacity
                    key={day}
                    style={[styles.calDayCell, isSelected && styles.calDayCellSelected]}
                    onPress={() => {
                      if (calendarTarget === 'start') onFilterStartDateChange(dateStr);
                      else onFilterEndDateChange(dateStr);
                      setCalendarTarget(null);
                    }}
                  >
                    <Text style={[styles.calDayText, isSelected && styles.calDayTextSelected]}>
                      {day}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── DROPDOWN GỢI Ý STT LOT & SẢN PHẨM ── */}
      {showSuggestions && inputValue.trim().length > 0 && (
        <View style={styles.suggestionsCard}>
          <View style={styles.suggestionsHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Ionicons name="sparkles" size={12} color="#fbbf24" />
              <Text style={styles.suggestionsHeaderTitle}>
                GỢI Ý TÌM KIẾM ({totalSuggestionCount})
              </Text>
            </View>
            <TouchableOpacity onPress={() => setShowSuggestions(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={14} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {totalSuggestionCount > 0 ? (
            <ScrollView style={{ maxHeight: 240 }} keyboardShouldPersistTaps="handled">
              {/* Gợi ý theo STT của LOT */}
              {sttSuggestions.map((entry, idx) => (
                <TouchableOpacity
                  key={'stt_' + entry.item.stt + '_' + idx}
                  style={styles.suggestionItem}
                  onPress={() => handleSelectStt(entry.item.stt)}
                >
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <View style={styles.posSttBadge}>
                        <Text style={styles.posSttBadgeText}>STT: #{entry.item.stt}</Text>
                      </View>
                      <Text style={[styles.suggestionTitle, { flex: 1 }]} numberOfLines={1}>
                        {entry.item.productName}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 3 }}>
                      <Text style={styles.suggestionCountBadge}>
                        📍 {entry.item.positionCount === 1
                          ? entry.item.positionCodes[0]
                          : `${entry.item.positionCount} vị trí (${entry.item.positionCodes.slice(0, 2).join(', ')})`}
                      </Text>
                      {entry.item.totalQuantity > 0 ? (
                        <Text style={[styles.suggestionMeta, { color: '#34d399', fontWeight: '700' }]}>
                          📦 {formatPositionQtyUnit(entry.item.totalQuantity, entry.item.unit)}
                        </Text>
                      ) : null}
                      {entry.item.lotCode ? (
                        <Text style={styles.suggestionMeta}>LOT: {entry.item.lotCode}</Text>
                      ) : null}
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={14} color="#f59e0b" />
                </TouchableOpacity>
              ))}

              {/* Gợi ý theo Tên / Mã Sản phẩm */}
              {suggestions.map((item, idx) => (
                <TouchableOpacity
                  key={'prod_' + idx}
                  style={styles.suggestionItem}
                  onPress={() => handleSelect(item.product.name)}
                >
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                      <Text style={styles.suggestionTitle} numberOfLines={1}>
                        {item.product.name}
                      </Text>
                      {item.matchedAlias ? (
                        <View style={styles.suggestionAliasBadge}>
                          <Text style={styles.suggestionAliasText}>⚡ {item.matchedAlias}</Text>
                        </View>
                      ) : item.product.aliases ? (
                        <View style={styles.suggestionAliasBadge}>
                          <Text style={styles.suggestionAliasText}>⚡ {item.product.aliases}</Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
                      <Text style={styles.suggestionCountBadge}>
                        📍 {item.product.positionCount} vị trí
                      </Text>
                      {item.product.totalQuantity > 0 && (
                        <Text style={[styles.suggestionMeta, { color: '#fbbf24', fontWeight: '700' }]}>
                          📦 {formatUnitsSummary(item.product.unitsMap, { short: true })}
                        </Text>
                      )}
                      {item.product.sku && item.product.sku !== '---' ? (
                        <Text style={styles.suggestionMeta}>SKU: {item.product.sku}</Text>
                      ) : null}
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={14} color="#38bdf8" />
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <View style={{ padding: 12, alignItems: 'center' }}>
              <Text style={{ color: '#94a3b8', fontSize: 11 }}>Không có STT hoặc sản phẩm nào khớp từ khóa</Text>
            </View>
          )}

          {/* Direct search option */}
          <TouchableOpacity
            style={styles.suggestionDirectBtn}
            onPress={() => handleSubmit()}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
              <Ionicons name="search" size={12} color="#38bdf8" />
              <Text style={styles.suggestionDirectText} numberOfLines={1}>
                Tìm tất cả vị trí cho "{inputValue.trim()}"
              </Text>
            </View>
            <Text style={styles.suggestionDirectSub}>Tìm ngay →</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

export default function WarehouseMapScreen({ onBackToScanner }: { onBackToScanner: () => void }) {
  const initialMemory = getMemoryWarehouseMapCache();
  const hasMemoryCache = Boolean(initialMemory && initialMemory.positions && initialMemory.positions.length > 0);

  const [loading, setLoading] = useState(!hasMemoryCache);
  const [refreshing, setRefreshing] = useState(false);
  const [zones, setZones] = useState<ZoneItem[]>(initialMemory?.zones || []);
  const [positions, setPositions] = useState<PositionItem[]>(initialMemory?.positions || []);

  // Hierarchy Navigation: Kho -> Dãy/Sảnh -> Ô -> Tầng
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>('all');
  const [selectedAisleId, setSelectedAisleId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [expandedTierIds, setExpandedTierIds] = useState<Set<string>>(new Set());
  const [onlyShowMatches, setOnlyShowMatches] = useState(true);

  // Search state (searchQuery drives the map, while typing is fully isolated in MobileWarehouseSearchBar)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTab, setSearchTab] = useState<'map' | 'breakdown'>('breakdown');
  const [expandedWhIds, setExpandedWhIds] = useState<Set<string>>(new Set());
  const [expandedAisleIds, setExpandedAisleIds] = useState<Set<string>>(new Set());
  const [expandedSlotIds, setExpandedSlotIds] = useState<Set<string>>(new Set());
  const [expandedBreakdownTierIds, setExpandedBreakdownTierIds] = useState<Set<string>>(new Set());
  const [highlightedPosId, setHighlightedPosId] = useState<string | null>(null);

  // Advanced Filter State: Date Range & Material Region (Chuẩn Web /scanner)
  const [filterDateType, setFilterDateType] = useState<DateFilterType>('packaging_date');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [filterRegion, setFilterRegion] = useState<string>('all');
  const [isFilterOpen, setIsFilterOpen] = useState<boolean>(false);

  // Modal detail
  const [selectedPosDetail, setSelectedPosDetail] = useState<PositionItem | null>(null);

  // Offline state
  const [isOffline, setIsOffline] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(initialMemory?.cachedAt || null);
  const [downloadingOffline, setDownloadingOffline] = useState(false);

  // ── Fetch Master Data (Zones, Positions, Lots) ─────────────────
  const loadMapData = useCallback(async (isSilent = false, forceSync = false) => {
    let hasCache = false;
    let hasIncompleteCachedLots = false;

    const checkLotsIncomplete = (posList: any[]) => {
      const occupied = (posList || []).filter((p: any) => p.lot_id && p.lot_id !== 'pending');
      // Chỉ coi là thiếu thông tin LOT khi có hàng trong kho nhưng KHÔNG có bất kỳ vị trí nào có lot_code (lỗi HTTP 414 cũ)
      return occupied.length > 0 && !occupied.some((p: any) => Boolean(p.lot_code));
    };

    // 0. Nếu đã có sẵn trong RAM cache và không ép sync (forceSync) -> dùng ngay 0ms, KHÔNG tải ngầm tự động!
    const mem = getMemoryWarehouseMapCache();
    if (!forceSync && mem && mem.zones && mem.zones.length > 0 && mem.positions && mem.positions.length > 0) {
      const isInc = checkLotsIncomplete(mem.positions);
      if (!isInc) {
        setLoading(false);
        setRefreshing(false);
        return;
      }
      hasCache = true;
      hasIncompleteCachedLots = isInc;
    }

    // 1. Đọc từ SQLite máy (nếu chưa có trong RAM)
    if (!hasCache) {
      try {
        const offline = await getWarehouseMapOfflineData();
        if (offline && offline.zones && offline.zones.length > 0) {
          setZones(offline.zones);
          setPositions(offline.positions);
          setCachedAt(offline.cachedAt);
          if (!selectedWarehouseId) {
            setSelectedWarehouseId('all');
          }
          hasCache = true;
          hasIncompleteCachedLots = checkLotsIncomplete(offline.positions);
          setLoading(false);
        }
      } catch {
        // ignore
      }
    }

    // Nếu không bấm nút Tải mới/Làm mới (forceSync === false) và máy đã có dữ liệu lưu sẵn đầy đủ -> DỪNG NGAY 0ms, tuyệt đối không tải ngầm!
    if (!forceSync && hasCache && !hasIncompleteCachedLots) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (!hasCache) {
      if (!isSilent) setLoading(true);
      else setRefreshing(true);
    } else {
      setRefreshing(true);
    }

    // 2. Chỉ tải từ máy chủ khi người dùng chủ động bấm nút Tải mới / Làm mới (forceSync = true) hoặc máy mới cài hoàn toàn trống dữ liệu
    try {
      const res = await syncWarehouseMapOffline();
      if (res.success) {
        if ((res as any).zones && (res as any).positions) {
          setZones((res as any).zones);
          setPositions((res as any).positions);
          setCachedAt(res.lastSyncedAt || new Date().toISOString());
          setIsOffline(false);
          if (!selectedWarehouseId) {
            setSelectedWarehouseId('all');
          }
        } else {
          const fresh = await getWarehouseMapOfflineData();
          if (fresh) {
            setZones(fresh.zones);
            setPositions(fresh.positions);
            setCachedAt(fresh.cachedAt);
            setIsOffline(false);
            if (!selectedWarehouseId) {
              setSelectedWarehouseId('all');
            }
          }
        }
      } else {
        const offline = await getWarehouseMapOfflineData();
        if (offline && offline.positions.length > 0) {
          setIsOffline(true);
        }
      }
    } catch (err: any) {
      console.warn('Lỗi tải dữ liệu sơ đồ kho trên mobile (dùng offline):', err);
      setIsOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedWarehouseId]);

  const handleDownloadOffline = async () => {
    setDownloadingOffline(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await syncWarehouseMapOffline();
      if (res.success) {
        if ((res as any).zones && (res as any).positions) {
          setZones((res as any).zones);
          setPositions((res as any).positions);
          setCachedAt(res.lastSyncedAt || new Date().toISOString());
          setIsOffline(false);
        } else {
          const fresh = await getWarehouseMapOfflineData();
          if (fresh) {
            setZones(fresh.zones);
            setPositions(fresh.positions);
            setCachedAt(fresh.cachedAt);
            setIsOffline(false);
          }
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          'Tải Ngoại Tuyến Thành Công!',
          `Đã lưu toàn bộ ${res.totalPositions} vị trí (${res.totalWarehouses} kho) vào bộ nhớ máy.\n\nNhân viên có thể yên tâm mang điện thoại vào kho đông để kiểm tra vị trí ngay cả khi không có sóng Wi-Fi/4G.`
        );
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Không thể tải', res.message || 'Vui lòng kiểm tra lại kết nối mạng');
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message || 'Không thể kết nối máy chủ');
    } finally {
      setDownloadingOffline(false);
    }
  };

  useEffect(() => {
    loadMapData();
  }, []);

  // ── Hierarchy Filtering ────────────────────────────────────────
  const sortZones = (list: ZoneItem[]) =>
    [...list].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })
    );

  // ── Ô Gộp (Group Warehouse Data) ───────────────────────────────
  const { groupedZones, virtualToRealMap } = useMemo(() => {
    if (zones.length === 0) {
      return { groupedZones: [], virtualToRealMap: new Map<string, string[]>() };
    }
    const res = groupWarehouseData(zones as any, positions as any);
    return {
      groupedZones: (res.zones as ZoneItem[]) || zones,
      virtualToRealMap: res.virtualToRealMap || new Map<string, string[]>()
    };
  }, [zones, positions]);

  const activeZones = groupedZones.length > 0 ? groupedZones : zones;

  const warehouses = useMemo(
    () => sortZones(activeZones.filter(z => !z.parent_id)),
    [activeZones]
  );

  // ── Pre-compute Zone Descendants Map & Full Paths ONCE (O(1) lookups) ──
  const { zoneDescendantsMap, zonePathMap } = useMemo(() => {
    const rzMap = new Map(zones.map(z => [z.id, z]));

    // 1. Precompute full path string for every real zone: Kho > Dãy > Ô > Tầng
    const pathMap = new Map<string, string>();
    zones.forEach(z => {
      const names: string[] = [];
      let curr: ZoneItem | undefined = z;
      while (curr) {
        names.unshift(curr.name);
        curr = curr.parent_id ? rzMap.get(curr.parent_id) : undefined;
      }
      pathMap.set(z.id, names.join(' > '));
    });

    // 2. Precompute children map for tree traversal
    const childrenMap = new Map<string, string[]>();
    zones.forEach(z => {
      if (z.parent_id) {
        const list = childrenMap.get(z.parent_id) || [];
        list.push(z.id);
        childrenMap.set(z.parent_id, list);
      }
    });

    const getRealChildren = (parentId: string): string[] => {
      const result: string[] = [];
      const stack = [parentId];
      while (stack.length > 0) {
        const curr = stack.pop()!;
        const kids = childrenMap.get(curr);
        if (kids) {
          for (let i = 0; i < kids.length; i++) {
            result.push(kids[i]);
            stack.push(kids[i]);
          }
        }
      }
      return result;
    };

    // 3. Precompute descendant set for all active zones (including virtual/grouped ones)
    const descMap = new Map<string, Set<string>>();
    activeZones.forEach(z => {
      const realIds = virtualToRealMap.get(z.id) || [z.id];
      const allDesc = new Set<string>(realIds);
      realIds.forEach(rid => {
        const children = getRealChildren(rid);
        for (let i = 0; i < children.length; i++) {
          allDesc.add(children[i]);
        }
      });
      descMap.set(z.id, allDesc);
    });

    return { zoneDescendantsMap: descMap, zonePathMap: pathMap };
  }, [zones, activeZones, virtualToRealMap]);

  // Helper to get ALL real zone descendants (O(1) lookup)
  const getDescendantZoneIds = useCallback(
    (targetZoneId: string): Set<string> => {
      return zoneDescendantsMap.get(targetZoneId) || new Set<string>([targetZoneId]);
    },
    [zoneDescendantsMap]
  );

  // Full path helper: Kho > Dãy > Ô > Tầng (O(1) lookup)
  const getPositionPath = useCallback(
    (pos: PositionItem) => {
      const leafZoneId = pos.zone_ids[0];
      if (!leafZoneId) return pos.code;
      return zonePathMap.get(leafZoneId) || pos.code;
    },
    [zonePathMap]
  );

  // ── Danh sách sản phẩm duy nhất đang có trong kho (Pre-indexed cho gợi ý 0ms) ──────────────
  const uniqueProducts = useMemo(() => {
    const prodMap = new Map<string, UniqueProductItem>();

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (p.product_name && p.lot_id) {
        const name = p.product_name.trim();
        const qty = p.quantity || 0;
        const unitCat = getCleanUnitCategory(p.unit);
        const existing = prodMap.get(name);
        if (existing) {
          existing.positionCount++;
          existing.totalQuantity += qty;
          existing.unitsMap.set(unitCat, (existing.unitsMap.get(unitCat) || 0) + qty);
          if (!existing.aliases && p.aliases) {
            existing.aliases = p.aliases;
            existing.aliasList = p.aliases.split(',').map(a => a.trim()).filter(Boolean).map(a => ({
              raw: a,
              norm: normalizeSearchString(a),
              unacc: normalizeSearchString(a, true)
            }));
          }
          if (!existing.sku && p.sku) {
            existing.sku = p.sku;
            existing.normSku = normalizeSearchString(p.sku);
            existing.unaccSku = normalizeSearchString(p.sku, true);
          }
        } else {
          const aliasList = (p.aliases || '').split(',').map(a => a.trim()).filter(Boolean).map(a => ({
            raw: a,
            norm: normalizeSearchString(a),
            unacc: normalizeSearchString(a, true)
          }));
          const uMap = new Map<string, number>();
          if (qty > 0) uMap.set(unitCat, qty);
          prodMap.set(name, {
            name,
            sku: p.sku || null,
            aliases: p.aliases || null,
            unit: unitCat,
            positionCount: 1,
            totalQuantity: qty,
            unitsMap: uMap,
            normName: normalizeSearchString(name),
            unaccName: normalizeSearchString(name, true),
            normSku: normalizeSearchString(p.sku || ''),
            unaccSku: normalizeSearchString(p.sku || '', true),
            aliasList
          });
        }
      }
    }

    return Array.from(prodMap.values());
  }, [positions]);

  // ── Danh sách STT LOT duy nhất đang có trong kho (Pre-indexed cho gợi ý 0ms) ──────────────
  const uniqueStts = useMemo(() => {
    const sttMap = new Map<string, UniqueSttItem>();

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (p.stt && p.lot_id) {
        const sttClean = String(p.stt).trim();
        if (!sttClean) continue;
        const key = sttClean.toUpperCase();
        const existing = sttMap.get(key);
        if (existing) {
          existing.positionCount++;
          if (!existing.positionCodes.includes(p.code)) {
            existing.positionCodes.push(p.code);
          }
          existing.totalQuantity += (p.quantity || 0);
          if ((!existing.productName || existing.productName === 'Hàng đông lạnh') && p.product_name) {
            existing.productName = p.product_name;
          }
          if (!existing.sku && p.sku) existing.sku = p.sku;
          if (!existing.lotCode && p.lot_code) existing.lotCode = p.lot_code;
        } else {
          sttMap.set(key, {
            stt: sttClean,
            normStt: normalizeSearchString(sttClean, true),
            productName: p.product_name || 'Hàng đông lạnh',
            sku: p.sku || null,
            lotCode: p.lot_code || null,
            positionCodes: [p.code],
            positionCount: 1,
            totalQuantity: p.quantity || 0,
            unit: p.unit || 'Thùng'
          });
        }
      }
    }

    return Array.from(sttMap.values());
  }, [positions]);

  // ── Danh sách các Vùng miền / Vùng nguyên liệu đang có trong kho ─────────
  const availableRegions = useMemo(() => {
    const regionCountMap = new Map<string, number>();
    positions.forEach(p => {
      const zonesList =
        p.material_zones && p.material_zones.length > 0
          ? p.material_zones
          : p.material_zone
          ? p.material_zone.split(',').map(s => s.trim()).filter(Boolean)
          : [];
      zonesList.forEach(z => {
        if (z && z !== '---') {
          regionCountMap.set(z, (regionCountMap.get(z) || 0) + 1);
        }
      });
    });

    return Array.from(regionCountMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [positions]);

  const hasActiveFilters = useMemo(() => {
    return !!(filterStartDate || filterEndDate || (filterRegion && filterRegion !== 'all'));
  }, [filterStartDate, filterEndDate, filterRegion]);

  const handleSetDatePreset = useCallback((preset: 'today' | 3 | 7 | 'this_month' | 'clear') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (preset === 'clear') {
      setFilterStartDate('');
      setFilterEndDate('');
      return;
    }

    const today = new Date();
    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    const todayStr = formatDate(today);

    if (preset === 'today') {
      setFilterStartDate(todayStr);
      setFilterEndDate(todayStr);
    } else if (typeof preset === 'number') {
      const start = new Date();
      start.setDate(today.getDate() - (preset - 1));
      setFilterStartDate(formatDate(start));
      setFilterEndDate(todayStr);
    } else if (preset === 'this_month') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      setFilterStartDate(formatDate(start));
      setFilterEndDate(todayStr);
    }
  }, []);

  const handleResetFilters = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterRegion('all');
  }, []);

  const handleClearAllSearchAndFilters = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSearchQuery('');
    setHighlightedPosId(null);
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterRegion('all');
    setSearchTab('breakdown');
  }, []);

  // Thực hiện tìm kiếm (cập nhật searchQuery để sơ đồ lọc và thống kê phân bổ)
  const handleExecuteSearch = useCallback((term: string) => {
    const q = term.trim();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSearchQuery(q);
    if (q) {
      setSearchTab('breakdown');
    }
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setHighlightedPosId(null);
    setSearchTab('breakdown');
  }, []);

  // ── Pre-compute Hierarchy Map & Ancestor Lookup ONCE in O(N) (Thay vì lọc lồng nhau O(N^2)) ──
  const { zoneHierarchyMap, realToActiveAncestorsMap } = useMemo(() => {
    const hierMap = new Map<string, { wh: ZoneItem; aisle: ZoneItem; slot: ZoneItem; tier?: ZoneItem }>();
    const ancestorsMap = new Map<string, string[]>();

    // Gom nhóm con theo parent_id trong 1 vòng lặp duy nhất O(N)
    const activeChildrenByParent = new Map<string, ZoneItem[]>();
    for (let i = 0; i < activeZones.length; i++) {
      const z = activeZones[i];
      if (z.parent_id) {
        const list = activeChildrenByParent.get(z.parent_id);
        if (list) list.push(z);
        else activeChildrenByParent.set(z.parent_id, [z]);
      }
    }

    const addAncestor = (realZid: string, activeZid: string) => {
      const list = ancestorsMap.get(realZid);
      if (list) {
        if (!list.includes(activeZid)) list.push(activeZid);
      } else {
        ancestorsMap.set(realZid, [activeZid]);
      }
    };

    warehouses.forEach(wh => {
      const whDesc = zoneDescendantsMap.get(wh.id);
      if (whDesc) whDesc.forEach(zid => addAncestor(zid, wh.id));

      const whAisles = activeChildrenByParent.get(wh.id) || [];
      whAisles.forEach(aisle => {
        const aisleDesc = zoneDescendantsMap.get(aisle.id);
        if (aisleDesc) aisleDesc.forEach(zid => addAncestor(zid, aisle.id));

        const aisleSlots = activeChildrenByParent.get(aisle.id) || [];
        if (aisleSlots.length > 0) {
          aisleSlots.forEach(slot => {
            const desc = zoneDescendantsMap.get(slot.id);
            if (desc) {
              desc.forEach(zid => {
                hierMap.set(zid, { wh, aisle, slot });
                addAncestor(zid, slot.id);
              });
            }
            const slotTiers = activeChildrenByParent.get(slot.id) || [];
            slotTiers.forEach(tier => {
              const tierDesc = zoneDescendantsMap.get(tier.id);
              if (tierDesc) {
                tierDesc.forEach(zid => {
                  hierMap.set(zid, { wh, aisle, slot, tier });
                  addAncestor(zid, tier.id);
                });
              }
            });
          });
        } else {
          if (aisleDesc) {
            aisleDesc.forEach(zid => {
              hierMap.set(zid, { wh, aisle, slot: aisle });
            });
          }
        }
      });
    });

    return { zoneHierarchyMap: hierMap, realToActiveAncestorsMap: ancestorsMap };
  }, [warehouses, activeZones, zoneDescendantsMap]);

  // Tập hợp tên sản phẩm chính xác để chọn gợi ý phản hồi tức thì 0ms (bỏ qua chuẩn hóa Unicode nặng)
  const exactProductNamesSet = useMemo(
    () => new Set(uniqueProducts.map(up => up.name)),
    [uniqueProducts]
  );

  // ── Search & Filter Logic (High Performance 0ms Fast-Path) ──
  const isSearchActive = !!searchQuery.trim() || hasActiveFilters;

  const matchingPositions = useMemo(() => {
    const q = searchQuery.trim();
    const hasQuery = q.length > 0;
    const hasDateFilter = !!(filterStartDate || filterEndDate);
    const hasRegionFilter = !!(filterRegion && filterRegion !== 'all');

    if (!hasQuery && !hasDateFilter && !hasRegionFilter) return [];

    // Fast-path flags tính 1 lần duy nhất bên ngoài vòng lặp 7.820 vị trí
    const isExactProductQuery = hasQuery && exactProductNamesSet.has(q);
    const isSttPrefixQuery = hasQuery && /^(#|stt[:\s-#]+)/i.test(q);
    const cleanSttQuery = isSttPrefixQuery
      ? normalizeSearchString(q, true).replace(/^(#|stt[:\s-#]*)/i, '').trim()
      : '';
    const isLikelyPositionCodeQuery = hasQuery && /^k\d/i.test(q);
    const normRegionFilter = hasRegionFilter ? normalizeSearchString(filterRegion, true) : '';

    const matched: { pos: PositionItem; score: number }[] = [];
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];

      // Nếu đang lọc ngày/vùng hoặc tìm sản phẩm/STT (không phải gõ mã vị trí K1...) -> bỏ qua ngay 5.800 ô trống!
      if (!p.lot_id && (hasDateFilter || hasRegionFilter || !isLikelyPositionCodeQuery)) {
        continue;
      }

      // 1. Lọc theo Ngày (Đóng gói / Sản xuất / Nguyên liệu / Nhập kho)
      if (hasDateFilter) {
        const posDate = p[filterDateType];
        if (!posDate) continue;
        if (filterStartDate && posDate < filterStartDate) continue;
        if (filterEndDate && posDate > filterEndDate) continue;
      }

      // 2. Lọc theo Vùng miền / Vùng nguyên liệu
      if (hasRegionFilter) {
        const pZones =
          p.material_zones && p.material_zones.length > 0
            ? p.material_zones
            : p.material_zone
            ? p.material_zone.split(',').map(s => s.trim()).filter(Boolean)
            : [];
        if (pZones.length === 0) continue;

        const matchedRegion = pZones.some(z => {
          const normZ = normalizeSearchString(z, true);
          return normZ.includes(normRegionFilter) || normRegionFilter.includes(normZ);
        });
        if (!matchedRegion) continue;
      }

      // 3. Lọc theo Từ khóa tìm kiếm
      if (hasQuery) {
        // FAST-PATH 1 (0ms): Khi người dùng bấm chọn trực tiếp dòng sản phẩm gợi ý
        if (isExactProductQuery) {
          if (p.product_name && p.product_name.trim() === q) {
            matched.push({ pos: p, score: 2000 });
          }
          continue;
        }

        // FAST-PATH 2 (0.5ms): Khi người dùng bấm chọn hoặc gõ tìm STT (#G44...)
        if (isSttPrefixQuery) {
          if (p.stt) {
            const sttNorm = String(p.stt).trim().toLowerCase();
            if (!cleanSttQuery || sttNorm.includes(cleanSttQuery)) {
              const score = sttNorm === cleanSttQuery ? 5000 : sttNorm.startsWith(cleanSttQuery) ? 3800 : 2600;
              matched.push({ pos: p, score });
            }
          }
          continue;
        }

        // Tìm kiếm tự do (gõ tắt, tên gần đúng...)
        if (matchPalletSearch(p, q)) {
          const score = calculateSearchScore(p, q, {
            stt: p.stt,
            name: p.product_name,
            code: p.code,
            lot_code: p.lot_code,
            aliases: p.aliases
          });
          matched.push({ pos: p, score });
        }
      } else {
        matched.push({ pos: p, score: 100 });
      }
    }

    if (hasQuery && !isExactProductQuery) {
      matched.sort((a, b) => b.score - a.score);
    }
    return matched.map(m => m.pos);
  }, [positions, searchQuery, filterDateType, filterStartDate, filterEndDate, filterRegion, exactProductNamesSet]);

  const matchingPosIds = useMemo(() => {
    return new Set(matchingPositions.map(p => p.id));
  }, [matchingPositions]);

  // Fast match count per zone in O(matchingPositions) (< 0.2ms thay vì 777.000 vòng lặp)
  const zoneMatchCountMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!isSearchActive || matchingPositions.length === 0) return map;

    for (let i = 0; i < matchingPositions.length; i++) {
      const p = matchingPositions[i];
      const countedForPos = new Set<string>();
      for (let j = 0; j < p.zone_ids.length; j++) {
        const ancestors = realToActiveAncestorsMap.get(p.zone_ids[j]);
        if (ancestors) {
          for (let k = 0; k < ancestors.length; k++) {
            countedForPos.add(ancestors[k]);
          }
        }
      }
      countedForPos.forEach(azId => {
        map.set(azId, (map.get(azId) || 0) + 1);
      });
    }

    return map;
  }, [isSearchActive, matchingPositions, realToActiveAncestorsMap]);

  // ── Thống kê phân bổ kết quả tìm kiếm (Báo cáo Kế toán: Kho -> Dãy -> Ô -> Tầng) ──
  const breakdownReport = useMemo(() => {
    if (!isSearchActive || matchingPositions.length === 0) return null;

    interface TierAcc {
      tier: ZoneItem;
      unitsMap: Map<string, number>;
      positionCount: number;
      positions: PositionItem[];
    }
    interface SlotAcc {
      slot: ZoneItem;
      unitsMap: Map<string, number>;
      positionCount: number;
      positions: PositionItem[];
      tiersMap: Map<string, TierAcc>;
    }
    interface AisleAcc {
      aisle: ZoneItem;
      unitsMap: Map<string, number>;
      positionCount: number;
      slotsMap: Map<string, SlotAcc>;
    }
    interface WhAcc {
      warehouse: ZoneItem;
      unitsMap: Map<string, number>;
      positionCount: number;
      aislesMap: Map<string, AisleAcc>;
    }

    const addQtyToMap = (map: Map<string, number>, unit: string, qty: number) => {
      map.set(unit, (map.get(unit) || 0) + qty);
    };

    const whMap = new Map<string, WhAcc>();
    const grandUnitsMap = new Map<string, number>();

    matchingPositions.forEach(p => {
      const qty = p.quantity || 0;
      const unitCat = getCleanUnitCategory(p.unit);
      addQtyToMap(grandUnitsMap, unitCat, qty);

      let hier: { wh: ZoneItem; aisle: ZoneItem; slot: ZoneItem; tier?: ZoneItem } | undefined;
      for (let i = 0; i < p.zone_ids.length; i++) {
        const found = zoneHierarchyMap.get(p.zone_ids[i]);
        if (found) {
          hier = found;
          if (found.tier) break;
        }
      }

      if (hier) {
        let whAcc = whMap.get(hier.wh.id);
        if (!whAcc) {
          whAcc = { warehouse: hier.wh, unitsMap: new Map(), positionCount: 0, aislesMap: new Map() };
          whMap.set(hier.wh.id, whAcc);
        }
        addQtyToMap(whAcc.unitsMap, unitCat, qty);
        whAcc.positionCount++;

        let aisleAcc = whAcc.aislesMap.get(hier.aisle.id);
        if (!aisleAcc) {
          aisleAcc = { aisle: hier.aisle, unitsMap: new Map(), positionCount: 0, slotsMap: new Map() };
          whAcc.aislesMap.set(hier.aisle.id, aisleAcc);
        }
        addQtyToMap(aisleAcc.unitsMap, unitCat, qty);
        aisleAcc.positionCount++;

        let slotAcc = aisleAcc.slotsMap.get(hier.slot.id);
        if (!slotAcc) {
          slotAcc = { slot: hier.slot, unitsMap: new Map(), positionCount: 0, positions: [], tiersMap: new Map() };
          aisleAcc.slotsMap.set(hier.slot.id, slotAcc);
        }
        addQtyToMap(slotAcc.unitsMap, unitCat, qty);
        slotAcc.positionCount++;
        slotAcc.positions.push(p);

        if (hier.tier) {
          let tierAcc = slotAcc.tiersMap.get(hier.tier.id);
          if (!tierAcc) {
            tierAcc = { tier: hier.tier, unitsMap: new Map(), positionCount: 0, positions: [] };
            slotAcc.tiersMap.set(hier.tier.id, tierAcc);
          }
          addQtyToMap(tierAcc.unitsMap, unitCat, qty);
          tierAcc.positionCount++;
          tierAcc.positions.push(p);
        }
      }
    });

    const getMapTotal = (map: Map<string, number>) => Array.from(map.values()).reduce((s, v) => s + v, 0);

    const sortedWhs = Array.from(whMap.values())
      .sort((a, b) => getMapTotal(b.unitsMap) - getMapTotal(a.unitsMap) || b.positionCount - a.positionCount)
      .map(whAcc => {
        const sortedAisles = Array.from(whAcc.aislesMap.values())
          .sort((a, b) => getMapTotal(b.unitsMap) - getMapTotal(a.unitsMap) || b.positionCount - a.positionCount)
          .map(aisleAcc => {
            const sortedSlots = Array.from(aisleAcc.slotsMap.values())
              .sort((a, b) => {
                const oa = a.slot.display_order ?? 0;
                const ob = b.slot.display_order ?? 0;
                if (oa !== ob) return oa - ob;
                return (a.slot.name || '').localeCompare(b.slot.name || '', undefined, { numeric: true });
              })
              .map(slotAcc => {
                const sortedTiers = Array.from(slotAcc.tiersMap.values())
                  .sort((a, b) => {
                    const oa = a.tier.display_order ?? 0;
                    const ob = b.tier.display_order ?? 0;
                    if (oa !== ob) return oa - ob;
                    return (a.tier.name || '').localeCompare(b.tier.name || '', undefined, { numeric: true });
                  })
                  .map(tierAcc => ({
                    ...tierAcc,
                    positions: [...tierAcc.positions].sort((pa, pb) =>
                      (pa.code || '').localeCompare(pb.code || '', undefined, { numeric: true })
                    )
                  }));

                return {
                  slot: slotAcc.slot,
                  unitsMap: slotAcc.unitsMap,
                  positionCount: slotAcc.positionCount,
                  positions: [...slotAcc.positions].sort((pa, pb) =>
                    (pa.code || '').localeCompare(pb.code || '', undefined, { numeric: true })
                  ),
                  tiers: sortedTiers
                };
              });
            return {
              aisle: aisleAcc.aisle,
              unitsMap: aisleAcc.unitsMap,
              positionCount: aisleAcc.positionCount,
              slots: sortedSlots
            };
          });
        return {
          warehouse: whAcc.warehouse,
          unitsMap: whAcc.unitsMap,
          positionCount: whAcc.positionCount,
          aisles: sortedAisles
        };
      });

    const grandTotalQty = Array.from(grandUnitsMap.values()).reduce((s, v) => s + v, 0);

    return {
      grandUnitsMap,
      grandTotalQty,
      totalPositions: matchingPositions.length,
      warehouses: sortedWhs
    };
  }, [isSearchActive, matchingPositions, zoneHierarchyMap]);

  // Tự động mở rộng các kho có hàng khi tìm kiếm
  useEffect(() => {
    if (breakdownReport?.warehouses) {
      setExpandedWhIds(new Set(breakdownReport.warehouses.map(w => w.warehouse.id)));
      const allAisles = new Set<string>();
      breakdownReport.warehouses.forEach(w => w.aisles.forEach(a => allAisles.add(a.aisle.id)));
      setExpandedAisleIds(allAisles);
      setExpandedSlotIds(new Set());
      setExpandedBreakdownTierIds(new Set());
    }
  }, [breakdownReport]);

  const toggleWarehouseExpand = useCallback((whId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedWhIds(prev => {
      const next = new Set(prev);
      if (next.has(whId)) next.delete(whId);
      else next.add(whId);
      return next;
    });
  }, []);

  const toggleAisleExpand = useCallback((aisleId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedAisleIds(prev => {
      const next = new Set(prev);
      if (next.has(aisleId)) next.delete(aisleId);
      else next.add(aisleId);
      return next;
    });
  }, []);

  const toggleSlotExpand = useCallback((slotId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedSlotIds(prev => {
      const next = new Set(prev);
      if (next.has(slotId)) next.delete(slotId);
      else next.add(slotId);
      return next;
    });
  }, []);

  const toggleBreakdownTierExpand = useCallback((tierId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedBreakdownTierIds(prev => {
      const next = new Set(prev);
      if (next.has(tierId)) next.delete(tierId);
      else next.add(tierId);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (breakdownReport) {
      setExpandedWhIds(new Set(breakdownReport.warehouses.map(w => w.warehouse.id)));
      const allAisles = new Set<string>();
      const allSlots = new Set<string>();
      breakdownReport.warehouses.forEach(w =>
        w.aisles.forEach(a => {
          allAisles.add(a.aisle.id);
          a.slots.forEach(s => allSlots.add(s.slot.id));
        })
      );
      setExpandedAisleIds(allAisles);
      setExpandedSlotIds(allSlots);
    }
  }, [breakdownReport]);

  const handleCollapseAll = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedWhIds(new Set());
    setExpandedAisleIds(new Set());
    setExpandedSlotIds(new Set());
    setExpandedBreakdownTierIds(new Set());
  }, []);

  // Khi đang tìm kiếm, chỉ hiển thị các Kho có vị trí khớp trên Sơ đồ
  const visibleWarehouses = useMemo(() => {
    if (!isSearchActive) return warehouses;
    return warehouses.filter(wh => (zoneMatchCountMap.get(wh.id) || 0) > 0);
  }, [warehouses, isSearchActive, zoneMatchCountMap]);

  const aisles = useMemo(() => {
    let list: ZoneItem[] = [];
    if (!selectedWarehouseId || selectedWarehouseId === 'all') {
      const whIds = new Set(warehouses.map(w => w.id));
      list = activeZones.filter(z => z.parent_id && whIds.has(z.parent_id));
    } else {
      list = activeZones.filter(z => z.parent_id === selectedWarehouseId);
    }

    if (isSearchActive) {
      return list
        .filter(z => (zoneMatchCountMap.get(z.id) || 0) > 0)
        .sort((a, b) => {
          const countA = zoneMatchCountMap.get(a.id) || 0;
          const countB = zoneMatchCountMap.get(b.id) || 0;
          if (countA !== countB) return countB - countA;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        });
    }

    return sortZones(list);
  }, [activeZones, selectedWarehouseId, warehouses, isSearchActive, zoneMatchCountMap]);

  // Slots -> Ô GỘP: Ô 01, Ô 02...
  const slots = useMemo(() => {
    if (!selectedAisleId) return [];
    const list = activeZones.filter(z => z.parent_id === selectedAisleId);
    if (isSearchActive) {
      return list
        .filter(z => (zoneMatchCountMap.get(z.id) || 0) > 0)
        .sort((a, b) => {
          const countA = zoneMatchCountMap.get(a.id) || 0;
          const countB = zoneMatchCountMap.get(b.id) || 0;
          if (countA !== countB) return countB - countA;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        });
    }
    return sortZones(list);
  }, [activeZones, selectedAisleId, isSearchActive, zoneMatchCountMap]);

  // Selected Aisle & Phát hiện khu vực SẢNH (Khu vực không chia Ô / Kệ)
  const selectedAisle = useMemo(() => {
    if (!selectedAisleId) return null;
    return activeZones.find(z => z.id === selectedAisleId) || null;
  }, [activeZones, selectedAisleId]);

  const isSelectedAisleHall = useMemo(() => {
    if (!selectedAisle) return false;
    const hasRealChildSlots = activeZones.some(z => z.parent_id === selectedAisle.id);
    return isHallZone(selectedAisle) || !hasRealChildSlots;
  }, [selectedAisle, activeZones]);

  // Tiers -> Tầng của Ô gộp (Sắp xếp từ tầng 1 đến tầng 5)
  const tiers = useMemo(() => {
    if (!selectedSlotId) return [];
    let list = activeZones.filter(z => z.parent_id === selectedSlotId);
    if (isSearchActive && onlyShowMatches) {
      list = list.filter(z => (zoneMatchCountMap.get(z.id) || 0) > 0);
    }
    return list.sort((a, b) => {
      const oa = a.display_order ?? 0;
      const ob = b.display_order ?? 0;
      if (oa !== ob) return oa - ob;
      return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
    });
  }, [activeZones, selectedSlotId, isSearchActive, onlyShowMatches, zoneMatchCountMap]);

  const toggleTierExpand = useCallback((tierId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedTierIds(prev => {
      const next = new Set(prev);
      if (next.has(tierId)) next.delete(tierId);
      else next.add(tierId);
      return next;
    });
  }, []);

  const handleExpandAllTiers = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedTierIds(new Set(tiers.map(t => t.id)));
  }, [tiers]);

  const handleCollapseAllTiers = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpandedTierIds(new Set());
  }, []);

  // Tự động mở rộng tầng khi có vị trí highlight
  useEffect(() => {
    if (!selectedSlotId || tiers.length === 0) return;
    if (highlightedPosId) {
      const targetPos = positions.find(p => p.id === highlightedPosId);
      if (targetPos) {
        const matchingTier = tiers.find(tier => {
          const desc = getDescendantZoneIds(tier.id);
          return targetPos.zone_ids.some(zid => desc.has(zid));
        });
        if (matchingTier) {
          setExpandedTierIds(prev => new Set([...prev, matchingTier.id]));
        }
      }
    }
  }, [highlightedPosId, selectedSlotId, tiers, positions, getDescendantZoneIds]);

  // ── Stats Calculator per Zone (O(Positions) Single-Pass thay vì O(Zones * Positions)) ───
  const zoneStatsMap = useMemo(() => {
    const map = new Map<string, { total: number; occupied: number; empty: number }>();
    if (activeZones.length === 0 || positions.length === 0) return map;

    for (let i = 0; i < activeZones.length; i++) {
      map.set(activeZones[i].id, { total: 0, occupied: 0, empty: 0 });
    }

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const isOcc = Boolean(p.lot_id);
      const seenActiveZones = new Set<string>();

      for (let j = 0; j < p.zone_ids.length; j++) {
        const realZid = p.zone_ids[j];
        const ancestors = realToActiveAncestorsMap.get(realZid);
        if (ancestors) {
          for (let k = 0; k < ancestors.length; k++) {
            seenActiveZones.add(ancestors[k]);
          }
        }
        // Cũng cộng cho chính realZid nếu nó nằm trong activeZones
        if (map.has(realZid)) {
          seenActiveZones.add(realZid);
        }
      }

      seenActiveZones.forEach(azId => {
        const st = map.get(azId);
        if (st) {
          st.total++;
          if (isOcc) st.occupied++;
        }
      });
    }

    map.forEach(st => {
      st.empty = Math.max(0, st.total - st.occupied);
    });

    return map;
  }, [activeZones, positions, realToActiveAncestorsMap]);

  // Thống kê phân loại (Kệ vs Sảnh) cho từng Kho (chuẩn theo Web)
  const getWhBreakdown = useCallback((whId: string) => {
    const directChildren = activeZones.filter(z => z.parent_id === whId);
    let rackTotal = 0;
    let rackOccupied = 0;
    let hallTotal = 0;
    let hallOccupied = 0;

    directChildren.forEach(child => {
      const isHall = isHallZone(child);
      const stats = zoneStatsMap.get(child.id) || { total: 0, occupied: 0, empty: 0 };
      if (isHall) {
        hallTotal += stats.total;
        hallOccupied += stats.occupied;
      } else {
        rackTotal += stats.total;
        rackOccupied += stats.occupied;
      }
    });

    return { rackTotal, rackOccupied, hallTotal, hallOccupied };
  }, [activeZones, zoneStatsMap]);

  // Current positions in Slot / Tier view & SẢNH (Hall)
  const currentPositions = useMemo(() => {
    // Nếu đang vào Sảnh (hoặc khu vực không phân chia ô tầng)
    if (isSelectedAisleHall) {
      if (!selectedAisleId) return [];
      const targetZoneIds = getDescendantZoneIds(selectedAisleId);
      let filtered = positions.filter(p =>
        p.zone_ids.some(zid => targetZoneIds.has(zid))
      );
      if (onlyShowMatches && isSearchActive) {
        filtered = filtered.filter(p => matchingPosIds.has(p.id));
      }
      return filtered.sort((a, b) =>
        a.code.localeCompare(b.code, undefined, { numeric: true })
      );
    }

    if (!selectedSlotId) return [];

    const targetZoneId = selectedTierId || selectedSlotId;
    const targetZoneIds = getDescendantZoneIds(targetZoneId);

    let filtered = positions.filter(p =>
      p.zone_ids.some(zid => targetZoneIds.has(zid))
    );

    if (onlyShowMatches && isSearchActive) {
      filtered = filtered.filter(p => matchingPosIds.has(p.id));
    }

    return filtered.sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true })
    );
  }, [
    isSelectedAisleHall,
    selectedAisleId,
    selectedSlotId,
    selectedTierId,
    positions,
    getDescendantZoneIds,
    onlyShowMatches,
    isSearchActive,
    matchingPosIds
  ]);

  // Group positions by tier when viewing all tiers in a Slot
  const tierPositionsMap = useMemo(() => {
    if (!selectedSlotId || selectedTierId) return null;
    const map = new Map<string, typeof positions>();
    tiers.forEach(tier => {
      const tierZoneIds = getDescendantZoneIds(tier.id);
      let posInTier = positions
        .filter(p => p.zone_ids.some(zid => tierZoneIds.has(zid)));
      if (onlyShowMatches && isSearchActive) {
        posInTier = posInTier.filter(p => matchingPosIds.has(p.id));
      }
      posInTier.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
      map.set(tier.id, posInTier);
    });
    return map;
  }, [selectedSlotId, selectedTierId, tiers, positions, getDescendantZoneIds, onlyShowMatches, isSearchActive, matchingPosIds]);

  // ── Jump to Position on Map ──
  const handleSelectSearchResult = (pos: PositionItem) => {
    const leafZoneId = pos.zone_ids[0];
    if (leafZoneId) {
      const realZoneMap = new Map(zones.map(z => [z.id, z]));
      let curr = realZoneMap.get(leafZoneId);
      const realPath: ZoneItem[] = [];

      while (curr) {
        realPath.unshift(curr);
        curr = curr.parent_id ? realZoneMap.get(curr.parent_id) : undefined;
      }

      if (realPath.length >= 1) setSelectedWarehouseId(realPath[0].id);
      if (realPath.length >= 2) {
        const aisleId = realPath[1].id;
        setSelectedAisleId(aisleId);

        if (realPath.length >= 3) {
          const realSlotId = realPath[2].id;
          const vSlot = activeZones.find(
            z => z.parent_id === aisleId && (z.id === realSlotId || virtualToRealMap.get(z.id)?.includes(realSlotId))
          );
          if (vSlot) {
            setSelectedSlotId(vSlot.id);

            if (realPath.length >= 4) {
              const realTierId = realPath[3].id;
              const vTier = activeZones.find(
                z => z.parent_id === vSlot.id && (z.id === realTierId || virtualToRealMap.get(z.id)?.includes(realTierId))
              );
              setSelectedTierId(vTier ? vTier.id : null);
            } else {
              setSelectedTierId(null);
            }
          }
        }
      }
    }

    setHighlightedPosId(pos.id);
    setSelectedPosDetail(pos);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleJumpToMap = (pos: PositionItem) => {
    handleSelectSearchResult(pos);
    setSearchTab('map');
  };

  const getZoneName = (id: string | null) => {
    if (!id || id === 'all') return 'Tất cả Kho';
    return activeZones.find(z => z.id === id)?.name || '';
  };

  return (
    <View style={styles.container}>
      {/* ── HEADER ────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={onBackToScanner}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="arrow-back" size={20} color="#cbd5e1" />
          </TouchableOpacity>
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.headerTitle}>SƠ ĐỒ VỊ TRÍ KHO</Text>
              <View style={styles.badgeColdStorage}>
                <Text style={styles.badgeColdText}>KHO ĐÔNG LẠNH</Text>
              </View>
            </View>
            <Text style={styles.headerSub}>
              {positions.length} vị trí ({positions.filter(p => p.lot_id).length} có hàng)
              {cachedAt
                ? ` · 🕒 ${new Date(cachedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} ${new Date(cachedAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`
                : ''}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <TouchableOpacity
            style={[styles.downloadOfflineBtn, { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10 }]}
            onPress={handleDownloadOffline}
            disabled={downloadingOffline || refreshing}
          >
            {downloadingOffline || refreshing ? (
              <ActivityIndicator size="small" color="#34d399" />
            ) : (
              <>
                <Ionicons name="cloud-download-outline" size={16} color="#34d399" />
                <Text style={{ color: '#34d399', fontSize: 11, fontWeight: '800' }}>Tải mới</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* ── OFFLINE STATUS BANNER (When inside cold storage without network) ── */}
      {isOffline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="snow-outline" size={16} color="#fbbf24" />
          <View style={{ flex: 1 }}>
            <Text style={styles.offlineBannerTitle}>Đang xem Ngoại Tuyến (Offline)</Text>
            <Text style={styles.offlineBannerSub}>
              {cachedAt
                ? `Bản tải lúc: ${new Date(cachedAt).toLocaleTimeString('vi-VN')} ${new Date(cachedAt).toLocaleDateString('vi-VN')}`
                : 'Dữ liệu đã lưu trong bộ nhớ máy'}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              loadMapData(true, true);
            }}
            style={styles.retryBtn}
          >
            <Text style={styles.retryBtnText}>Thử lại</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── ISOLATED SEARCH BAR (0ms Latency: typing updates only search bar) ── */}
      <MobileWarehouseSearchBar
        uniqueProducts={uniqueProducts}
        uniqueStts={uniqueStts}
        searchQuery={searchQuery}
        onExecuteSearch={handleExecuteSearch}
        onClearSearch={handleClearSearch}
        filterDateType={filterDateType}
        onFilterDateTypeChange={setFilterDateType}
        filterStartDate={filterStartDate}
        onFilterStartDateChange={setFilterStartDate}
        filterEndDate={filterEndDate}
        onFilterEndDateChange={setFilterEndDate}
        filterRegion={filterRegion}
        onFilterRegionChange={setFilterRegion}
        availableRegions={availableRegions}
        hasActiveFilters={hasActiveFilters}
        onSetDatePreset={handleSetDatePreset}
        onResetFilters={handleResetFilters}
        isFilterOpen={isFilterOpen}
        onToggleFilterOpen={() => setIsFilterOpen(prev => !prev)}
      />

      {/* ── BỘ THỐNG KÊ KẾT QUẢ TÌM KIẾM THEO KHO (SEARCH STATS PANEL - CHUẨN WEB /SCANNER) ── */}
      {isSearchActive && (
        <View style={styles.searchStatsPanel}>
          {/* Dòng 1: Tên từ khóa & Tổng số vị trí khớp & Nút xóa */}
          <View style={styles.searchStatsRow1}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
              <View style={styles.amberPulseDot} />
              <Text style={styles.searchStatsQueryText} numberOfLines={1}>
                {searchQuery.trim() ? (
                  <>
                    <Text style={{ color: '#94a3b8' }}>Kết quả cho: </Text>
                    <Text style={{ color: '#fcd34d', fontWeight: '800' }}>"{searchQuery}"</Text>
                  </>
                ) : (
                  <>
                    <Text style={{ color: '#94a3b8' }}>Lọc theo: </Text>
                    <Text style={{ color: '#fcd34d', fontWeight: '800' }}>
                      {(filterStartDate || filterEndDate)
                        ? DATE_FILTER_OPTIONS.find(o => o.id === filterDateType)?.shortLabel
                        : ''}
                      {filterRegion !== 'all' ? ` · Vùng ${filterRegion}` : ''}
                    </Text>
                  </>
                )}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={styles.matchCountPillCyan}>
                <Text style={styles.matchCountPillCyanText}>
                  {matchingPositions.length} vị trí khớp
                </Text>
              </View>
              <TouchableOpacity
                style={styles.clearAllSearchBtn}
                onPress={handleClearAllSearchAndFilters}
              >
                <Ionicons name="close" size={13} color="#94a3b8" />
                <Text style={styles.clearAllSearchBtnText}>Xóa</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Dòng 1B: Thanh mở bộ lọc ngày tháng & vùng miền nhanh */}
          <View style={styles.quickFilterToggleBar}>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}
              onPress={() => setIsFilterOpen(prev => !prev)}
            >
              <Ionicons name="calendar-outline" size={13} color="#fbbf24" />
              <Text style={styles.quickFilterToggleText} numberOfLines={1}>
                {hasActiveFilters
                  ? `Đang lọc: ${(filterStartDate || filterEndDate) ? DATE_FILTER_OPTIONS.find(o => o.id === filterDateType)?.shortLabel : ''}${filterRegion !== 'all' ? ` · Vùng ${filterRegion}` : ''}`
                  : 'Lọc Ngày (Đóng gói / SX / Nguyên liệu) & Vùng'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickFilterOpenBtn}
              onPress={() => setIsFilterOpen(prev => !prev)}
            >
              <Text style={styles.quickFilterOpenBtnText}>
                {isFilterOpen ? 'Đóng bộ lọc' : 'Mở bộ lọc'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Dòng 2: Chuyển đổi giữa 2 tab: [Thống kê phân bổ] và [Sơ đồ vị trí] */}
          <View style={styles.webSearchTabGrid}>
            <TouchableOpacity
              style={[
                styles.webSearchTabBtn,
                searchTab === 'breakdown' && styles.webSearchTabBtnBreakdownActive
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSearchTab('breakdown');
              }}
            >
              <Ionicons
                name="bar-chart"
                size={13}
                color={searchTab === 'breakdown' ? '#020617' : '#94a3b8'}
              />
              <Text
                style={[
                  styles.webSearchTabBtnText,
                  searchTab === 'breakdown' && styles.webSearchTabBtnTextActive
                ]}
                numberOfLines={1}
              >
                Thống kê phân bổ
              </Text>
              {breakdownReport && breakdownReport.grandTotalQty > 0 && (
                <View
                  style={[
                    styles.webSearchTabQtyBadge,
                    searchTab === 'breakdown'
                      ? styles.webSearchTabQtyBadgeActive
                      : styles.webSearchTabQtyBadgeInactive
                  ]}
                >
                  <Text
                    style={[
                      styles.webSearchTabQtyBadgeText,
                      searchTab === 'breakdown'
                        ? { color: '#020617' }
                        : { color: '#fcd34d' }
                    ]}
                  >
                    {formatUnitsSummary(breakdownReport.grandUnitsMap, { short: true })}
                  </Text>
                </View>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.webSearchTabBtn,
                searchTab === 'map' && styles.webSearchTabBtnMapActive
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSearchTab('map');
              }}
            >
              <Ionicons
                name="location"
                size={13}
                color={searchTab === 'map' ? '#020617' : '#94a3b8'}
              />
              <Text
                style={[
                  styles.webSearchTabBtnText,
                  searchTab === 'map' && styles.webSearchTabBtnTextActive
                ]}
              >
                Sơ đồ vị trí
              </Text>
            </TouchableOpacity>
          </View>

          {/* Dòng 3: Bộ thống kê từng kho (Chỉ hiện khi ở tab Sơ đồ để click chuyển kho trên map) */}
          {searchTab === 'map' && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6, paddingTop: 2 }}
            >
              <TouchableOpacity
                style={[
                  styles.webWhFilterPill,
                  (!selectedWarehouseId || selectedWarehouseId === 'all') && styles.webWhFilterPillAllActive
                ]}
                onPress={() => {
                  setSelectedWarehouseId('all');
                  setSelectedAisleId(null);
                  setSelectedSlotId(null);
                  setSelectedTierId(null);
                }}
              >
                <Ionicons
                  name="business"
                  size={12}
                  color={(!selectedWarehouseId || selectedWarehouseId === 'all') ? '#020617' : '#cbd5e1'}
                />
                <Text
                  style={[
                    styles.webWhFilterPillText,
                    (!selectedWarehouseId || selectedWarehouseId === 'all') && styles.webWhFilterPillTextActive
                  ]}
                >
                  Tất cả kho
                </Text>
                <View
                  style={[
                    styles.webWhFilterCountBadge,
                    (!selectedWarehouseId || selectedWarehouseId === 'all')
                      ? { backgroundColor: '#02061733' }
                      : { backgroundColor: '#1e293b' }
                  ]}
                >
                  <Text
                    style={[
                      styles.webWhFilterCountText,
                      (!selectedWarehouseId || selectedWarehouseId === 'all')
                        ? { color: '#020617' }
                        : { color: '#67e8f9' }
                    ]}
                  >
                    {matchingPositions.length}
                  </Text>
                </View>
              </TouchableOpacity>

              {warehouses.map(wh => {
                const matchCount = zoneMatchCountMap.get(wh.id) || 0;
                if (matchCount === 0) return null;
                const isSelected = selectedWarehouseId === wh.id;
                return (
                  <TouchableOpacity
                    key={wh.id}
                    style={[
                      styles.webWhFilterPill,
                      isSelected && styles.webWhFilterPillWhActive
                    ]}
                    onPress={() => {
                      setSelectedWarehouseId(wh.id);
                      setSelectedAisleId(null);
                      setSelectedSlotId(null);
                      setSelectedTierId(null);
                    }}
                  >
                    <Text
                      style={[
                        styles.webWhFilterPillText,
                        isSelected && styles.webWhFilterPillTextActive
                      ]}
                    >
                      {wh.name}
                    </Text>
                    <View
                      style={[
                        styles.webWhFilterCountBadge,
                        isSelected
                          ? { backgroundColor: '#02061733' }
                          : { backgroundColor: '#f59e0b33', borderWidth: 1, borderColor: '#f59e0b55' }
                      ]}
                    >
                      <Text
                        style={[
                          styles.webWhFilterCountText,
                          isSelected ? { color: '#020617' } : { color: '#fbbf24' }
                        ]}
                      >
                        🔥 {matchCount}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* ── BREADCRUMB NAVIGATION (Kho > Dãy > Ô > Tầng) ─────────── */}
      {(!isSearchActive || searchTab === 'map') && (
        <View style={styles.breadcrumbBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.breadcrumbScroll}>
            <TouchableOpacity
              style={[
                styles.crumbBtn,
                (!selectedWarehouseId || selectedWarehouseId === 'all') && styles.crumbBtnActive
              ]}
              onPress={() => {
                setSelectedWarehouseId('all');
                setSelectedAisleId(null);
                setSelectedSlotId(null);
                setSelectedTierId(null);
              }}
            >
              <Ionicons
                name="business"
                size={12}
                color={(!selectedWarehouseId || selectedWarehouseId === 'all') ? '#0f172a' : '#cbd5e1'}
              />
              <Text
                style={[
                  styles.crumbText,
                  (!selectedWarehouseId || selectedWarehouseId === 'all') && styles.crumbTextActive
                ]}
              >
                Tất cả Kho
              </Text>
            </TouchableOpacity>

            {selectedWarehouseId && selectedWarehouseId !== 'all' && (
              <>
                <Ionicons name="chevron-forward" size={12} color="#64748b" />
                <TouchableOpacity
                  style={[styles.crumbBtn, !selectedAisleId && styles.crumbBtnActive]}
                  onPress={() => {
                    setSelectedAisleId(null);
                    setSelectedSlotId(null);
                    setSelectedTierId(null);
                  }}
                >
                  <Text style={[styles.crumbText, !selectedAisleId && styles.crumbTextActive]}>
                    {getZoneName(selectedWarehouseId)}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {selectedAisleId && (
              <>
                <Ionicons name="chevron-forward" size={12} color="#64748b" />
                <TouchableOpacity
                  style={[styles.crumbBtn, !selectedSlotId && styles.crumbBtnActive]}
                  onPress={() => {
                    setSelectedSlotId(null);
                    setSelectedTierId(null);
                  }}
                >
                  <Text style={[styles.crumbText, !selectedSlotId && styles.crumbTextActive]}>
                    {getZoneName(selectedAisleId)}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {selectedSlotId && (
              <>
                <Ionicons name="chevron-forward" size={12} color="#64748b" />
                <TouchableOpacity
                  style={[styles.crumbBtn, !selectedTierId && styles.crumbBtnActive]}
                  onPress={() => setSelectedTierId(null)}
                >
                  <Text style={[styles.crumbText, !selectedTierId && styles.crumbTextActive]}>
                    {getZoneName(selectedSlotId)}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {selectedTierId && (
              <>
                <Ionicons name="chevron-forward" size={12} color="#64748b" />
                <View style={[styles.crumbBtn, styles.crumbBtnActive]}>
                  <Text style={[styles.crumbText, styles.crumbTextActive]}>
                    {getZoneName(selectedTierId)}
                  </Text>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      )}

      {/* ── MAIN CONTENT ──────────────────────────────────────── */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Đang tải sơ đồ kho...</Text>
        </View>
      ) : isSearchActive && searchTab === 'breakdown' ? (
        /* ── BẢNG THỐNG KÊ KẾ TOÁN: PHÂN BỔ TỒN KHO (KHO -> DÃY -> Ô) CHUẨN WEB /SCANNER ── */
        <ScrollView style={styles.contentScroll} contentContainerStyle={[styles.scrollPadding, { paddingBottom: 40 }]}>
          {!breakdownReport || breakdownReport.warehouses.length === 0 ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <Text style={{ color: '#64748b', fontSize: 13 }}>
                Không tìm thấy vị trí nào khớp với điều kiện lọc hiện tại.
              </Text>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              {/* Header Tổng Quan Kế Toán */}
              <View style={styles.breakdownSummaryCard}>
                <View style={styles.breakdownSummaryHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="bar-chart" size={15} color="#fbbf24" />
                    <Text style={styles.breakdownSummaryTitle}>
                      BẢNG THỐNG KÊ PHÂN BỔ TỒN KHO
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <TouchableOpacity onPress={handleExpandAll}>
                      <Text style={styles.breakdownExpandActionText}>Mở rộng</Text>
                    </TouchableOpacity>
                    <Text style={{ color: '#475569', fontSize: 10 }}>•</Text>
                    <TouchableOpacity onPress={handleCollapseAll}>
                      <Text style={styles.breakdownExpandActionText}>Thu gọn</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* 3 Thẻ số liệu KPI */}
                <View style={styles.breakdownKpiRow}>
                  {(() => {
                    const entries = Array.from(breakdownReport.grandUnitsMap.entries()).filter(([_, q]) => q > 0);
                    entries.sort(([uA], [uB]) => {
                      const priority = (u: string) => (u === 'Thùng' ? 1 : u === 'Kg' ? 2 : u === 'Sọt' ? 3 : 4);
                      const pA = priority(uA);
                      const pB = priority(uB);
                      if (pA !== pB) return pA - pB;
                      return uA.localeCompare(uB);
                    });

                    if (entries.length <= 1) {
                      const [unit, qty] = entries[0] || ['Thùng', 0];
                      return (
                        <View style={styles.kpiCardAmber}>
                          <Text style={styles.kpiLabel}>TỔNG TỒN</Text>
                          <Text style={styles.kpiValueAmber} numberOfLines={1}>
                            {Number.isInteger(qty) ? qty.toLocaleString('vi-VN') : Number(qty.toFixed(2)).toLocaleString('vi-VN')}
                          </Text>
                          <Text style={styles.kpiUnitAmber}>{unit}</Text>
                        </View>
                      );
                    }

                    return (
                      <View style={styles.kpiCardAmber}>
                        <Text style={styles.kpiLabel}>TỔNG TỒN</Text>
                        <View style={{ marginTop: 2, gap: 1 }}>
                          {entries.map(([u, q]) => (
                            <Text key={u} style={[styles.kpiValueAmber, { fontSize: 12 }]} numberOfLines={1}>
                              {Number.isInteger(q) ? q.toLocaleString('vi-VN') : Number(q.toFixed(2)).toLocaleString('vi-VN')}{' '}
                              <Text style={styles.kpiUnitAmber}>{u}</Text>
                            </Text>
                          ))}
                        </View>
                      </View>
                    );
                  })()}

                  <View style={styles.kpiCardCyan}>
                    <Text style={styles.kpiLabel}>VỊ TRÍ LƯU</Text>
                    <Text style={styles.kpiValueCyan}>{breakdownReport.totalPositions}</Text>
                    <Text style={styles.kpiUnitCyan}>vị trí (ô)</Text>
                  </View>

                  <View style={styles.kpiCardEmerald}>
                    <Text style={styles.kpiLabel}>SỐ KHO</Text>
                    <Text style={styles.kpiValueEmerald}>{breakdownReport.warehouses.length}</Text>
                    <Text style={styles.kpiUnitEmerald}>kho có hàng</Text>
                  </View>
                </View>
              </View>

              {/* Cây phân cấp Kho -> Dãy -> Ô */}
              <View style={{ gap: 10 }}>
                {breakdownReport.warehouses.map(whAcc => {
                  const isWhExpanded = expandedWhIds.has(whAcc.warehouse.id);
                  return (
                    <View key={whAcc.warehouse.id} style={styles.breakdownWhCard}>
                      {/* Hàng Tiêu đề KHO */}
                      <View style={styles.breakdownWhHeaderRow}>
                        <TouchableOpacity
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}
                          onPress={() => toggleWarehouseExpand(whAcc.warehouse.id)}
                          activeOpacity={0.7}
                        >
                          <Ionicons
                            name={isWhExpanded ? 'chevron-down' : 'chevron-forward'}
                            size={16}
                            color="#94a3b8"
                          />
                          <View style={styles.breakdownWhIconBox}>
                            <Ionicons name="business" size={13} color="#22d3ee" />
                          </View>
                          <Text style={styles.breakdownWhName} numberOfLines={1}>
                            {whAcc.warehouse.name}
                          </Text>
                        </TouchableOpacity>

                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={styles.breakdownWhQtyText}>
                              {formatUnitsSummary(whAcc.unitsMap)}
                            </Text>
                            <Text style={styles.breakdownWhSubText}>
                              {whAcc.positionCount} ô
                            </Text>
                          </View>

                          <TouchableOpacity
                            style={styles.breakdownJumpWhBtn}
                            onPress={() => {
                              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                              setSelectedWarehouseId(whAcc.warehouse.id);
                              setSelectedAisleId(null);
                              setSelectedSlotId(null);
                              setSelectedTierId(null);
                              setSearchTab('map');
                            }}
                          >
                            <Ionicons name="location" size={11} color="#67e8f9" />
                            <Text style={styles.breakdownJumpWhBtnText}>Sơ đồ</Text>
                          </TouchableOpacity>
                        </View>
                      </View>

                      {/* Danh sách DÃY trong kho */}
                      {isWhExpanded && (
                        <View style={styles.breakdownAisleListWrap}>
                          {whAcc.aisles.map(aisleAcc => {
                            const isAisleExpanded = expandedAisleIds.has(aisleAcc.aisle.id);
                            return (
                              <View key={aisleAcc.aisle.id} style={styles.breakdownAisleCard}>
                                {/* Hàng DÃY */}
                                <View style={styles.breakdownAisleHeaderRow}>
                                  <TouchableOpacity
                                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}
                                    onPress={() => toggleAisleExpand(aisleAcc.aisle.id)}
                                    activeOpacity={0.7}
                                  >
                                    <Ionicons
                                      name={isAisleExpanded ? 'chevron-down' : 'chevron-forward'}
                                      size={14}
                                      color="#64748b"
                                    />
                                    <Text style={styles.breakdownAisleName} numberOfLines={1}>
                                      {aisleAcc.aisle.name}
                                    </Text>
                                  </TouchableOpacity>

                                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                    <Text style={styles.breakdownAisleQtyText}>
                                      {formatUnitsSummary(aisleAcc.unitsMap, { short: true })}{' '}
                                      <Text style={styles.breakdownAisleCountText}>
                                        ({aisleAcc.positionCount} ô)
                                      </Text>
                                    </Text>

                                    <TouchableOpacity
                                      style={styles.breakdownJumpAisleBtn}
                                      onPress={() => {
                                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                        setSelectedWarehouseId(whAcc.warehouse.id);
                                        setSelectedAisleId(aisleAcc.aisle.id);
                                        setSelectedSlotId(null);
                                        setSelectedTierId(null);
                                        setSearchTab('map');
                                      }}
                                    >
                                      <Ionicons name="open-outline" size={13} color="#94a3b8" />
                                    </TouchableOpacity>
                                  </View>
                                </View>

                                {/* Danh sách Ô trong dãy (bấm vào Ô để xổ chi tiết từng Tầng 1, Tầng 2...) */}
                                {isAisleExpanded && (
                                  <View style={styles.breakdownSlotsListWrap}>
                                    {aisleAcc.slots.map(slotAcc => {
                                      const isSlotExpanded = expandedSlotIds.has(slotAcc.slot.id);
                                      const hasTiers = slotAcc.tiers && slotAcc.tiers.length > 0;
                                      return (
                                        <View
                                          key={slotAcc.slot.id}
                                          style={[
                                            styles.breakdownSlotCard,
                                            isSlotExpanded && styles.breakdownSlotCardExpanded
                                          ]}
                                        >
                                          <View style={styles.breakdownSlotRow}>
                                            <TouchableOpacity
                                              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}
                                              onPress={() => toggleSlotExpand(slotAcc.slot.id)}
                                              activeOpacity={0.7}
                                            >
                                              <Ionicons
                                                name={isSlotExpanded ? 'chevron-down' : 'chevron-forward'}
                                                size={13}
                                                color={isSlotExpanded ? '#22d3ee' : '#64748b'}
                                              />
                                              <Text style={[styles.breakdownSlotName, isSlotExpanded && { color: '#22d3ee' }]}>
                                                {slotAcc.slot.name}
                                              </Text>
                                              <Text style={styles.breakdownSlotPCount}>
                                                ({slotAcc.positionCount} vị trí{hasTiers ? ` · ${slotAcc.tiers.length} tầng` : ''})
                                              </Text>
                                            </TouchableOpacity>

                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                              <TouchableOpacity
                                                onPress={() => toggleSlotExpand(slotAcc.slot.id)}
                                                activeOpacity={0.7}
                                              >
                                                <Text style={styles.breakdownSlotQtyText}>
                                                  {formatUnitsSummary(slotAcc.unitsMap, { short: true })}
                                                </Text>
                                              </TouchableOpacity>

                                              <TouchableOpacity
                                                onPress={() => {
                                                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                                  setSelectedWarehouseId(whAcc.warehouse.id);
                                                  setSelectedAisleId(aisleAcc.aisle.id);
                                                  if (isHallZone(aisleAcc.aisle) || slotAcc.slot.id === aisleAcc.aisle.id) {
                                                    setSelectedSlotId(null);
                                                  } else {
                                                    setSelectedSlotId(slotAcc.slot.id);
                                                  }
                                                  setSelectedTierId(null);
                                                  if (slotAcc.positions[0]) {
                                                    setHighlightedPosId(slotAcc.positions[0].id);
                                                  }
                                                  setSearchTab('map');
                                                }}
                                              >
                                                <Text style={styles.breakdownViewPosLink}>Xem vị trí</Text>
                                              </TouchableOpacity>
                                            </View>
                                          </View>

                                          {/* Danh sách TẦNG bên trong Ô (bấm vào Tầng để xổ chi tiết từng Mã vị trí & Số lượng) */}
                                          {isSlotExpanded && (
                                            <View style={styles.breakdownTierListWrap}>
                                              {hasTiers ? (
                                                slotAcc.tiers.map(tierAcc => {
                                                  const isTierExpanded = expandedBreakdownTierIds.has(tierAcc.tier.id);

                                                  return (
                                                    <View
                                                      key={tierAcc.tier.id}
                                                      style={[
                                                        styles.breakdownTierCard,
                                                        isTierExpanded && styles.breakdownTierCardExpanded
                                                      ]}
                                                    >
                                                      <View style={styles.breakdownTierHeaderRow}>
                                                        <TouchableOpacity
                                                          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}
                                                          onPress={() => toggleBreakdownTierExpand(tierAcc.tier.id)}
                                                          activeOpacity={0.7}
                                                        >
                                                          <Ionicons
                                                            name={isTierExpanded ? 'chevron-down' : 'chevron-forward'}
                                                            size={13}
                                                            color={isTierExpanded ? '#fbbf24' : '#94a3b8'}
                                                          />
                                                          <View style={styles.breakdownTierBadge}>
                                                            <Ionicons name="layers-outline" size={11} color="#fbbf24" />
                                                            <Text style={styles.breakdownTierName}>
                                                              {tierAcc.tier.name}
                                                            </Text>
                                                          </View>
                                                          <Text style={styles.breakdownTierCountText}>
                                                            ({tierAcc.positionCount} vị trí)
                                                          </Text>
                                                        </TouchableOpacity>

                                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                          <TouchableOpacity
                                                            onPress={() => toggleBreakdownTierExpand(tierAcc.tier.id)}
                                                            activeOpacity={0.7}
                                                          >
                                                            <Text style={styles.breakdownTierQtyText}>
                                                              {formatUnitsSummary(tierAcc.unitsMap, { short: true })}
                                                            </Text>
                                                          </TouchableOpacity>

                                                          <TouchableOpacity
                                                            style={styles.breakdownJumpTierBtn}
                                                            onPress={() => {
                                                              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                                              setSelectedWarehouseId(whAcc.warehouse.id);
                                                              setSelectedAisleId(aisleAcc.aisle.id);
                                                              setSelectedSlotId(slotAcc.slot.id);
                                                              setSelectedTierId(tierAcc.tier.id);
                                                              setExpandedTierIds(new Set([tierAcc.tier.id]));
                                                              if (tierAcc.positions[0]) {
                                                                setHighlightedPosId(tierAcc.positions[0].id);
                                                              }
                                                              setSearchTab('map');
                                                            }}
                                                          >
                                                            <Text style={styles.breakdownJumpTierBtnText}>Xem tầng</Text>
                                                          </TouchableOpacity>
                                                        </View>
                                                      </View>

                                                      {/* Bấm vào Tầng mới hiện chi tiết từng Mã vị trí + Số lượng */}
                                                      {isTierExpanded && (
                                                        <View style={styles.breakdownTierPositionsList}>
                                                          {tierAcc.positions.map(pos => (
                                                            <TouchableOpacity
                                                              key={pos.id}
                                                              style={styles.breakdownPosRow}
                                                              onPress={() => {
                                                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                                                setSelectedPosDetail(pos);
                                                              }}
                                                              activeOpacity={0.7}
                                                            >
                                                              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, flex: 1, minWidth: 0 }}>
                                                                <Ionicons name="location-outline" size={12} color="#38bdf8" />
                                                                <Text style={styles.breakdownPosRowCode}>{pos.code}</Text>
                                                                {pos.stt ? (
                                                                  <View style={styles.posSttBadge}>
                                                                    <Text style={styles.posSttBadgeText}>#{pos.stt}</Text>
                                                                  </View>
                                                                ) : null}
                                                                {pos.material_zone ? (
                                                                  <View style={styles.breakdownZoneBadge}>
                                                                    <Text style={styles.breakdownZoneBadgeText}>{pos.material_zone}</Text>
                                                                  </View>
                                                                ) : null}
                                                                {pos.packaging_date ? (
                                                                  <Text style={styles.breakdownDateText}>
                                                                    {pos.packaging_date.split('-').reverse().slice(0, 2).join('/')}
                                                                  </Text>
                                                                ) : null}
                                                              </View>

                                                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                                <Text style={styles.breakdownPosRowQty}>
                                                                  {formatPositionQtyUnit(pos.quantity, pos.unit)}
                                                                </Text>
                                                                <Ionicons name="information-circle-outline" size={14} color="#64748b" />
                                                              </View>
                                                            </TouchableOpacity>
                                                          ))}
                                                        </View>
                                                      )}
                                                    </View>
                                                  );
                                                })
                                              ) : (
                                                /* Trường hợp Sảnh không chia tầng: hiện danh sách các vị trí trong Sảnh */
                                                <View style={styles.breakdownTierPositionsList}>
                                                  {slotAcc.positions.map(pos => (
                                                    <TouchableOpacity
                                                      key={pos.id}
                                                      style={styles.breakdownPosRow}
                                                      onPress={() => {
                                                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                                        setSelectedPosDetail(pos);
                                                      }}
                                                      activeOpacity={0.7}
                                                    >
                                                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, flex: 1, minWidth: 0 }}>
                                                        <Ionicons name="location-outline" size={12} color="#38bdf8" />
                                                        <Text style={styles.breakdownPosRowCode}>{pos.code}</Text>
                                                        {pos.stt ? (
                                                          <View style={styles.posSttBadge}>
                                                            <Text style={styles.posSttBadgeText}>#{pos.stt}</Text>
                                                          </View>
                                                        ) : null}
                                                        {pos.material_zone ? (
                                                          <View style={styles.breakdownZoneBadge}>
                                                            <Text style={styles.breakdownZoneBadgeText}>{pos.material_zone}</Text>
                                                          </View>
                                                        ) : null}
                                                        {pos.packaging_date ? (
                                                          <Text style={styles.breakdownDateText}>
                                                            {pos.packaging_date.split('-').reverse().slice(0, 2).join('/')}
                                                          </Text>
                                                        ) : null}
                                                      </View>

                                                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                        <Text style={styles.breakdownPosRowQty}>
                                                          {formatPositionQtyUnit(pos.quantity, pos.unit)}
                                                        </Text>
                                                        <Ionicons name="information-circle-outline" size={14} color="#64748b" />
                                                      </View>
                                                    </TouchableOpacity>
                                                  ))}
                                                </View>
                                              )}
                                            </View>
                                          )}
                                        </View>
                                      );
                                    })}
                                  </View>
                                )}
                              </View>
                            );
                          })}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            </View>
          )}
        </ScrollView>
      ) : (
        /* ── XEM TRÊN SƠ ĐỒ KHO ── */
        <View style={{ flex: 1 }}>

          {(!selectedWarehouseId || selectedWarehouseId === 'all') ? (
            /* ── LEVEL 0: DANH SÁCH CÁC KHO (TẤT CẢ KHO - CHUẨN GIAO DIỆN WEB) ── */
            <ScrollView style={styles.contentScroll} contentContainerStyle={styles.scrollPadding}>
              <View style={styles.sectionTitleRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons name="business" size={15} color="#38bdf8" />
                  <Text style={styles.sectionTitle}>
                    CHỌN KHO (TẤT CẢ KHO):
                  </Text>
                </View>
                <Text style={styles.sectionCount}>{visibleWarehouses.length} kho</Text>
              </View>

              <View style={styles.warehouseList}>
                {visibleWarehouses.map(wh => {
                  const stats = zoneStatsMap.get(wh.id) || { total: 0, occupied: 0, empty: 0 };
                  const pct = stats.total > 0 ? Math.round((stats.occupied / stats.total) * 100) : 0;
                  const whMatchCount = isSearchActive ? zoneMatchCountMap.get(wh.id) || 0 : 0;
                  const breakdown = getWhBreakdown(wh.id);

                  return (
                    <TouchableOpacity
                      key={wh.id}
                      style={[
                        styles.warehouseCard,
                        whMatchCount > 0 && styles.warehouseCardMatched
                      ]}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setSelectedWarehouseId(wh.id);
                        setSelectedAisleId(null);
                        setSelectedSlotId(null);
                        setSelectedTierId(null);
                      }}
                      activeOpacity={0.8}
                    >
                      {/* Header: Icon + Tên Kho & Xem Dãy */}
                      <View style={styles.warehouseCardHeader}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                          <Ionicons name="business" size={18} color="#38bdf8" />
                          <Text style={styles.warehouseCardTitle}>{wh.name}</Text>
                        </View>
                        {isSearchActive && whMatchCount > 0 ? (
                          <View style={styles.whMatchBadgeInline}>
                            <Text style={styles.whMatchBadgeInlineText}>🔥 {whMatchCount} khớp</Text>
                          </View>
                        ) : (
                          <Text style={styles.warehouseCardAction}>Xem Dãy →</Text>
                        )}
                      </View>

                      {/* Thống kê Tổng, Đã chứa, Còn trống */}
                      <View style={styles.aisleStatsRow}>
                        <Text style={styles.statLabel}>Tổng: <Text style={styles.statValWhite}>{stats.total}</Text></Text>
                        <Text style={styles.statLabel}>Đã chứa: <Text style={styles.statValAmber}>{stats.occupied}</Text></Text>
                        <Text style={styles.statLabel}>Còn trống: <Text style={styles.statValEmerald}>{stats.empty}</Text></Text>
                      </View>

                      {/* Chi tiết phụ: Kệ & Sảnh */}
                      {(breakdown.rackTotal > 0 || breakdown.hallTotal > 0) && (
                        <View style={styles.whBreakdownRow}>
                          <Text style={styles.whBreakdownText}>
                            Kệ: <Text style={styles.statValWhite}>{breakdown.rackTotal}</Text> ({breakdown.rackOccupied} có hàng)
                          </Text>
                          {breakdown.hallTotal > 0 && (
                            <Text style={[styles.whBreakdownText, { color: '#34d399' }]}>
                              Sảnh: <Text style={{ color: '#34d399', fontWeight: '800' }}>{breakdown.hallTotal}</Text> ({breakdown.hallOccupied})
                            </Text>
                          )}
                        </View>
                      )}

                      {/* Progress Bar (2 màu xanh lá / vàng cam) */}
                      <View style={styles.progressBarBg}>
                        <View
                          style={[
                            styles.progressBarFill,
                            {
                              width: `${pct}%`,
                              backgroundColor: pct > 80 ? '#f59e0b' : '#10b981'
                            }
                          ]}
                        />
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          ) : !selectedAisleId ? (
            /* ── LEVEL 1: DANH SÁCH DÃY / SẢNH CỦA KHO ─────────────────────── */
            <ScrollView style={styles.contentScroll} contentContainerStyle={styles.scrollPadding}>
              <View style={styles.sectionTitleRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                  <TouchableOpacity
                    style={styles.backLevelBtn}
                    onPress={() => {
                      setSelectedWarehouseId('all');
                      setSelectedAisleId(null);
                      setSelectedSlotId(null);
                      setSelectedTierId(null);
                    }}
                  >
                    <Ionicons name="arrow-back" size={13} color="#38bdf8" />
                    <Text style={styles.backLevelText}>Tất cả Kho</Text>
                  </TouchableOpacity>
                  <Text style={[styles.sectionTitle, { marginLeft: 4 }]} numberOfLines={1}>
                    CHỌN DÃY / SẢNH:
                  </Text>
                </View>
                <Text style={styles.sectionCount}>{aisles.length} phân khu</Text>
              </View>

          {/* Switch Warehouse Pills */}
          {visibleWarehouses.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {/* TẤT CẢ KHO Pill */}
              <TouchableOpacity
                style={[
                  styles.whPill,
                  (!selectedWarehouseId || selectedWarehouseId === 'all') && styles.whPillActive
                ]}
                onPress={() => {
                  setSelectedWarehouseId('all');
                  setSelectedAisleId(null);
                  setSelectedSlotId(null);
                  setSelectedTierId(null);
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text
                    style={[
                      styles.whPillText,
                      (!selectedWarehouseId || selectedWarehouseId === 'all') && styles.whPillTextActive
                    ]}
                  >
                    🌐 TẤT CẢ KHO
                  </Text>
                  {isSearchActive && matchingPositions.length > 0 && (
                    <View style={styles.whMatchBadge}>
                      <Text style={styles.whMatchBadgeText}>{matchingPositions.length}</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>

              {visibleWarehouses.map(wh => {
                const whMatchCount = isSearchActive ? zoneMatchCountMap.get(wh.id) || 0 : 0;
                const isAct = selectedWarehouseId === wh.id;
                return (
                  <TouchableOpacity
                    key={wh.id}
                    style={[styles.whPill, isAct && styles.whPillActive]}
                    onPress={() => {
                      setSelectedWarehouseId(wh.id);
                      setSelectedAisleId(null);
                      setSelectedSlotId(null);
                      setSelectedTierId(null);
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Text style={[styles.whPillText, isAct && styles.whPillTextActive]}>
                        🏢 {wh.name}
                      </Text>
                      {whMatchCount > 0 && (
                        <View style={styles.whMatchBadge}>
                          <Text style={styles.whMatchBadgeText}>{whMatchCount}</Text>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.aislesList}>
            {aisles.map(aisle => {
              const stats = zoneStatsMap.get(aisle.id) || { total: 0, occupied: 0, empty: 0 };
              const pct = stats.total > 0 ? Math.round((stats.occupied / stats.total) * 100) : 0;
              const matchCount = isSearchActive ? zoneMatchCountMap.get(aisle.id) || 0 : 0;
              const whName = (!selectedWarehouseId || selectedWarehouseId === 'all')
                ? getZoneName(aisle.parent_id)
                : '';

              return (
                <TouchableOpacity
                  key={aisle.id}
                  style={[
                    styles.aisleCard,
                    matchCount > 0 && styles.aisleCardMatched
                  ]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setSelectedAisleId(aisle.id);
                    setSelectedSlotId(null);
                    setSelectedTierId(null);
                  }}
                >
                  <View style={styles.aisleCardHeader}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                      <Text style={styles.aisleCardTitle}>🚪 {aisle.name}</Text>
                      {whName ? (
                        <View style={styles.whTag}>
                          <Text style={styles.whTagText}>{whName}</Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {matchCount > 0 && (
                        <View style={styles.matchCountBadge}>
                          <Text style={styles.matchCountText}>🔥 {matchCount} khớp</Text>
                        </View>
                      )}
                      <Text style={styles.aisleCardAction}>Xem Ô →</Text>
                    </View>
                  </View>

                  <View style={styles.aisleStatsRow}>
                    <Text style={styles.statLabel}>Tổng: <Text style={styles.statValWhite}>{stats.total}</Text></Text>
                    <Text style={styles.statLabel}>Có hàng: <Text style={styles.statValAmber}>{stats.occupied}</Text></Text>
                    <Text style={styles.statLabel}>Trống: <Text style={styles.statValEmerald}>{stats.empty}</Text></Text>
                  </View>

                  <View style={styles.progressBarBg}>
                    <View
                      style={[
                        styles.progressBarFill,
                        {
                          width: `${pct}%`,
                          backgroundColor: pct >= 90 ? '#f59e0b' : '#10b981'
                        }
                      ]}
                    />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>
      ) : isSelectedAisleHall ? (
        /* ── LEVEL 2-HALL: LƯỚI VỊ TRÍ TRONG SẢNH (CHUẨN GIAO DIỆN WEB) ── */
        <ScrollView style={styles.contentScroll} contentContainerStyle={styles.scrollPadding}>
          <View style={styles.sectionTitleRow}>
            <TouchableOpacity
              style={styles.backLevelBtn}
              onPress={() => {
                setSelectedAisleId(null);
                setSelectedSlotId(null);
                setSelectedTierId(null);
              }}
            >
              <Ionicons name="arrow-back" size={14} color="#38bdf8" />
              <Text style={styles.backLevelText}>Quay lại Dãy / Sảnh</Text>
            </TouchableOpacity>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {isSearchActive && (
                <TouchableOpacity
                  style={[styles.onlyMatchToggle, onlyShowMatches && styles.onlyMatchToggleActive]}
                  onPress={() => setOnlyShowMatches(!onlyShowMatches)}
                >
                  <Text style={[styles.onlyMatchToggleText, onlyShowMatches && styles.onlyMatchToggleTextActive]}>
                    ⭐ {onlyShowMatches ? 'Hiện tất cả' : 'Chỉ khớp'}
                  </Text>
                </TouchableOpacity>
              )}
              <Text style={styles.sectionCount}>{currentPositions.length} vị trí</Text>
            </View>
          </View>

          {/* Hall Banner */}
          <View style={styles.hallBanner}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={styles.hallBadge}>
                <Text style={styles.hallBadgeText}>SẢNH</Text>
              </View>
              <Text style={styles.hallTitle}>{getZoneName(selectedAisleId)}</Text>
            </View>
            <Text style={styles.hallSub}>
              <Text style={{ color: '#fbbf24', fontWeight: '800' }}>
                {currentPositions.filter(p => p.lot_id).length} có hàng
              </Text>
              {' · '}
              <Text style={{ color: '#34d399', fontWeight: '800' }}>
                {currentPositions.filter(p => !p.lot_id).length} trống
              </Text>
            </Text>
          </View>

          {/* Lưới 2 cột các vị trí */}
          {currentPositions.length === 0 ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <Text style={{ color: '#64748b', fontSize: 13 }}>Chưa có dữ liệu vị trí nào trong sảnh này.</Text>
            </View>
          ) : (
            <View style={styles.hallPositionsGrid}>
              {currentPositions.map(pos => {
                const isOccupied = !!pos.lot_id;
                const isHighlighted = pos.id === highlightedPosId;
                const isMatched = matchingPosIds.has(pos.id);

                return (
                  <TouchableOpacity
                    key={pos.id}
                    style={[
                      styles.hallPosCard,
                      isOccupied ? styles.hallPosCardOccupied : styles.hallPosCardEmpty,
                      isMatched && styles.hallPosCardMatched,
                      isHighlighted && styles.hallPosCardHighlighted
                    ]}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setSelectedPosDetail(pos);
                    }}
                    activeOpacity={0.8}
                  >
                    <View style={styles.hallPosCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flex: 1, minWidth: 0, paddingRight: 2 }}>
                        <Text style={styles.hallPosCode} numberOfLines={1}>{pos.code}</Text>
                        {pos.inbound_date ? (
                          <View style={styles.posDateBadge}>
                            <Text style={styles.posDateBadgeText} numberOfLines={1}>
                              {formatDateShortVN(pos.inbound_date)}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      {isOccupied ? (
                        <View style={styles.hallSttBadge}>
                          <Text style={styles.hallSttBadgeText}>#{pos.stt || 'LOT'}</Text>
                        </View>
                      ) : (
                        <View style={styles.hallEmptyBadge}>
                          <Text style={styles.hallEmptyBadgeText}>TRỐNG</Text>
                        </View>
                      )}
                    </View>

                    {isOccupied ? (
                      <View style={{ marginTop: 4, gap: 2 }}>
                        <Text style={styles.hallProductName}>
                          {pos.product_name || 'Hàng đông lạnh'}
                        </Text>
                        <View style={styles.hallPosMetaRow}>
                          {getPositionTag(pos) ? (
                            <Text style={styles.hallTagText} numberOfLines={1}>TAG: {getPositionTag(pos)}</Text>
                          ) : <View style={{ flex: 1 }} />}
                          {pos.quantity ? (
                            <Text style={styles.hallQtyText}>
                              {pos.quantity} {pos.unit?.toLowerCase().startsWith('thùng') ? 'th' : (pos.unit || 'th')}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    ) : (
                      <View style={styles.hallEmptyPlaceholder}>
                        <Text style={styles.hallEmptyPlaceholderText}>+ Vị trí trống</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </ScrollView>
      ) : !selectedSlotId ? (
        /* ── LEVEL 2: DANH SÁCH Ô KỆ TRONG DÃY ─────────────────── */
        <ScrollView style={styles.contentScroll} contentContainerStyle={styles.scrollPadding}>
          <View style={styles.sectionTitleRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity
                style={styles.backLevelBtn}
                onPress={() => setSelectedAisleId(null)}
              >
                <Ionicons name="arrow-back" size={14} color="#38bdf8" />
                <Text style={styles.backLevelText}>Quay lại Dãy</Text>
              </TouchableOpacity>
              <Text style={{ color: '#34d399', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>
                Bước 3: Chọn Ô ({getZoneName(selectedAisleId)})
              </Text>
            </View>
            <Text style={styles.sectionCount}>{slots.length} ô gộp</Text>
          </View>

          <View style={styles.slotsGrid}>
            {slots.map(slot => {
              const stats = zoneStatsMap.get(slot.id) || { total: 0, occupied: 0, empty: 0 };
              const pct = stats.total > 0 ? Math.round((stats.occupied / stats.total) * 100) : 0;
              const matchCount = isSearchActive ? zoneMatchCountMap.get(slot.id) || 0 : 0;

              return (
                <TouchableOpacity
                  key={slot.id}
                  style={[
                    styles.slotCard,
                    matchCount > 0 && styles.slotCardMatched
                  ]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setSelectedSlotId(slot.id);
                    setSelectedTierId(null);
                  }}
                >
                  <Text style={styles.slotCardTitle}>{slot.name}</Text>
                  {matchCount > 0 && (
                    <View style={styles.slotMatchBadge}>
                      <Text style={styles.slotMatchText}>⚡ {matchCount} khớp</Text>
                    </View>
                  )}
                  <Text style={styles.slotEmptyText}>Trống {stats.empty}</Text>

                  <View style={styles.slotCardStats}>
                    <Text style={styles.slotStatsText}>{stats.occupied}/{stats.total} vị trí</Text>
                    <Text style={styles.slotCardPct}>{pct}%</Text>
                  </View>

                  <View style={styles.progressBarBg}>
                    <View
                      style={[
                        styles.progressBarFill,
                        {
                          width: `${pct}%`,
                          backgroundColor: pct >= 90 ? '#f59e0b' : '#10b981'
                        }
                      ]}
                    />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>
      ) : (
        /* ── LEVEL 3: LƯỚI VỊ TRÍ TẦNG CỦA Ô ───────────────────── */
        <View style={{ flex: 1 }}>
          <View style={[styles.sectionTitleRow, { paddingHorizontal: 12, paddingTop: 10 }]}>
            <TouchableOpacity
              style={styles.backLevelBtn}
              onPress={() => setSelectedSlotId(null)}
            >
              <Ionicons name="arrow-back" size={14} color="#38bdf8" />
              <Text style={styles.backLevelText}>Quay lại Ô kệ</Text>
            </TouchableOpacity>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {isSearchActive && (
                <TouchableOpacity
                  style={[styles.onlyMatchToggle, onlyShowMatches && styles.onlyMatchToggleActive]}
                  onPress={() => setOnlyShowMatches(!onlyShowMatches)}
                >
                  <Text style={[styles.onlyMatchToggleText, onlyShowMatches && styles.onlyMatchToggleTextActive]}>
                    ⭐ {onlyShowMatches ? 'Hiện tất cả' : 'Chỉ khớp'}
                  </Text>
                </TouchableOpacity>
              )}
              <Text style={styles.sectionCount}>{currentPositions.length} vị trí</Text>
            </View>
          </View>

          {/* Tiers horizontal tabs */}
          <View style={styles.tierTabsContainer}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }}>
              <TouchableOpacity
                style={[styles.tierTab, !selectedTierId && styles.tierTabActive]}
                onPress={() => setSelectedTierId(null)}
              >
                <Text style={[styles.tierTabText, !selectedTierId && styles.tierTabTextActive]}>
                  Tất cả tầng ({currentPositions.length})
                </Text>
              </TouchableOpacity>

              {tiers.map(tier => {
                const stats = zoneStatsMap.get(tier.id) || { total: 0, occupied: 0, empty: 0 };
                const isAct = selectedTierId === tier.id;
                return (
                  <TouchableOpacity
                    key={tier.id}
                    style={[styles.tierTab, isAct && styles.tierTabActive]}
                    onPress={() => setSelectedTierId(tier.id)}
                  >
                    <Text style={[styles.tierTabText, isAct && styles.tierTabTextActive]}>
                      {tier.name} ({stats.occupied}/{stats.total})
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* Positions Grid & Shelves */}
          <ScrollView contentContainerStyle={styles.positionsGridPadding}>
            {!selectedTierId ? (
              /* Khi xem tất cả tầng: Hiển thị Accordion có Mở tất cả & Thu tất cả (Tầng 1 -> Tầng 5) */
              <View style={styles.tierShelvesContainer}>
                {/* Thanh điều khiển Mở tất cả / Thu tất cả */}
                <View style={styles.tierAccordionHeaderBar}>
                  <Text style={styles.tierAccordionTitle}>
                    Chi tiết theo tầng ({tiers.length} tầng):
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity style={styles.tierToggleBtn} onPress={handleExpandAllTiers}>
                      <Text style={[styles.tierToggleBtnText, { color: '#38bdf8' }]}>+ Mở tất cả</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.tierToggleBtn} onPress={handleCollapseAllTiers}>
                      <Text style={[styles.tierToggleBtnText, { color: '#cbd5e1' }]}>− Thu tất cả</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {tiers.map(tier => {
                  const tierPositions = tierPositionsMap?.get(tier.id) || [];
                  const stats = zoneStatsMap.get(tier.id) || { total: 0, occupied: 0, empty: 0 };
                  const isExpanded = expandedTierIds.has(tier.id);
                  if (tierPositions.length === 0) return null;

                  return (
                    <View key={tier.id} style={[styles.tierAccordionCard, isExpanded && styles.tierAccordionCardExpanded]}>
                      <TouchableOpacity
                        style={[styles.tierAccordionBtn, isExpanded && styles.tierAccordionBtnExpanded]}
                        onPress={() => toggleTierExpand(tier.id)}
                        activeOpacity={0.7}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 }}>
                          <Ionicons
                            name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                            size={14}
                            color={isExpanded ? '#38bdf8' : '#64748b'}
                          />
                          <View style={styles.tierDot} />
                          <Text style={styles.tierAccordionName}>{tier.name}</Text>
                          <Text style={styles.tierOccupancyText}>
                            ({stats.occupied}/{stats.total} vị trí có hàng)
                          </Text>
                        </View>
                        <Text style={styles.tierEmptyCountText}>
                          {stats.empty} trống
                        </Text>
                      </TouchableOpacity>

                      {isExpanded && (
                        <View style={styles.tierAccordionBody}>
                          <View style={styles.positionsGrid}>
                            {tierPositions.map(pos => {
                              const isOccupied = !!pos.lot_id;
                              const isHigh = pos.id === highlightedPosId;
                              const isMatched = isSearchActive && matchingPosIds.has(pos.id);

                              return (
                                <TouchableOpacity
                                  key={pos.id}
                                  style={[
                                    styles.posCard,
                                    isOccupied ? styles.posCardOccupied : styles.posCardEmpty,
                                    isHigh && styles.posCardHighlighted,
                                    isMatched && styles.posCardMatched
                                  ]}
                                  onPress={() => {
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                    setSelectedPosDetail(pos);
                                  }}
                                >
                                  <View style={styles.posCardHeader}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flex: 1, minWidth: 0, paddingRight: 2 }}>
                                      <Text style={styles.posCodeText} numberOfLines={1}>{pos.code}</Text>
                                      {pos.inbound_date ? (
                                        <View style={styles.posDateBadge}>
                                          <Text style={styles.posDateBadgeText} numberOfLines={1}>
                                            {formatDateShortVN(pos.inbound_date)}
                                          </Text>
                                        </View>
                                      ) : null}
                                    </View>
                                    {isOccupied ? (
                                      <View style={styles.posSttBadge}>
                                        <Text style={styles.posSttBadgeText} numberOfLines={1}>
                                          {pos.stt ? `#${pos.stt}` : 'LOT'}
                                        </Text>
                                      </View>
                                    ) : (
                                      <View style={styles.posEmptyBadge}>
                                        <Text style={styles.posEmptyBadgeText}>TRỐNG</Text>
                                      </View>
                                    )}
                                  </View>

                                  {isOccupied ? (
                                    <View style={{ gap: 2 }}>
                                      <Text style={styles.posProdTitle}>
                                        {pos.product_name || 'Hàng đông lạnh'}
                                      </Text>
                                      <View style={styles.posBottomMeta}>
                                        {getPositionTag(pos) ? (
                                          <Text style={styles.posTagText} numberOfLines={1}>
                                            TAG: {getPositionTag(pos)}
                                          </Text>
                                        ) : <View style={{ flex: 1 }} />}
                                        {pos.quantity ? (
                                          <Text style={styles.posQtyText}>
                                            {pos.quantity} {pos.unit?.toLowerCase().startsWith('thùng') ? 'th' : (pos.unit || 'th')}
                                          </Text>
                                        ) : null}
                                      </View>
                                    </View>
                                  ) : (
                                    <View style={styles.emptySlotHint}>
                                      <Text style={styles.emptySlotHintText}>+ Trống</Text>
                                    </View>
                                  )}
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            ) : currentPositions.length === 0 ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Text style={{ color: '#64748b', fontSize: 13 }}>Chưa có vị trí nào trong khu vực này</Text>
              </View>
            ) : (
              <View style={styles.positionsGrid}>
                {currentPositions.map(pos => {
                  const isOccupied = !!pos.lot_id;
                  const isHigh = pos.id === highlightedPosId;
                  const isMatched = isSearchActive && matchingPosIds.has(pos.id);

                  return (
                    <TouchableOpacity
                      key={pos.id}
                      style={[
                        styles.posCard,
                        isOccupied ? styles.posCardOccupied : styles.posCardEmpty,
                        isHigh && styles.posCardHighlighted,
                        isMatched && styles.posCardMatched
                      ]}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setSelectedPosDetail(pos);
                      }}
                    >
                      <View style={styles.posCardHeader}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flex: 1, minWidth: 0, paddingRight: 2 }}>
                          <Text style={styles.posCodeText} numberOfLines={1}>{pos.code}</Text>
                          {pos.inbound_date ? (
                            <View style={styles.posDateBadge}>
                              <Text style={styles.posDateBadgeText} numberOfLines={1}>
                                {formatDateShortVN(pos.inbound_date)}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        {isOccupied ? (
                          <View style={styles.posSttBadge}>
                            <Text style={styles.posSttBadgeText} numberOfLines={1}>
                              {pos.stt ? `#${pos.stt}` : 'LOT'}
                            </Text>
                          </View>
                        ) : (
                          <View style={styles.posEmptyBadge}>
                            <Text style={styles.posEmptyBadgeText}>TRỐNG</Text>
                          </View>
                        )}
                      </View>

                      {isOccupied ? (
                        <View style={{ gap: 2 }}>
                          <Text style={styles.posProdTitle}>
                            {pos.product_name || 'Hàng đông lạnh'}
                          </Text>
                          <View style={styles.posBottomMeta}>
                            {getPositionTag(pos) ? (
                              <Text style={styles.posTagText} numberOfLines={1}>
                                TAG: {getPositionTag(pos)}
                              </Text>
                            ) : <View style={{ flex: 1 }} />}
                            {pos.quantity ? (
                              <Text style={styles.posQtyText}>
                                {pos.quantity} {pos.unit?.toLowerCase().startsWith('thùng') ? 'th' : (pos.unit || 'th')}
                              </Text>
                            ) : null}
                          </View>
                        </View>
                      ) : (
                        <View style={styles.emptySlotHint}>
                          <Text style={styles.emptySlotHintText}>+ Sẵn sàng xếp hàng</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </ScrollView>
        </View>
      )}
        </View>
      )}

      {/* ── MODAL: CHI TIẾT VỊ TRÍ & PALLET ────────────────────── */}
      {selectedPosDetail && (
        <Modal visible={true} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons name="location" size={18} color="#38bdf8" />
                  <Text style={styles.modalTitle}>VỊ TRÍ: {selectedPosDetail.code}</Text>
                </View>
                <TouchableOpacity onPress={() => setSelectedPosDetail(null)}>
                  <Ionicons name="close" size={22} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              {/* Status Banner */}
              {selectedPosDetail.lot_id ? (
                <View style={styles.statusOccupiedBanner}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Ionicons name="cube" size={20} color="#fbbf24" />
                    <View>
                      <Text style={{ color: '#94a3b8', fontSize: 10 }}>TRẠNG THÁI:</Text>
                      <Text style={{ color: '#fde68a', fontWeight: '800', fontSize: 12 }}>
                        ĐÃ CÓ PALLET HÀNG
                      </Text>
                    </View>
                  </View>
                  {selectedPosDetail.stt && (
                    <View style={styles.modalSttPill}>
                      <Text style={styles.modalSttPillText}>STT: {selectedPosDetail.stt}</Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={styles.statusEmptyBanner}>
                  <Ionicons name="checkmark-circle" size={18} color="#34d399" />
                  <Text style={{ color: '#6ee7b7', fontSize: 12, fontWeight: '700' }}>
                    Vị trí hiện đang TRỐNG · Sẵn sàng để xếp Pallet mới
                  </Text>
                </View>
              )}

              {/* Occupied Lot details */}
              {selectedPosDetail.lot_id && (
                <View style={styles.modalDetailCard}>
                  <Text style={{ color: '#94a3b8', fontSize: 10, marginBottom: 2 }}>SẢN PHẨM / PHÂN LOẠI:</Text>
                  <Text style={styles.modalProductName}>
                    {selectedPosDetail.product_name || 'Hàng đông lạnh'}
                  </Text>

                  <View style={styles.modalGrid}>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>MÃ LOT:</Text>
                      <Text style={[styles.modalVal, { color: '#38bdf8', fontWeight: '800' }]}>
                        {selectedPosDetail.lot_code || '---'}
                      </Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>SKU:</Text>
                      <Text style={styles.modalVal}>{selectedPosDetail.sku || '---'}</Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>SỐ LƯỢNG:</Text>
                      <Text style={[styles.modalVal, { color: '#34d399', fontWeight: '800' }]}>
                        {selectedPosDetail.quantity ? `${selectedPosDetail.quantity} ${selectedPosDetail.unit || 'Thùng'}` : '---'}
                      </Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>NGÀY ĐÓNG GÓI:</Text>
                      <Text style={[styles.modalVal, { color: '#fbbf24' }]}>
                        {formatDateVN(selectedPosDetail.packaging_date)}
                      </Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>NGÀY SX (BÓC MÚI):</Text>
                      <Text style={[styles.modalVal, { color: '#fde68a' }]}>
                        {formatDateVN(selectedPosDetail.peeling_date)}
                      </Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>NGÀY NGUYÊN LIỆU:</Text>
                      <Text style={styles.modalVal}>
                        {formatDateVN(selectedPosDetail.raw_material_date)}
                      </Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>NGÀY NHẬP KHO:</Text>
                      <Text style={styles.modalVal}>
                        {formatDateVN(selectedPosDetail.inbound_date)}
                      </Text>
                    </View>

                    {/* 4 Thẻ Thông Tin Chi Tiết của LOT (Khớp Web Mẹ) */}
                    <View style={styles.modalLotInfoSection}>
                      <View style={styles.modalLotInfoCard}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                          <Ionicons name="barcode-outline" size={13} color="#94a3b8" />
                          <Text style={styles.modalDim}>MÃ SẢN XUẤT</Text>
                        </View>
                        <Text style={[styles.modalVal, { color: '#f8fafc', fontSize: 11 }]} numberOfLines={1}>
                          {selectedPosDetail.production_code || '---'}
                        </Text>
                      </View>

                      <View style={styles.modalLotInfoCard}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                          <Ionicons name="location" size={13} color="#34d399" />
                          <Text style={styles.modalDim}>VÙNG NGUYÊN LIỆU</Text>
                        </View>
                        <Text style={[styles.modalVal, { color: '#34d399', fontSize: 11, fontWeight: '700' }]} numberOfLines={2}>
                          {formatMaterialZoneList(selectedPosDetail.material_zone)}
                        </Text>
                      </View>

                      <View style={styles.modalLotInfoCard}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                          <Ionicons name="business" size={13} color="#38bdf8" />
                          <Text style={styles.modalDim}>NƠI SẢN XUẤT</Text>
                        </View>
                        <Text style={[styles.modalVal, { color: '#38bdf8', fontSize: 11, fontWeight: '700' }]} numberOfLines={2}>
                          {selectedPosDetail.production_place || '---'}
                        </Text>
                      </View>

                      <View style={styles.modalLotInfoCard}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                          <Ionicons name="information-circle" size={13} color="#cbd5e1" />
                          <Text style={styles.modalDim}>THÔNG TIN THÊM</Text>
                        </View>
                        <Text style={[styles.modalVal, { color: '#cbd5e1', fontSize: 11 }]} numberOfLines={2}>
                          {selectedPosDetail.extra_info || '---'}
                        </Text>
                      </View>
                    </View>

                    {selectedPosDetail.aliases && (
                      <View style={[styles.modalGridCell, { width: '100%' }]}>
                        <Text style={styles.modalDim}>TÊN VIẾT TẮT (GÕ TẮT):</Text>
                        <Text style={[styles.modalVal, { color: '#6ee7b7' }]}>
                          ⚡ {selectedPosDetail.aliases}
                        </Text>
                      </View>
                    )}

                    {selectedPosDetail.tags && selectedPosDetail.tags.length > 0 && (
                      <View style={{ width: '100%', paddingTop: 6, borderTopWidth: 1, borderTopColor: '#1e293b' }}>
                        <Text style={[styles.modalDim, { marginBottom: 4 }]}>THẺ PHÂN LOẠI (TAGS):</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                          {selectedPosDetail.tags.map((tg, idx) => (
                            <View key={idx} style={{ backgroundColor: '#1e3a5f', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: '#38bdf844' }}>
                              <Text style={{ color: '#7dd3fc', fontSize: 10, fontWeight: '700' }}>🏷️ {tg}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    )}
                  </View>
                </View>
              )}

              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setSelectedPosDetail(null)}
              >
                <Text style={styles.modalCloseBtnText}>Đóng</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0f1d'
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1
  },
  backBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b'
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: '900',
    color: '#f8fafc',
    letterSpacing: 0.5
  },
  headerSub: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 1
  },
  badgeColdStorage: {
    backgroundColor: '#0e749033',
    borderWidth: 1,
    borderColor: '#06b6d466',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4
  },
  badgeColdText: {
    color: '#67e8f9',
    fontSize: 9,
    fontWeight: '800'
  },
  refreshBtn: {
    padding: 8,
    borderRadius: 10,
    backgroundColor: '#1e293b'
  },
  searchSection: {
    padding: 10,
    backgroundColor: '#0e1626',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    zIndex: 100
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  searchInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    paddingHorizontal: 10,
    height: 40
  },
  searchIcon: {
    marginRight: 6
  },
  searchInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  clearSearchBtn: {
    padding: 4
  },
  searchSubmitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#06b6d4',
    paddingHorizontal: 11,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center'
  },
  searchSubmitBtnText: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '900'
  },
  filterToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 10,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    position: 'relative'
  },
  filterToggleBtnActiveAmber: {
    backgroundColor: '#f59e0b',
    borderColor: '#fcd34d'
  },
  filterToggleBtnActiveCyan: {
    backgroundColor: '#083344',
    borderColor: '#06b6d4'
  },
  filterToggleBtnText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700'
  },
  filterActiveDot: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#f43f5e',
    borderWidth: 1.5,
    borderColor: '#0f172a'
  },
  activeFilterChipsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8
  },
  activeFilterLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600'
  },
  activeFilterChipAmber: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#f59e0b22',
    borderWidth: 1,
    borderColor: '#f59e0b66',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8
  },
  activeFilterChipAmberText: {
    color: '#fde68a',
    fontSize: 10,
    fontWeight: '700'
  },
  activeFilterChipEmerald: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#10b98122',
    borderWidth: 1,
    borderColor: '#10b98166',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8
  },
  activeFilterChipEmeraldText: {
    color: '#6ee7b7',
    fontSize: 10,
    fontWeight: '700'
  },
  resetFilterLinkText: {
    color: '#fb7185',
    fontSize: 10,
    fontWeight: '700',
    textDecorationLine: 'underline'
  },
  filterDrawerCard: {
    marginTop: 8,
    padding: 10,
    borderRadius: 14,
    backgroundColor: '#0b1324',
    borderWidth: 1,
    borderColor: '#06b6d466',
    gap: 10
  },
  filterDrawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  filterDrawerTitle: {
    color: '#67e8f9',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4
  },
  filterDrawerResetText: {
    color: '#fb7185',
    fontSize: 10,
    fontWeight: '700'
  },
  filterFieldLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700'
  },
  dateTypeOptionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6
  },
  dateTypeOptionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155'
  },
  dateTypeOptionBtnActive: {
    backgroundColor: '#083344',
    borderColor: '#06b6d4'
  },
  dateTypeOptionText: {
    color: '#cbd5e1',
    fontSize: 10.5,
    fontWeight: '600'
  },
  dateTypeOptionTextActive: {
    color: '#67e8f9',
    fontWeight: '800'
  },
  datePickerTriggerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 8,
    height: 34
  },
  datePickerTriggerText: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  datePresetsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6
  },
  datePresetBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155'
  },
  datePresetBtnText: {
    color: '#cbd5e1',
    fontSize: 10,
    fontWeight: '700'
  },
  regionOptionPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155'
  },
  regionOptionPillActive: {
    backgroundColor: '#064e3b',
    borderColor: '#10b981'
  },
  regionOptionPillText: {
    color: '#cbd5e1',
    fontSize: 10.5,
    fontWeight: '600'
  },
  regionOptionPillTextActive: {
    color: '#6ee7b7',
    fontWeight: '800'
  },
  calNavBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b'
  },
  calDayCell: {
    width: '12.5%',
    aspectRatio: 1,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center'
  },
  calDayCellSelected: {
    backgroundColor: '#06b6d4'
  },
  calDayText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '700'
  },
  calDayTextSelected: {
    color: '#020617',
    fontWeight: '900'
  },
  suggestionsCard: {
    position: 'absolute',
    top: 52,
    left: 10,
    right: 10,
    backgroundColor: '#0b1324',
    borderWidth: 1,
    borderColor: '#38bdf888',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 12,
    zIndex: 100
  },
  suggestionsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  suggestionsHeaderTitle: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '800'
  },
  suggestionsHeaderSub: {
    color: '#64748b',
    fontSize: 9
  },
  suggestionItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b66',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  suggestionTitle: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700'
  },
  suggestionAliasBadge: {
    backgroundColor: '#f59e0b22',
    borderColor: '#f59e0b88',
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4
  },
  suggestionAliasText: {
    color: '#fbbf24',
    fontSize: 9,
    fontWeight: '800'
  },
  suggestionCountBadge: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '700'
  },
  suggestionMeta: {
    color: '#64748b',
    fontSize: 10
  },
  suggestionDirectBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#0f172a',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  suggestionDirectText: {
    color: '#94a3b8',
    fontSize: 11
  },
  suggestionDirectSub: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '700'
  },
  searchResultsDropdown: {
    position: 'absolute',
    top: 55,
    left: 10,
    right: 10,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#38bdf888',
    borderRadius: 14,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 8,
    zIndex: 50
  },
  dropdownHeader: {
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    backgroundColor: '#0f172a'
  },
  dropdownHeaderText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700'
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  dropdownItemCode: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  dropdownItemLot: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2
  },
  itemSttBadge: {
    backgroundColor: '#f59e0b22',
    borderWidth: 1,
    borderColor: '#f59e0b55',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4
  },
  itemSttText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '800'
  },
  itemEmptyBadge: {
    backgroundColor: '#10b98122',
    borderWidth: 1,
    borderColor: '#10b98155',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4
  },
  itemEmptyText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '700'
  },
  breadcrumbBar: {
    paddingVertical: 6,
    backgroundColor: '#0c1322',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  breadcrumbScroll: {
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 6
  },
  crumbBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#1e293b'
  },
  crumbBtnActive: {
    backgroundColor: '#06b6d4'
  },
  crumbText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700'
  },
  crumbTextActive: {
    color: '#0f172a'
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 12
  },
  contentScroll: {
    flex: 1
  },
  scrollPadding: {
    padding: 12
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  sectionTitle: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5
  },
  sectionCount: {
    color: '#64748b',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  whPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    marginRight: 8
  },
  whPillActive: {
    backgroundColor: '#0891b2'
  },
  whPillText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700'
  },
  whPillTextActive: {
    color: '#ffffff'
  },
  warehouseList: {
    gap: 12
  },
  warehouseCard: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 8
  },
  warehouseCardMatched: {
    borderColor: '#0284c7',
    borderWidth: 1.5
  },
  warehouseCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  warehouseCardTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.3
  },
  warehouseCardAction: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700'
  },
  whBreakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#1e293b88'
  },
  whBreakdownText: {
    color: '#94a3b8',
    fontSize: 10
  },
  whMatchBadgeInline: {
    backgroundColor: '#f59e0b22',
    borderWidth: 1,
    borderColor: '#f59e0b55',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12
  },
  whMatchBadgeInlineText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '800'
  },
  aislesList: {
    gap: 10
  },
  hallBanner: {
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#17255422',
    borderWidth: 1,
    borderColor: '#f59e0b44',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  hallBadge: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6
  },
  hallBadgeText: {
    color: '#0f172a',
    fontSize: 10,
    fontWeight: '900'
  },
  hallTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.3
  },
  hallSub: {
    color: '#94a3b8',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  hallPositionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between'
  },
  hallPosCard: {
    width: '48.5%',
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 74,
    justifyContent: 'space-between'
  },
  hallPosCardOccupied: {
    backgroundColor: '#131d33',
    borderColor: '#0284c788'
  },
  hallPosCardEmpty: {
    backgroundColor: '#0f172a88',
    borderColor: '#334155'
  },
  hallPosCardMatched: {
    borderColor: '#f59e0b',
    borderWidth: 1.5
  },
  hallPosCardHighlighted: {
    borderColor: '#fbbf24',
    borderWidth: 2,
    backgroundColor: '#451a03'
  },
  hallPosCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4
  },
  hallPosCode: {
    color: '#e2e8f0',
    fontSize: 8.2,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  hallSttBadge: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 3.5,
    paddingVertical: 1,
    borderRadius: 4
  },
  hallSttBadgeText: {
    color: '#0f172a',
    fontSize: 8,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  hallEmptyBadge: {
    backgroundColor: '#10b98122',
    borderWidth: 1,
    borderColor: '#10b98155',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4
  },
  hallEmptyBadgeText: {
    color: '#34d399',
    fontSize: 8,
    fontWeight: '800'
  },
  hallProductName: {
    color: '#ffffff',
    fontSize: 9.5,
    fontWeight: '700',
    lineHeight: 13
  },
  hallPosMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 3
  },
  hallLotText: {
    color: '#94a3b8',
    fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    maxWidth: '55%'
  },
  hallTagText: {
    color: '#38bdf8',
    fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontWeight: '700',
    maxWidth: '65%'
  },
  hallQtyText: {
    color: '#fbbf24',
    fontSize: 9,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  hallEmptyPlaceholder: {
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  hallEmptyPlaceholderText: {
    color: '#10b981aa',
    fontSize: 10,
    fontWeight: '600'
  },
  aisleCard: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 8
  },
  aisleCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  aisleCardTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800'
  },
  aisleCardAction: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700'
  },
  aisleStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  statLabel: {
    color: '#94a3b8',
    fontSize: 11
  },
  statValWhite: {
    color: '#ffffff',
    fontWeight: '800'
  },
  statValAmber: {
    color: '#fbbf24',
    fontWeight: '800'
  },
  statValEmerald: {
    color: '#34d399',
    fontWeight: '800'
  },
  progressBarBg: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: '#1e293b',
    overflow: 'hidden',
    marginTop: 6
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#10b981',
    borderRadius: 3
  },
  backLevelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  backLevelText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700'
  },
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10
  },
  slotCard: {
    width: '48%',
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    gap: 4
  },
  slotCardTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  slotEmptyText: {
    color: '#34d399',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 4
  },
  slotCardPct: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700'
  },
  slotCardStats: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  slotStatsText: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '700'
  },
  tierTabsContainer: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    backgroundColor: '#0c1322'
  },
  tierTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#1e293b'
  },
  tierTabActive: {
    backgroundColor: '#06b6d4'
  },
  tierTabText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700'
  },
  tierTabTextActive: {
    color: '#0f172a'
  },
  tierShelvesContainer: {
    gap: 8
  },
  tierAccordionHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    paddingBottom: 4,
    marginBottom: 4
  },
  tierAccordionTitle: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700'
  },
  tierToggleBtn: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155'
  },
  tierToggleBtnText: {
    fontSize: 11,
    fontWeight: '700'
  },
  tierAccordionCard: {
    backgroundColor: '#0f172a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
    overflow: 'hidden',
    marginBottom: 6
  },
  tierAccordionCardExpanded: {
    borderColor: '#334155'
  },
  tierAccordionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    backgroundColor: '#0f172a'
  },
  tierAccordionBtnExpanded: {
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    backgroundColor: '#131d2e'
  },
  tierDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#38bdf8'
  },
  tierAccordionName: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase'
  },
  tierEmptyCountText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '700'
  },
  tierAccordionBody: {
    padding: 10
  },
  tierShelfCard: {
    backgroundColor: '#0f172a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 10,
    gap: 8
  },
  tierShelfHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  tierBadge: {
    backgroundColor: '#0284c722',
    borderColor: '#0284c788',
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6
  },
  tierBadgeText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '800'
  },
  tierOccupancyText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600'
  },
  tierFocusLink: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700'
  },
  emptyTierText: {
    color: '#64748b',
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 8
  },
  positionsGridPadding: {
    padding: 12
  },
  positionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  posCard: {
    width: '48.5%',
    padding: 8,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4
  },
  posCardEmpty: {
    backgroundColor: '#0f172a99',
    borderColor: '#10b98155',
    borderStyle: 'dashed'
  },
  posCardOccupied: {
    backgroundColor: '#131d33',
    borderColor: '#06b6d466'
  },
  posCardHighlighted: {
    borderColor: '#f59e0b',
    borderWidth: 2,
    backgroundColor: '#451a0344'
  },
  posCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 3
  },
  posCodeText: {
    color: '#ffffff',
    fontSize: 8.2,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  posDateBadge: {
    backgroundColor: '#10b98118',
    borderWidth: 0.8,
    borderColor: '#10b98166',
    paddingHorizontal: 3.5,
    paddingVertical: 0.5,
    borderRadius: 3.5,
    flexShrink: 0
  },
  posDateBadgeText: {
    color: '#34d399',
    fontSize: 7.6,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  posInboundDateText: {
    color: '#34d399',
    fontSize: 7.6,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 0
  },
  posSttBadge: {
    backgroundColor: '#f59e0b22',
    borderWidth: 1,
    borderColor: '#f59e0b88',
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 4,
    flexShrink: 0
  },
  posSttBadgeText: {
    color: '#fbbf24',
    fontSize: 8,
    fontWeight: '900'
  },
  posEmptyBadge: {
    backgroundColor: '#10b98118',
    borderWidth: 1,
    borderColor: '#10b98155',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    flexShrink: 0
  },
  posEmptyBadgeText: {
    color: '#34d399',
    fontSize: 8.5,
    fontWeight: '700'
  },
  posProdTitle: {
    color: '#e2e8f0',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 12.5
  },
  posBottomMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2
  },
  posLotText: {
    color: '#64748b',
    fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    flex: 1
  },
  posTagText: {
    color: '#38bdf8',
    fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontWeight: '700',
    flex: 1
  },
  posQtyText: {
    color: '#38bdf8',
    fontSize: 9,
    fontWeight: '700'
  },
  emptySlotHint: {
    paddingVertical: 4,
    alignItems: 'center'
  },
  emptySlotHintText: {
    color: '#34d39999',
    fontSize: 9.5,
    fontWeight: '600'
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
    padding: 12
  },
  modalContent: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#06b6d466',
    borderRadius: 20,
    padding: 16,
    gap: 12
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingBottom: 10
  },
  modalTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  statusOccupiedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: 12,
    backgroundColor: '#451a0366',
    borderWidth: 1,
    borderColor: '#f59e0b66'
  },
  statusEmptyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    backgroundColor: '#064e3b66',
    borderWidth: 1,
    borderColor: '#10b98166'
  },
  modalSttPill: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8
  },
  modalSttPillText: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '900'
  },
  modalDetailCard: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 14,
    padding: 12,
    gap: 8
  },
  modalProductName: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 18
  },
  modalGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingTop: 8,
    gap: 8
  },
  modalGridCell: {
    width: '47%'
  },
  modalDim: {
    color: '#64748b',
    fontSize: 9,
    fontWeight: '700'
  },
  modalVal: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 1
  },
  modalLotInfoSection: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b'
  },
  modalLotInfoCard: {
    width: '48%',
    backgroundColor: '#131d2e',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 10,
    padding: 8
  },
  modalCloseBtn: {
    backgroundColor: '#1e293b',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center'
  },
  modalCloseBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800'
  },
  offlineBanner: {
    backgroundColor: '#78350f',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f59e0b55'
  },
  offlineBannerTitle: {
    color: '#fef3c7',
    fontSize: 12,
    fontWeight: '800'
  },
  offlineBannerSub: {
    color: '#fde68a',
    fontSize: 10,
    marginTop: 1
  },
  retryBtn: {
    backgroundColor: '#f59e0b33',
    borderWidth: 1,
    borderColor: '#f59e0b88',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8
  },
  retryBtnText: {
    color: '#fef3c7',
    fontSize: 11,
    fontWeight: '800'
  },
  downloadOfflineBtn: {
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#064e3b',
    borderWidth: 1,
    borderColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center'
  },
  dropdownItemPath: {
    color: '#94a3b8',
    fontSize: 10,
    marginTop: 2
  },
  searchBanner: {
    backgroundColor: '#78350f33',
    borderColor: '#f59e0b66',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  searchBannerText: {
    color: '#cbd5e1',
    fontSize: 11,
    flex: 1
  },
  searchBannerCount: {
    color: '#fbbf24',
    fontWeight: '800'
  },
  searchBannerActionBtn: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6
  },
  searchBannerActionText: {
    color: '#0f172a',
    fontSize: 11,
    fontWeight: '800'
  },
  searchBannerCloseBtn: {
    padding: 4
  },
  whMatchBadge: {
    backgroundColor: '#f59e0b',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginLeft: 6
  },
  whMatchBadgeText: {
    color: '#0f172a',
    fontSize: 9,
    fontWeight: '900'
  },
  whTag: {
    backgroundColor: '#0369a133',
    borderColor: '#0284c766',
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  whTagText: {
    color: '#38bdf8',
    fontSize: 9,
    fontWeight: '700'
  },
  matchCountBadge: {
    backgroundColor: '#f59e0b22',
    borderColor: '#f59e0b88',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6
  },
  matchCountText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '800'
  },
  aisleCardMatched: {
    borderColor: '#f59e0b88',
    backgroundColor: '#1e2433'
  },
  slotCardMatched: {
    borderColor: '#f59e0b88',
    backgroundColor: '#1e2433'
  },
  slotMatchBadge: {
    backgroundColor: '#f59e0b22',
    borderColor: '#f59e0b88',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    marginBottom: 4
  },
  slotMatchText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '800'
  },
  onlyMatchToggle: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8
  },
  onlyMatchToggleActive: {
    backgroundColor: '#f59e0b22',
    borderColor: '#f59e0b'
  },
  onlyMatchToggleText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700'
  },
  onlyMatchToggleTextActive: {
    color: '#fbbf24',
    fontWeight: '800'
  },
  posCardMatched: {
    borderColor: '#f59e0b',
    borderWidth: 1.5,
    backgroundColor: '#2e2013'
  },
  matchTag: {
    backgroundColor: '#f59e0b22',
    borderColor: '#f59e0b88',
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4
  },
  matchTagText: {
    color: '#fbbf24',
    fontSize: 8,
    fontWeight: '900'
  },

  /* ── DEDICATED SEARCH VIEW STYLES ── */
  searchTabsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#0c1322',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  searchTabsGroup: {
    flexDirection: 'row',
    gap: 6
  },
  searchTabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155'
  },
  searchTabBtnActive: {
    backgroundColor: '#0369a1',
    borderColor: '#38bdf8'
  },
  searchTabBtnText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600'
  },
  searchTabBtnTextActive: {
    color: '#ffffff',
    fontWeight: '800'
  },
  clearSearchTextBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5
  },
  clearSearchLabel: {
    color: '#ef4444',
    fontSize: 11,
    fontWeight: '700'
  },

  searchHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  searchHeaderTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800'
  },
  searchHeaderSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2
  },
  searchSwitchMapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#082f49',
    borderColor: '#0284c7',
    borderWidth: 1,
    borderRadius: 8
  },
  searchSwitchMapBtnText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700'
  },

  statusFilterBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155'
  },
  statusFilterBtnActive: {
    backgroundColor: '#334155',
    borderColor: '#64748b'
  },
  statusFilterBtnActiveOccupied: {
    backgroundColor: '#451a03',
    borderColor: '#f59e0b'
  },
  statusFilterBtnActiveEmpty: {
    backgroundColor: '#064e3b',
    borderColor: '#10b981'
  },
  statusFilterBtnText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600'
  },
  statusFilterBtnTextActive: {
    color: '#ffffff',
    fontWeight: '700'
  },
  statusFilterBtnTextActiveOccupied: {
    color: '#fbbf24',
    fontWeight: '800'
  },
  statusFilterBtnTextActiveEmpty: {
    color: '#34d399',
    fontWeight: '800'
  },

  searchResultCard: {
    backgroundColor: '#131d2e',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1e293b'
  },
  searchResultCardOccupied: {
    borderColor: '#334155',
    borderLeftWidth: 3,
    borderLeftColor: '#f59e0b'
  },
  searchResultCardEmpty: {
    borderColor: '#1e293b',
    borderLeftWidth: 3,
    borderLeftColor: '#10b981',
    opacity: 0.9
  },
  searchResultCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4
  },
  searchResultCode: {
    color: '#38bdf8',
    fontSize: 14,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  searchResultWhText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700'
  },
  searchResultPath: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
    flex: 1
  },
  searchResultProductBox: {
    backgroundColor: '#1e293b',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8
  },
  searchResultProductName: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4
  },
  aliasBadge: {
    backgroundColor: '#064e3b',
    borderColor: '#059669',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-start',
    marginBottom: 4,
    maxWidth: 120
  },
  aliasBadgeText: {
    color: '#6ee7b7',
    fontSize: 10,
    fontWeight: '700'
  },
  searchResultMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#334155'
  },
  searchResultMetaText: {
    color: '#94a3b8',
    fontSize: 11
  },

  searchResultActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b'
  },
  searchJumpMapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6
  },
  searchJumpMapBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700'
  },
  searchPosDetailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155'
  },
  searchPosDetailBtnText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600'
  },

  loadMoreBtn: {
    paddingVertical: 12,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    marginTop: 6,
    marginBottom: 20
  },
  loadMoreBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700'
  },

  mapSearchReturnBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1e2433',
    borderBottomWidth: 1,
    borderBottomColor: '#f59e0b44'
  },
  mapSearchReturnText: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '700'
  },
  mapSearchReturnBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#f59e0b',
    borderRadius: 6
  },
  mapSearchReturnBtnText: {
    color: '#0f172a',
    fontSize: 11,
    fontWeight: '800'
  },

  /* ── BỘ THỐNG KÊ KẾT QUẢ TÌM KIẾM THEO KHO (CHUẨN WEB /SCANNER) ── */
  searchStatsPanel: {
    backgroundColor: '#0b1324',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8
  },
  searchStatsRow1: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  amberPulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fbbf24'
  },
  searchStatsQueryText: {
    fontSize: 12,
    color: '#e2e8f0',
    flex: 1
  },
  matchCountPillCyan: {
    backgroundColor: '#083344',
    borderWidth: 1,
    borderColor: '#155e75',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6
  },
  matchCountPillCyanText: {
    color: '#22d3ee',
    fontSize: 11,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  clearAllSearchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6
  },
  clearAllSearchBtnText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700'
  },
  quickFilterToggleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: '#0f172acc',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6
  },
  quickFilterToggleText: {
    color: '#fcd34d',
    fontSize: 11,
    fontWeight: '700',
    flex: 1
  },
  quickFilterOpenBtn: {
    backgroundColor: '#f59e0b33',
    borderWidth: 1,
    borderColor: '#f59e0b66',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6
  },
  quickFilterOpenBtnText: {
    color: '#fcd34d',
    fontSize: 10,
    fontWeight: '800'
  },
  webSearchTabGrid: {
    flexDirection: 'row',
    gap: 6,
    padding: 4,
    backgroundColor: '#0f172ae6',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b'
  },
  webSearchTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: 8
  },
  webSearchTabBtnMapActive: {
    backgroundColor: '#06b6d4'
  },
  webSearchTabBtnBreakdownActive: {
    backgroundColor: '#fbbf24'
  },
  webSearchTabBtnText: {
    color: '#94a3b8',
    fontSize: 11.5,
    fontWeight: '700'
  },
  webSearchTabBtnTextActive: {
    color: '#020617',
    fontWeight: '900'
  },
  webSearchTabQtyBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10
  },
  webSearchTabQtyBadgeActive: {
    backgroundColor: '#02061733'
  },
  webSearchTabQtyBadgeInactive: {
    backgroundColor: '#f59e0b33'
  },
  webSearchTabQtyBadgeText: {
    fontSize: 9.5,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  webWhFilterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b'
  },
  webWhFilterPillAllActive: {
    backgroundColor: '#06b6d4',
    borderColor: '#06b6d4'
  },
  webWhFilterPillWhActive: {
    backgroundColor: '#f59e0b',
    borderColor: '#f59e0b'
  },
  webWhFilterPillText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700'
  },
  webWhFilterPillTextActive: {
    color: '#020617',
    fontWeight: '900'
  },
  webWhFilterCountBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10
  },
  webWhFilterCountText: {
    fontSize: 10,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },

  /* ── BẢNG THỐNG KÊ PHÂN BỔ TỒN KHO (CHUẨN WEB /SCANNER) ── */
  breakdownSummaryCard: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#f59e0b55',
    borderRadius: 16,
    padding: 12,
    gap: 10
  },
  breakdownSummaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  breakdownSummaryTitle: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4
  },
  breakdownExpandActionText: {
    color: '#94a3b8',
    fontSize: 10,
    textDecorationLine: 'underline'
  },
  breakdownKpiRow: {
    flexDirection: 'row',
    gap: 8
  },
  kpiCardAmber: {
    flex: 1,
    backgroundColor: '#451a034d',
    borderWidth: 1,
    borderColor: '#f59e0b4d',
    borderRadius: 12,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 70
  },
  kpiCardCyan: {
    flex: 1,
    backgroundColor: '#0833444d',
    borderWidth: 1,
    borderColor: '#06b6d44d',
    borderRadius: 12,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 70
  },
  kpiCardEmerald: {
    flex: 1,
    backgroundColor: '#064e3b4d',
    borderWidth: 1,
    borderColor: '#10b9814d',
    borderRadius: 12,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 70
  },
  kpiLabel: {
    color: '#94a3b8',
    fontSize: 9.5,
    fontWeight: '700'
  },
  kpiValueAmber: {
    color: '#fcd34d',
    fontSize: 16,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 2
  },
  kpiValueCyan: {
    color: '#67e8f9',
    fontSize: 16,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 2
  },
  kpiValueEmerald: {
    color: '#6ee7b7',
    fontSize: 16,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 2
  },
  kpiUnitAmber: {
    color: '#fbbf24cc',
    fontSize: 10,
    fontWeight: '600'
  },
  kpiUnitCyan: {
    color: '#22d3eecc',
    fontSize: 10,
    fontWeight: '600'
  },
  kpiUnitEmerald: {
    color: '#34d399cc',
    fontSize: 10,
    fontWeight: '600'
  },
  breakdownWhCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
    backgroundColor: '#0c1424',
    overflow: 'hidden'
  },
  breakdownWhHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    gap: 8
  },
  breakdownWhIconBox: {
    width: 24,
    height: 24,
    borderRadius: 8,
    backgroundColor: '#06b6d41a',
    borderWidth: 1,
    borderColor: '#06b6d44d',
    alignItems: 'center',
    justifyContent: 'center'
  },
  breakdownWhName: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    flex: 1
  },
  breakdownWhQtyText: {
    color: '#fcd34d',
    fontSize: 12,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  breakdownWhSubText: {
    color: '#94a3b8',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  breakdownJumpWhBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#083344cc',
    borderWidth: 1,
    borderColor: '#155e75'
  },
  breakdownJumpWhBtnText: {
    color: '#67e8f9',
    fontSize: 10,
    fontWeight: '800'
  },
  breakdownAisleListWrap: {
    padding: 8,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    backgroundColor: '#02061766'
  },
  breakdownAisleCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
    backgroundColor: '#0e182b',
    overflow: 'hidden'
  },
  breakdownAisleHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 8,
    gap: 8
  },
  breakdownAisleName: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '800',
    flex: 1
  },
  breakdownAisleQtyText: {
    color: '#fcd34d',
    fontSize: 12,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  breakdownAisleCountText: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '600'
  },
  breakdownJumpAisleBtn: {
    padding: 4,
    borderRadius: 6
  },
  breakdownSlotsListWrap: {
    padding: 6,
    gap: 5,
    borderTopWidth: 1,
    borderTopColor: '#1e293b88',
    backgroundColor: '#080e1a'
  },
  breakdownSlotCard: {
    borderRadius: 8,
    backgroundColor: '#0f172a99',
    borderWidth: 1,
    borderColor: '#1e293b',
    overflow: 'hidden'
  },
  breakdownSlotCardExpanded: {
    borderColor: '#06b6d466',
    backgroundColor: '#0c1629'
  },
  breakdownSlotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 8
  },
  breakdownSlotDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#22d3ee'
  },
  breakdownSlotName: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700'
  },
  breakdownSlotPCount: {
    color: '#64748b',
    fontSize: 10
  },
  breakdownZoneBadge: {
    backgroundColor: '#10b9811a',
    borderWidth: 1,
    borderColor: '#10b9814d',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  breakdownZoneBadgeText: {
    color: '#6ee7b7',
    fontSize: 9,
    fontWeight: '600'
  },
  breakdownDateText: {
    color: '#94a3b8',
    fontSize: 9.5,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  breakdownSlotQtyText: {
    color: '#34d399',
    fontSize: 12,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  breakdownViewPosLink: {
    color: '#22d3ee',
    fontSize: 10.5,
    fontWeight: '800'
  },
  breakdownTierListWrap: {
    paddingHorizontal: 8,
    paddingBottom: 8,
    paddingTop: 6,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    backgroundColor: '#060b16'
  },
  breakdownTierCard: {
    borderRadius: 8,
    backgroundColor: '#0d1729',
    borderWidth: 1,
    borderColor: '#1e293b',
    overflow: 'hidden'
  },
  breakdownTierCardExpanded: {
    borderColor: '#f59e0b66',
    backgroundColor: '#111b2e'
  },
  breakdownTierHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 7,
    gap: 8
  },
  breakdownTierBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#451a0366',
    borderWidth: 1,
    borderColor: '#f59e0b55',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5
  },
  breakdownTierName: {
    color: '#fcd34d',
    fontSize: 11,
    fontWeight: '800'
  },
  breakdownTierCountText: {
    color: '#94a3b8',
    fontSize: 10
  },
  breakdownTierQtyText: {
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  breakdownJumpTierBtn: {
    backgroundColor: '#083344',
    borderWidth: 1,
    borderColor: '#155e75',
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 5
  },
  breakdownJumpTierBtnText: {
    color: '#67e8f9',
    fontSize: 10,
    fontWeight: '800'
  },
  breakdownTierPositionsList: {
    paddingHorizontal: 8,
    paddingBottom: 7,
    paddingTop: 5,
    gap: 5,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    backgroundColor: '#070c17'
  },
  breakdownPosRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 8
  },
  breakdownPosRowCode: {
    color: '#38bdf8',
    fontSize: 11.5,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  breakdownPosRowQty: {
    color: '#34d399',
    fontSize: 11.5,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  }
});
