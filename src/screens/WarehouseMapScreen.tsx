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
import { matchPalletSearch, calculateSearchScore } from '../utils/searchUtils';

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

export default function WarehouseMapScreen({ onBackToScanner }: { onBackToScanner: () => void }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [zones, setZones] = useState<ZoneItem[]>([]);
  const [positions, setPositions] = useState<PositionItem[]>([]);

  // Hierarchy Navigation: Kho -> Dãy/Sảnh -> Ô -> Tầng
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>(null);
  const [selectedAisleId, setSelectedAisleId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [highlightedPosId, setHighlightedPosId] = useState<string | null>(null);

  // Modal detail
  const [selectedPosDetail, setSelectedPosDetail] = useState<PositionItem | null>(null);

  // Offline state
  const [isOffline, setIsOffline] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [downloadingOffline, setDownloadingOffline] = useState(false);

  // ── Fetch Master Data (Zones, Positions, Lots) ─────────────────
  const loadMapData = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    else setRefreshing(true);

    // 1. Initial cached fallback if not loaded yet
    try {
      const offline = await getWarehouseMapOfflineData();
      if (offline && offline.zones && offline.zones.length > 0) {
        setZones(offline.zones);
        setPositions(offline.positions);
        setCachedAt(offline.cachedAt);
        if (!selectedWarehouseId) {
          const firstWh = offline.zones.find((z: any) => !z.parent_id);
          if (firstWh) setSelectedWarehouseId(firstWh.id);
        }
      }
    } catch {
      // ignore
    }

    // 2. Fetch fresh online & auto-cache
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
            const firstWh = fresh.zones.find((z: any) => !z.parent_id);
            if (firstWh) setSelectedWarehouseId(firstWh.id);
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

  const aisles = useMemo(() => {
    if (!selectedWarehouseId) return [];
    return sortZones(activeZones.filter(z => z.parent_id === selectedWarehouseId));
  }, [activeZones, selectedWarehouseId]);

  // Slots -> Ô GỘP: Ô 01, Ô 02...
  const slots = useMemo(() => {
    if (!selectedAisleId) return [];
    return sortZones(activeZones.filter(z => z.parent_id === selectedAisleId));
  }, [activeZones, selectedAisleId]);

  // Tiers -> Tầng của Ô gộp (Sắp xếp từ tầng cao nhất xuống tầng thấp nhất như kệ thực tế: Tầng 5 -> 4 -> 3 -> 2 -> 1)
  const tiers = useMemo(() => {
    if (!selectedSlotId) return [];
    const list = activeZones.filter(z => z.parent_id === selectedSlotId);
    return list.sort((a, b) =>
      (b.name || '').localeCompare(a.name || '', undefined, { numeric: true })
    );
  }, [activeZones, selectedSlotId]);

  const getDescendantZoneIds = useCallback(
    (targetZoneId: string): string[] => {
      const directMembers = virtualToRealMap.get(targetZoneId) || [targetZoneId];
      const allRealIds = new Set<string>(directMembers);
      let added = true;
      while (added) {
        added = false;
        for (const z of zones) {
          if (z.parent_id && allRealIds.has(z.parent_id) && !allRealIds.has(z.id)) {
            allRealIds.add(z.id);
            added = true;
          }
        }
      }
      return Array.from(allRealIds);
    },
    [zones, virtualToRealMap]
  );

  // ── Stats Calculator per Zone ──────────────────────────────────
  const zoneStatsMap = useMemo(() => {
    const map = new Map<string, { total: number; occupied: number; empty: number }>();
    if (activeZones.length === 0 || positions.length === 0) return map;

    activeZones.forEach(z => {
      const descIds = new Set(getDescendantZoneIds(z.id));
      let total = 0;
      let occupied = 0;

      positions.forEach(p => {
        if (p.zone_ids.some(zid => descIds.has(zid))) {
          total++;
          if (p.lot_id) occupied++;
        }
      });

      map.set(z.id, {
        total,
        occupied,
        empty: Math.max(0, total - occupied)
      });
    });

    return map;
  }, [activeZones, positions, getDescendantZoneIds]);

  // Current positions in Slot / Tier view (fix: selectedTierId uses getDescendantZoneIds)
  const currentPositions = useMemo(() => {
    if (!selectedSlotId) return [];

    const targetZoneIds = new Set(
      getDescendantZoneIds(selectedTierId || selectedSlotId)
    );

    const filtered = positions.filter(p =>
      p.zone_ids.some(zid => targetZoneIds.has(zid))
    );

    return filtered.sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true })
    );
  }, [selectedSlotId, selectedTierId, positions, getDescendantZoneIds]);

  // Group positions by tier when viewing all tiers in a Slot
  const tierPositionsMap = useMemo(() => {
    if (!selectedSlotId || selectedTierId) return null;
    const map = new Map<string, typeof positions>();
    tiers.forEach(tier => {
      const tierZoneIds = new Set(getDescendantZoneIds(tier.id));
      const posInTier = positions
        .filter(p => p.zone_ids.some(zid => tierZoneIds.has(zid)))
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
      map.set(tier.id, posInTier);
    });
    return map;
  }, [selectedSlotId, selectedTierId, tiers, positions, getDescendantZoneIds]);

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
      .slice(0, 15);
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
    setSearchQuery('');
    setIsSearching(false);
    setSelectedPosDetail(pos);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const getZoneName = (id: string | null) =>
    activeZones.find(z => z.id === id)?.name || '';

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

      {/* ── SEARCH BAR WITH AUTOCOMPLETE ───────────────────────── */}
      <View style={styles.searchSection}>
        <View style={styles.searchInputWrap}>
          <Ionicons name="search" size={16} color="#94a3b8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={txt => {
              setSearchQuery(txt);
              setIsSearching(true);
            }}
            placeholder="Tìm theo STT (G22...), Mã Vị Trí, LOT, SP..."
            placeholderTextColor="#64748b"
            autoCapitalize="characters"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setSearchQuery('');
                setIsSearching(false);
              }}
              style={styles.clearSearchBtn}
            >
              <Ionicons name="close-circle" size={18} color="#94a3b8" />
            </TouchableOpacity>
          )}
        </View>

        {/* Dropdown Results */}
        {isSearching && searchQuery.trim().length > 0 && (
          <View style={styles.searchResultsDropdown}>
            <View style={styles.dropdownHeader}>
              <Text style={styles.dropdownHeaderText}>
                Kết quả ({searchResults.length}) - Bấm để nhảy tới vị trí
              </Text>
            </View>
            {searchResults.length === 0 ? (
              <View style={{ padding: 16, alignItems: 'center' }}>
                <Text style={{ color: '#64748b', fontSize: 12 }}>
                  Không tìm thấy vị trí hoặc Pallet nào
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
                {searchResults.map(p => (
                  <TouchableOpacity
                    key={p.id}
                    style={styles.dropdownItem}
                    onPress={() => handleSelectSearchResult(p)}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.dropdownItemCode}>📍 {p.code}</Text>
                        {p.stt ? (
                          <View style={styles.itemSttBadge}>
                            <Text style={styles.itemSttText}>STT: {p.stt}</Text>
                          </View>
                        ) : (
                          <View style={styles.itemEmptyBadge}>
                            <Text style={styles.itemEmptyText}>TRỐNG</Text>
                          </View>
                        )}
                      </View>
                      {p.lot_code && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                          <Text style={[styles.dropdownItemLot, { flexShrink: 1 }]} numberOfLines={1}>
                            {p.product_name || p.lot_code}
                          </Text>
                          {p.aliases ? (
                            <View style={{ backgroundColor: '#064e3b', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: '#10b98144' }}>
                              <Text style={{ color: '#6ee7b7', fontSize: 9, fontWeight: '700' }}>⚡ {p.aliases}</Text>
                            </View>
                          ) : null}
                        </View>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#64748b" />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        )}
      </View>

      {/* ── BREADCRUMB NAVIGATION (Kho > Dãy > Ô > Tầng) ───────── */}
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
              {getZoneName(selectedWarehouseId) || 'Chọn Kho'}
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

      {/* ── MAIN CONTENT ──────────────────────────────────────── */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Đang tải sơ đồ kho...</Text>
        </View>
      ) : !selectedAisleId ? (
        /* ── LEVEL 1: DANH SÁCH DÃY / SẢNH ─────────────────────── */
        <ScrollView style={styles.contentScroll} contentContainerStyle={styles.scrollPadding}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionTitle}>
              CHỌN DÃY / SẢNH ({getZoneName(selectedWarehouseId)}):
            </Text>
            <Text style={styles.sectionCount}>{aisles.length} phân khu</Text>
          </View>

          {/* Switch Warehouse Pills */}
          {warehouses.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {warehouses.map(wh => (
                <TouchableOpacity
                  key={wh.id}
                  style={[styles.whPill, wh.id === selectedWarehouseId && styles.whPillActive]}
                  onPress={() => {
                    setSelectedWarehouseId(wh.id);
                    setSelectedAisleId(null);
                    setSelectedSlotId(null);
                    setSelectedTierId(null);
                  }}
                >
                  <Text style={[styles.whPillText, wh.id === selectedWarehouseId && styles.whPillTextActive]}>
                    🏢 {wh.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <View style={styles.aislesList}>
            {aisles.map(aisle => {
              const stats = zoneStatsMap.get(aisle.id) || { total: 0, occupied: 0, empty: 0 };
              const pct = stats.total > 0 ? Math.round((stats.occupied / stats.total) * 100) : 0;

              return (
                <TouchableOpacity
                  key={aisle.id}
                  style={styles.aisleCard}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setSelectedAisleId(aisle.id);
                    setSelectedSlotId(null);
                    setSelectedTierId(null);
                  }}
                >
                  <View style={styles.aisleCardHeader}>
                    <Text style={styles.aisleCardTitle}>🚪 {aisle.name}</Text>
                    <Text style={styles.aisleCardAction}>Xem Ô →</Text>
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

              return (
                <TouchableOpacity
                  key={slot.id}
                  style={styles.slotCard}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setSelectedSlotId(slot.id);
                    setSelectedTierId(null);
                  }}
                >
                  <Text style={styles.slotCardTitle}>{slot.name}</Text>
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
            <Text style={styles.sectionCount}>{currentPositions.length} vị trí</Text>
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

                            return (
                              <TouchableOpacity
                                key={pos.id}
                                style={[
                                  styles.posCard,
                                  isOccupied ? styles.posCardOccupied : styles.posCardEmpty,
                                  isHigh && styles.posCardHighlighted
                                ]}
                                onPress={() => {
                                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                  setSelectedPosDetail(pos);
                                }}
                              >
                                <View style={styles.posCardHeader}>
                                  <Text style={styles.posCodeText} numberOfLines={1}>{pos.code}</Text>
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

                  return (
                    <TouchableOpacity
                      key={pos.id}
                      style={[
                        styles.posCard,
                        isOccupied ? styles.posCardOccupied : styles.posCardEmpty,
                        isHigh && styles.posCardHighlighted
                      ]}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setSelectedPosDetail(pos);
                      }}
                    >
                      <View style={styles.posCardHeader}>
                        <Text style={styles.posCodeText} numberOfLines={1}>{pos.code}</Text>
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
    zIndex: 10
  },
  searchInputWrap: {
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
  }
});
