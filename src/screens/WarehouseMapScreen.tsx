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
  getLastWarehouseMapOfflineSyncInfo
} from '../services/supabase';
import { decodeSTT } from '../utils/numberUtils';
import { groupWarehouseData } from '../utils/warehouseUtils';
import { matchPalletSearch, calculateSearchScore, matchSearch, normalizeSearchString } from '../utils/searchUtils';

export interface UniqueProductItem {
  name: string;
  sku: string | null;
  aliases: string | null;
  unit: string;
  positionCount: number;
  totalQuantity: number;
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

interface ZoneItem {
  id: string;
  name: string;
  parent_id: string | null;
  system_type: string;
}

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
  inbound_date?: string | null;
  quantity?: number | null;
}

// ── ISOLATED MEMOIZED SEARCH BAR (0ms Latency: typing updates only this component) ──
const MobileWarehouseSearchBar = React.memo(function MobileWarehouseSearchBar({
  uniqueProducts,
  searchQuery,
  onExecuteSearch,
  onClearSearch
}: {
  uniqueProducts: UniqueProductItem[];
  searchQuery: string;
  onExecuteSearch: (query: string) => void;
  onClearSearch: () => void;
}) {
  const [inputValue, setInputValue] = useState(searchQuery);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    setInputValue(searchQuery);
  }, [searchQuery]);

  const suggestions = useMemo(() => {
    const q = inputValue.trim();
    if (!q || q.length < 1) return [];

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

    return list.sort((a, b) => b.score - a.score).slice(0, 8);
  }, [inputValue, uniqueProducts]);

  const handleSelect = (name: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputValue(name);
    setShowSuggestions(false);
    onExecuteSearch(name);
  };

  const handleSubmit = (customTerm?: string) => {
    const term = (customTerm !== undefined ? customTerm : inputValue).trim();
    if (!term) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowSuggestions(false);
    onExecuteSearch(term);
  };

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
            placeholder="Nhập tên sản phẩm (đô, ri6...), LOT, vị trí..."
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
          <Ionicons name="search" size={14} color="#fff" />
          <Text style={styles.searchSubmitBtnText}>Tìm</Text>
        </TouchableOpacity>
      </View>

      {/* ── DROPDOWN GỢI Ý SẢN PHẨM ── */}
      {showSuggestions && inputValue.trim().length > 0 && (
        <View style={styles.suggestionsCard}>
          <View style={styles.suggestionsHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Ionicons name="sparkles" size={12} color="#fbbf24" />
              <Text style={styles.suggestionsHeaderTitle}>
                GỢI Ý SẢN PHẨM ({suggestions.length})
              </Text>
            </View>
            <TouchableOpacity onPress={() => setShowSuggestions(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={14} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {suggestions.length > 0 ? (
            <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
              {suggestions.map((item, idx) => (
                <TouchableOpacity
                  key={idx}
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
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
                      <Text style={styles.suggestionCountBadge}>
                        📍 {item.product.positionCount} vị trí
                      </Text>
                      {item.product.sku ? (
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
              <Text style={{ color: '#94a3b8', fontSize: 11 }}>Không có sản phẩm nào khớp từ khóa</Text>
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [zones, setZones] = useState<ZoneItem[]>([]);
  const [positions, setPositions] = useState<PositionItem[]>([]);

  // Hierarchy Navigation: Kho -> Dãy/Sảnh -> Ô -> Tầng
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>('all');
  const [selectedAisleId, setSelectedAisleId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [onlyShowMatches, setOnlyShowMatches] = useState(false);

  // Search state (searchQuery drives the map, while typing is fully isolated in MobileWarehouseSearchBar)
  const [searchQuery, setSearchQuery] = useState('');
  const [activeView, setActiveView] = useState<'map' | 'search_list'>('map');
  const [searchFilterWhId, setSearchFilterWhId] = useState<string>('all');
  const [searchFilterStatus, setSearchFilterStatus] = useState<'all' | 'occupied' | 'empty'>('all');
  const [searchPageLimit, setSearchPageLimit] = useState<number>(50);
  const [highlightedPosId, setHighlightedPosId] = useState<string | null>(null);

  // Modal detail
  const [selectedPosDetail, setSelectedPosDetail] = useState<PositionItem | null>(null);

  // Offline state
  const [isOffline, setIsOffline] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [downloadingOffline, setDownloadingOffline] = useState(false);

  // ── Fetch Master Data (Zones, Positions, Lots) ─────────────────
  const loadMapData = useCallback(async (isSilent = false) => {
    let hasCache = false;

    // 1. Initial cached fallback - display immediately so mobile map opens in 0s!
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
        setLoading(false);
        setRefreshing(true);
      }
    } catch {
      // ignore
    }

    if (!hasCache) {
      if (!isSilent) setLoading(true);
      else setRefreshing(true);
    }

    // 2. Fetch fresh online & auto-cache in background
    try {
      const res = await syncWarehouseMapOffline();
      if (res.success) {
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
        const fresh = await getWarehouseMapOfflineData();
        if (fresh) {
          setZones(fresh.zones);
          setPositions(fresh.positions);
          setCachedAt(fresh.cachedAt);
          setIsOffline(false);
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

  const isSearchActive = searchQuery.trim().length > 0;

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
        const existing = prodMap.get(name);
        if (existing) {
          existing.positionCount++;
          existing.totalQuantity += (p.quantity || 0);
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
          prodMap.set(name, {
            name,
            sku: p.sku || null,
            aliases: p.aliases || null,
            unit: p.unit || 'Thùng',
            positionCount: 1,
            totalQuantity: p.quantity || 0,
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

  // Thực hiện tìm kiếm (chỉ cập nhật map khi người dùng chọn gợi ý hoặc ấn Tìm)
  const handleExecuteSearch = useCallback((term: string) => {
    const q = term.trim();
    if (!q) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSearchQuery(q);
    setActiveView('search_list');
    setSearchPageLimit(50);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setActiveView('map');
    setHighlightedPosId(null);
  }, []);

  // ── Search & Filter Logic (High Performance with Pre-Scoring) ──
  const matchingPositions = useMemo(() => {
    const q = searchQuery.trim();
    if (!q || q.length < 1) return [];

    const matched: { pos: PositionItem; score: number }[] = [];
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (matchPalletSearch(p, q)) {
        const score = calculateSearchScore(p, q, {
          name: p.product_name,
          code: p.code,
          lot_code: p.lot_code,
          aliases: p.aliases
        });
        matched.push({ pos: p, score });
      }
    }

    matched.sort((a, b) => b.score - a.score);
    return matched.map(m => m.pos);
  }, [searchQuery, positions]);

  const matchingPosIds = useMemo(() => {
    return new Set(matchingPositions.map(p => p.id));
  }, [matchingPositions]);

  // Fast match count per zone (only loops over matching positions, NOT all positions)
  const zoneMatchCountMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!isSearchActive || activeZones.length === 0 || matchingPositions.length === 0) return map;

    activeZones.forEach(z => {
      const descSet = zoneDescendantsMap.get(z.id);
      if (!descSet) return;
      let count = 0;
      for (let i = 0; i < matchingPositions.length; i++) {
        const p = matchingPositions[i];
        if (p.zone_ids.some(zid => descSet.has(zid))) {
          count++;
        }
      }
      if (count > 0) map.set(z.id, count);
    });

    return map;
  }, [isSearchActive, matchingPositions, activeZones, zoneDescendantsMap]);

  const filteredSearchResults = useMemo(() => {
    let list = matchingPositions;
    if (searchFilterWhId !== 'all') {
      const descIds = getDescendantZoneIds(searchFilterWhId);
      list = list.filter(p => p.zone_ids.some(zid => descIds.has(zid)));
    }
    if (searchFilterStatus === 'occupied') {
      list = list.filter(p => !!p.lot_id);
    } else if (searchFilterStatus === 'empty') {
      list = list.filter(p => !p.lot_id);
    }
    return list;
  }, [matchingPositions, searchFilterWhId, searchFilterStatus, getDescendantZoneIds]);

  const searchStats = useMemo(() => {
    let occupied = 0;
    let empty = 0;
    matchingPositions.forEach(p => {
      if (p.lot_id) occupied++;
      else empty++;
    });
    return { total: matchingPositions.length, occupied, empty };
  }, [matchingPositions]);

  const aisles = useMemo(() => {
    let list: ZoneItem[] = [];
    if (!selectedWarehouseId || selectedWarehouseId === 'all') {
      const whIds = new Set(warehouses.map(w => w.id));
      list = activeZones.filter(z => z.parent_id && whIds.has(z.parent_id));
    } else {
      list = activeZones.filter(z => z.parent_id === selectedWarehouseId);
    }

    if (isSearchActive) {
      return [...list].sort((a, b) => {
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
      return [...list].sort((a, b) => {
        const countA = zoneMatchCountMap.get(a.id) || 0;
        const countB = zoneMatchCountMap.get(b.id) || 0;
        if (countA !== countB) return countB - countA;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
    }
    return sortZones(list);
  }, [activeZones, selectedAisleId, isSearchActive, zoneMatchCountMap]);

  // Tiers -> Tầng của Ô gộp (Sắp xếp từ tầng cao nhất xuống tầng thấp nhất như kệ thực tế: Tầng 5 -> 4 -> 3 -> 2 -> 1)
  const tiers = useMemo(() => {
    if (!selectedSlotId) return [];
    const list = activeZones.filter(z => z.parent_id === selectedSlotId);
    return list.sort((a, b) =>
      (b.name || '').localeCompare(a.name || '', undefined, { numeric: true })
    );
  }, [activeZones, selectedSlotId]);

  // ── Stats Calculator per Zone (O(1) Set Lookups) ───────────────
  const zoneStatsMap = useMemo(() => {
    const map = new Map<string, { total: number; occupied: number; empty: number }>();
    if (activeZones.length === 0 || positions.length === 0) return map;

    activeZones.forEach(z => {
      const descSet = zoneDescendantsMap.get(z.id);
      let total = 0;
      let occupied = 0;

      if (descSet) {
        for (let i = 0; i < positions.length; i++) {
          const p = positions[i];
          if (p.zone_ids.some(zid => descSet.has(zid))) {
            total++;
            if (p.lot_id) occupied++;
          }
        }
      }

      map.set(z.id, {
        total,
        occupied,
        empty: Math.max(0, total - occupied)
      });
    });

    return map;
  }, [activeZones, positions, zoneDescendantsMap]);

  // Current positions in Slot / Tier view (fix: selectedTierId uses getDescendantZoneIds)
  const currentPositions = useMemo(() => {
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
  }, [selectedSlotId, selectedTierId, positions, getDescendantZoneIds, onlyShowMatches, isSearchActive, matchingPosIds]);

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

  // ── Search & Jump to Position (Smart Vietnamese & Abbreviation search) ──
  const searchResults = useMemo(() => {
    const q = searchQuery.trim();
    if (!q || q.length < 1) return [];

    return positions
      .filter(p => matchPalletSearch(p, q))
      .sort((a, b) => {
        const scoreA = calculateSearchScore(a, q, { name: a.product_name, code: a.code, lot_code: a.lot_code, aliases: a.aliases });
        const scoreB = calculateSearchScore(b, q, { name: b.product_name, code: b.code, lot_code: b.lot_code, aliases: b.aliases });
        return scoreB - scoreA;
      })
      .slice(0, 30);
  }, [searchQuery, positions]);

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
    setActiveView('map');
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
              Tổng {positions.length} vị trí · {positions.filter(p => p.lot_id).length} có hàng · {positions.filter(p => !p.lot_id).length} trống
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <TouchableOpacity
            style={styles.downloadOfflineBtn}
            onPress={handleDownloadOffline}
            disabled={downloadingOffline}
          >
            {downloadingOffline ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="cloud-download-outline" size={18} color="#34d399" />
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.refreshBtn}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              loadMapData(true);
            }}
            disabled={refreshing}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color="#38bdf8" />
            ) : (
              <Ionicons name="refresh" size={18} color="#cbd5e1" />
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
              loadMapData(true);
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
        searchQuery={searchQuery}
        onExecuteSearch={handleExecuteSearch}
        onClearSearch={handleClearSearch}
      />

      {/* ── SEARCH VIEW TABS: DANH SÁCH vs SƠ ĐỒ ────────────────── */}
      {isSearchActive && (
        <View style={styles.searchTabsBar}>
          <View style={styles.searchTabsGroup}>
            <TouchableOpacity
              style={[styles.searchTabBtn, activeView === 'search_list' && styles.searchTabBtnActive]}
              onPress={() => setActiveView('search_list')}
            >
              <Ionicons name="list" size={13} color={activeView === 'search_list' ? '#0f172a' : '#94a3b8'} />
              <Text style={[styles.searchTabBtnText, activeView === 'search_list' && styles.searchTabBtnTextActive]}>
                Danh sách ({matchingPositions.length})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.searchTabBtn, activeView === 'map' && styles.searchTabBtnActive]}
              onPress={() => setActiveView('map')}
            >
              <Ionicons name="map" size={13} color={activeView === 'map' ? '#0f172a' : '#94a3b8'} />
              <Text style={[styles.searchTabBtnText, activeView === 'map' && styles.searchTabBtnTextActive]}>
                Sơ đồ kho
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.clearSearchTextBtn}
            onPress={handleClearSearch}
          >
            <Ionicons name="close" size={13} color="#94a3b8" />
            <Text style={styles.clearSearchLabel}>Xóa</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── BREADCRUMB NAVIGATION (Only on Map view) ───────────── */}
      {activeView === 'map' && (
        <View style={styles.breadcrumbBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.breadcrumbScroll}>
            <TouchableOpacity
              style={[styles.crumbBtn, !selectedAisleId && styles.crumbBtnActive]}
              onPress={() => {
                setSelectedAisleId(null);
                setSelectedSlotId(null);
                setSelectedTierId(null);
              }}
            >
              <Ionicons name="business" size={12} color={!selectedAisleId ? '#0f172a' : '#cbd5e1'} />
              <Text style={[styles.crumbText, !selectedAisleId && styles.crumbTextActive]}>
                {getZoneName(selectedWarehouseId) || 'Tất cả Kho'}
              </Text>
            </TouchableOpacity>

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
      ) : isSearchActive && activeView === 'search_list' ? (
        /* ── GIAO DIỆN HIỂN THỊ KẾT QUẢ TÌM KIẾM DÀNH RIÊNG (MOBILE) ── */
        <ScrollView style={styles.contentScroll} contentContainerStyle={styles.scrollPadding}>
          {/* Header row */}
          <View style={styles.searchHeaderRow}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="search" size={14} color="#38bdf8" />
                <Text style={styles.searchHeaderTitle} numberOfLines={1}>
                  Kết quả cho "{searchQuery}"
                </Text>
              </View>
              <Text style={styles.searchHeaderSub}>
                Tìm thấy {filteredSearchResults.length} vị trí ({searchStats.occupied} có hàng, {searchStats.empty} trống)
              </Text>
            </View>
            <TouchableOpacity
              style={styles.searchSwitchMapBtn}
              onPress={() => setActiveView('map')}
            >
              <Ionicons name="map-outline" size={13} color="#38bdf8" />
              <Text style={styles.searchSwitchMapBtnText}>Xem sơ đồ</Text>
            </TouchableOpacity>
          </View>

          {/* Warehouse Filter Pills */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
            <TouchableOpacity
              style={[styles.whPill, searchFilterWhId === 'all' && styles.whPillActive]}
              onPress={() => setSearchFilterWhId('all')}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={[styles.whPillText, searchFilterWhId === 'all' && styles.whPillTextActive]}>
                  Tất cả kho
                </Text>
                <View style={styles.whMatchBadge}>
                  <Text style={styles.whMatchBadgeText}>{matchingPositions.length}</Text>
                </View>
              </View>
            </TouchableOpacity>

            {warehouses.map(wh => {
              const matchCount = zoneMatchCountMap.get(wh.id) || 0;
              if (matchCount === 0) return null;
              return (
                <TouchableOpacity
                  key={wh.id}
                  style={[styles.whPill, searchFilterWhId === wh.id && styles.whPillActive]}
                  onPress={() => setSearchFilterWhId(wh.id)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={[styles.whPillText, searchFilterWhId === wh.id && styles.whPillTextActive]}>
                      {wh.name}
                    </Text>
                    <View style={styles.whMatchBadge}>
                      <Text style={styles.whMatchBadgeText}>{matchCount}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Status Filter Pills: Tất cả, Có hàng, Trống */}
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
            <TouchableOpacity
              style={[styles.statusFilterBtn, searchFilterStatus === 'all' && styles.statusFilterBtnActive]}
              onPress={() => setSearchFilterStatus('all')}
            >
              <Text style={[styles.statusFilterBtnText, searchFilterStatus === 'all' && styles.statusFilterBtnTextActive]}>
                Tất cả ({matchingPositions.length})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.statusFilterBtn, searchFilterStatus === 'occupied' && styles.statusFilterBtnActiveOccupied]}
              onPress={() => setSearchFilterStatus('occupied')}
            >
              <Text style={[styles.statusFilterBtnText, searchFilterStatus === 'occupied' && styles.statusFilterBtnTextActiveOccupied]}>
                Có hàng ({searchStats.occupied})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.statusFilterBtn, searchFilterStatus === 'empty' && styles.statusFilterBtnActiveEmpty]}
              onPress={() => setSearchFilterStatus('empty')}
            >
              <Text style={[styles.statusFilterBtnText, searchFilterStatus === 'empty' && styles.statusFilterBtnTextActiveEmpty]}>
                Trống ({searchStats.empty})
              </Text>
            </TouchableOpacity>
          </View>

          {/* Results List */}
          {filteredSearchResults.length === 0 ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <Text style={{ color: '#64748b', fontSize: 13 }}>Không có vị trí nào thỏa mãn bộ lọc hiện tại.</Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {filteredSearchResults.slice(0, searchPageLimit).map(p => {
                const isOccupied = !!p.lot_id;
                return (
                  <View
                    key={p.id}
                    style={[
                      styles.searchResultCard,
                      isOccupied ? styles.searchResultCardOccupied : styles.searchResultCardEmpty
                    ]}
                  >
                    {/* Header */}
                    <View style={styles.searchResultCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                        <Text style={styles.searchResultCode}>📍 {p.code}</Text>
                        {p.stt ? (
                          <View style={styles.posSttBadge}>
                            <Text style={styles.posSttBadgeText}>STT: #{p.stt}</Text>
                          </View>
                        ) : isOccupied ? (
                          <View style={[styles.posSttBadge, { backgroundColor: '#f59e0b22', borderColor: '#f59e0b66' }]}>
                            <Text style={styles.posSttBadgeText}>CÓ HÀNG</Text>
                          </View>
                        ) : (
                          <View style={styles.posEmptyBadge}>
                            <Text style={styles.posEmptyBadgeText}>TRỐNG</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.searchResultWhText}>
                        {getPositionPath(p).split(' > ')[0] || ''}
                      </Text>
                    </View>

                    {/* Path */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons name="location-outline" size={12} color="#38bdf8" />
                      <Text style={styles.searchResultPath} numberOfLines={1}>
                        {getPositionPath(p)}
                      </Text>
                    </View>

                    {/* Lot / Product info */}
                    {isOccupied && (
                      <View style={styles.searchResultProductBox}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
                          <Text style={styles.searchResultProductName} numberOfLines={2}>
                            {p.product_name || 'Hàng đông lạnh'}
                          </Text>
                          {p.aliases ? (
                            <View style={styles.aliasBadge}>
                              <Text style={styles.aliasBadgeText}>⚡ {p.aliases}</Text>
                            </View>
                          ) : null}
                        </View>

                        <View style={styles.searchResultMetaRow}>
                          <Text style={styles.searchResultMetaText}>LOT: <Text style={{ color: '#fbbf24', fontWeight: '800' }}>{p.lot_code || '---'}</Text></Text>
                          {p.quantity ? (
                            <Text style={styles.searchResultMetaText}>Số lượng: <Text style={{ color: '#fff', fontWeight: '800' }}>{p.quantity} Thùng</Text></Text>
                          ) : null}
                        </View>
                      </View>
                    )}

                    {/* Actions */}
                    <View style={styles.searchResultActionsRow}>
                      <TouchableOpacity
                        style={styles.searchJumpMapBtn}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          handleJumpToMap(p);
                        }}
                      >
                        <Ionicons name="map" size={13} color="#0f172a" />
                        <Text style={styles.searchJumpMapBtnText}>Xem vị trí trên sơ đồ</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.searchPosDetailBtn}
                        onPress={() => setSelectedPosDetail(p)}
                      >
                        <Ionicons name="information-circle-outline" size={14} color="#cbd5e1" />
                        <Text style={styles.searchPosDetailBtnText}>Chi tiết</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}

              {filteredSearchResults.length > searchPageLimit && (
                <TouchableOpacity
                  style={styles.loadMoreBtn}
                  onPress={() => setSearchPageLimit(prev => prev + 50)}
                >
                  <Text style={styles.loadMoreBtnText}>
                    Xem thêm 50 vị trí tiếp theo (còn {filteredSearchResults.length - searchPageLimit})
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </ScrollView>
      ) : (
        /* ── XEM TRÊN SƠ ĐỒ KHO ── */
        <View style={{ flex: 1 }}>
          {isSearchActive && (
            <View style={styles.mapSearchReturnBanner}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                <Ionicons name="filter" size={14} color="#f59e0b" />
                <Text style={styles.mapSearchReturnText} numberOfLines={1}>
                  Đang xem sơ đồ: "{searchQuery}" ({matchingPositions.length} vị trí)
                </Text>
              </View>
              <TouchableOpacity
                style={styles.mapSearchReturnBtn}
                onPress={() => setActiveView('search_list')}
              >
                <Ionicons name="list" size={12} color="#0f172a" />
                <Text style={styles.mapSearchReturnBtnText}>Danh sách ({matchingPositions.length})</Text>
              </TouchableOpacity>
            </View>
          )}

          {!selectedAisleId ? (
            /* ── LEVEL 1: DANH SÁCH DÃY / SẢNH ─────────────────────── */
            <ScrollView style={styles.contentScroll} contentContainerStyle={styles.scrollPadding}>
              <View style={styles.sectionTitleRow}>
                <Text style={styles.sectionTitle}>
                  CHỌN DÃY / SẢNH ({getZoneName(selectedWarehouseId)}):
                </Text>
                <Text style={styles.sectionCount}>{aisles.length} phân khu</Text>
              </View>

          {/* Switch Warehouse Pills */}
          {warehouses.length > 0 && (
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

              {warehouses.map(wh => {
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
                    <View style={[styles.progressBarFill, { width: `${pct}%` }]} />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
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
                    <View style={[styles.progressBarFill, { width: `${pct}%` }]} />
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
                    ⭐ Chỉ khớp ({matchingPosIds.size})
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
              /* Khi xem tất cả tầng: Hiển thị dạng KỆ KHO từng TẦNG (từ trên xuống: Tầng 5 -> Tầng 1) */
              <View style={styles.tierShelvesContainer}>
                {tiers.map(tier => {
                  const tierPositions = tierPositionsMap?.get(tier.id) || [];
                  const stats = zoneStatsMap.get(tier.id) || { total: 0, occupied: 0, empty: 0 };
                  const pct = stats.total > 0 ? Math.round((stats.occupied / stats.total) * 100) : 0;

                  return (
                    <View key={tier.id} style={styles.tierShelfCard}>
                      <TouchableOpacity
                        style={styles.tierShelfHeader}
                        onPress={() => setSelectedTierId(tier.id)}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={styles.tierBadge}>
                            <Text style={styles.tierBadgeText}>{tier.name}</Text>
                          </View>
                          <Text style={styles.tierOccupancyText}>
                            {stats.occupied}/{stats.total} vị trí ({pct}%)
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                          <Text style={styles.tierFocusLink}>Xem riêng</Text>
                          <Ionicons name="chevron-forward" size={13} color="#38bdf8" />
                        </View>
                      </TouchableOpacity>

                      {tierPositions.length === 0 ? (
                        <Text style={styles.emptyTierText}>Chưa có vị trí nào trong tầng này</Text>
                      ) : (
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
                                  <Text style={styles.posCodeText} numberOfLines={1}>{pos.code}</Text>
                                  {isMatched && (
                                    <View style={styles.matchTag}>
                                      <Text style={styles.matchTagText}>⭐ Khớp</Text>
                                    </View>
                                  )}
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
                                    <Text style={styles.posProdTitle} numberOfLines={1}>
                                      {pos.product_name || 'Hàng đông lạnh'}
                                    </Text>
                                    <View style={styles.posBottomMeta}>
                                      <Text style={styles.posLotText} numberOfLines={1}>
                                        {pos.lot_code || '---'}
                                      </Text>
                                      {pos.quantity ? (
                                        <Text style={styles.posQtyText}>{pos.quantity} Thùng</Text>
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
                        <Text style={styles.posCodeText} numberOfLines={1}>{pos.code}</Text>
                        {isMatched && (
                          <View style={styles.matchTag}>
                            <Text style={styles.matchTagText}>⭐ Khớp</Text>
                          </View>
                        )}
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
                          <Text style={styles.posProdTitle} numberOfLines={1}>
                            {pos.product_name || 'Hàng đông lạnh'}
                          </Text>
                          <View style={styles.posBottomMeta}>
                            <Text style={styles.posLotText} numberOfLines={1}>
                              LOT: {pos.lot_code || '---'}
                            </Text>
                            {pos.quantity ? (
                              <Text style={styles.posQtyText}>{pos.quantity} Thùng</Text>
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
                      <Text style={styles.modalDim}>NGÀY ĐÓNG GÓI (NSX):</Text>
                      <Text style={[styles.modalVal, { color: '#fbbf24' }]}>
                        {selectedPosDetail.packaging_date || '---'}
                      </Text>
                    </View>
                    <View style={[styles.modalGridCell, { width: '100%' }]}>
                      <Text style={styles.modalDim}>NGÀY NHẬP KHO:</Text>
                      <Text style={styles.modalVal}>
                        {selectedPosDetail.inbound_date || '---'}
                      </Text>
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
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center'
  },
  searchSubmitBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700'
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
  aislesList: {
    gap: 10
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
    height: 4,
    borderRadius: 2,
    backgroundColor: '#1e293b',
    overflow: 'hidden'
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#06b6d4',
    borderRadius: 2
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
    gap: 12
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
    gap: 4
  },
  posCodeText: {
    color: '#ffffff',
    fontSize: 10.5,
    fontWeight: '800',
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  posSttBadge: {
    backgroundColor: '#f59e0b22',
    borderWidth: 1,
    borderColor: '#f59e0b88',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    flexShrink: 0
  },
  posSttBadgeText: {
    color: '#fbbf24',
    fontSize: 8.5,
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
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14
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
    width: 36,
    height: 36,
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
    fontSize: 14,
    fontWeight: '800'
  },
  searchResultWhText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700'
  },
  searchResultPath: {
    color: '#64748b',
    fontSize: 11,
    marginBottom: 6
  },
  searchResultProductBox: {
    backgroundColor: '#1e293b',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8
  },
  searchResultProductName: {
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
    marginBottom: 4
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
  }
});
