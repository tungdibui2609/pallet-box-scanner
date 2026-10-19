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
  Platform
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { getSupabaseClient } from '../services/supabase';
import { decodeSTT } from '../utils/numberUtils';

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

  // ── Fetch Master Data (Zones, Positions, Lots) ─────────────────
  const loadMapData = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    else setRefreshing(true);

    try {
      const client = await getSupabaseClient();

      // 1. Fetch Zones
      const { data: zonesData } = await client
        .from('zones')
        .select('id, name, parent_id, system_type')
        .eq('system_type', 'KHO_DONG_LANH');

      const rawZones: ZoneItem[] = zonesData || [];
      setZones(rawZones);

      // 2. Fetch positions & zone_positions
      const [posRes, zpRes] = await Promise.all([
        client
          .from('positions')
          .select('id, code, lot_id, system_type')
          .eq('system_type', 'KHO_DONG_LANH'),
        client.from('zone_positions').select('position_id, zone_id')
      ]);

      const rawPositions = posRes.data || [];
      const zpList = zpRes.data || [];

      const zpMap = new Map<string, string[]>();
      zpList.forEach((item: any) => {
        const list = zpMap.get(item.position_id) || [];
        list.push(item.zone_id);
        zpMap.set(item.position_id, list);
      });

      // 3. Fetch Lots info for occupied positions
      const occupiedLotIds = Array.from(new Set(rawPositions.map((p: any) => p.lot_id).filter(Boolean)));
      let lotMap = new Map<string, any>();

      if (occupiedLotIds.length > 0) {
        const { data: lotsData } = await client
          .from('lots')
          .select(`
            id,
            code,
            daily_seq,
            packaging_date,
            inbound_date,
            quantity,
            products ( name, sku ),
            lot_items ( products ( name, sku ) )
          `)
          .in('id', occupiedLotIds);

        lotsData?.forEach((l: any) => {
          const prodName =
            l.products?.name ||
            l.lot_items?.[0]?.products?.name ||
            'Hàng đông lạnh';
          const sku =
            l.products?.sku ||
            l.lot_items?.[0]?.products?.sku ||
            'SKU';

          lotMap.set(l.id, {
            code: l.code,
            stt: l.daily_seq ? decodeSTT(l.daily_seq) : null,
            product_name: prodName,
            sku,
            packaging_date: l.packaging_date,
            inbound_date: l.inbound_date,
            quantity: l.quantity
          });
        });
      }

      // 4. Fetch pending assignments
      const { data: pendingData } = await client
        .from('pending_assignments')
        .select('position_id, lot_stt, production_date')
        .eq('system_code', 'KHO_DONG_LANH')
        .eq('status', 'pending');

      const pendingMap = new Map<string, any>();
      pendingData?.forEach((p: any) => {
        if (p.position_id) {
          pendingMap.set(p.position_id, {
            stt: decodeSTT(p.lot_stt),
            packaging_date: p.production_date
          });
        }
      });

      // Combine positions
      const formattedPositions: PositionItem[] = rawPositions.map((p: any) => {
        const lotInfo = p.lot_id ? lotMap.get(p.lot_id) : null;
        const pendInfo = pendingMap.get(p.id);

        const stt = lotInfo?.stt || pendInfo?.stt || null;
        const lotCode = lotInfo?.code || (pendInfo ? 'Chờ duyệt LOT' : null);
        const productName = lotInfo?.product_name || (pendInfo ? 'Đang chờ gán LOT' : null);
        const sku = lotInfo?.sku || null;
        const pkgDate = lotInfo?.packaging_date || pendInfo?.packaging_date || null;

        return {
          id: p.id,
          code: p.code,
          lot_id: p.lot_id || (pendInfo ? 'pending' : null),
          zone_ids: zpMap.get(p.id) || [],
          stt,
          lot_code: lotCode,
          product_name: productName,
          sku,
          packaging_date: pkgDate,
          inbound_date: lotInfo?.inbound_date || null,
          quantity: lotInfo?.quantity || null
        };
      });

      setPositions(formattedPositions);

      // Auto-select first warehouse
      if (!selectedWarehouseId) {
        const firstWh = rawZones.find(z => !z.parent_id);
        if (firstWh) setSelectedWarehouseId(firstWh.id);
      }
    } catch (err: any) {
      console.warn('Lỗi tải dữ liệu sơ đồ kho trên mobile:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedWarehouseId]);

  useEffect(() => {
    loadMapData();
  }, []);

  // ── Hierarchy Filtering ────────────────────────────────────────
  const sortZones = (list: ZoneItem[]) =>
    [...list].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })
    );

  const warehouses = useMemo(
    () => sortZones(zones.filter(z => !z.parent_id)),
    [zones]
  );

  const aisles = useMemo(() => {
    if (!selectedWarehouseId) return [];
    return sortZones(zones.filter(z => z.parent_id === selectedWarehouseId));
  }, [zones, selectedWarehouseId]);

  const slots = useMemo(() => {
    if (!selectedAisleId) return [];
    return sortZones(zones.filter(z => z.parent_id === selectedAisleId));
  }, [zones, selectedAisleId]);

  const tiers = useMemo(() => {
    if (!selectedSlotId) return [];
    return sortZones(zones.filter(z => z.parent_id === selectedSlotId));
  }, [zones, selectedSlotId]);

  const getDescendantZoneIds = useCallback(
    (targetZoneId: string): string[] => {
      const allIds = new Set<string>([targetZoneId]);
      let added = true;
      while (added) {
        added = false;
        for (const z of zones) {
          if (z.parent_id && allIds.has(z.parent_id) && !allIds.has(z.id)) {
            allIds.add(z.id);
            added = true;
          }
        }
      }
      return Array.from(allIds);
    },
    [zones]
  );

  // ── Stats Calculator per Zone ──────────────────────────────────
  const zoneStatsMap = useMemo(() => {
    const map = new Map<string, { total: number; occupied: number; empty: number }>();
    if (zones.length === 0 || positions.length === 0) return map;

    zones.forEach(z => {
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
  }, [zones, positions, getDescendantZoneIds]);

  // Current positions in Slot / Tier view
  const currentPositions = useMemo(() => {
    if (!selectedSlotId) return [];

    let targetZoneIds: Set<string>;
    if (selectedTierId) {
      targetZoneIds = new Set([selectedTierId]);
    } else {
      targetZoneIds = new Set(getDescendantZoneIds(selectedSlotId));
    }

    const filtered = positions.filter(p =>
      p.zone_ids.some(zid => targetZoneIds.has(zid))
    );

    return filtered.sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true })
    );
  }, [selectedSlotId, selectedTierId, positions, getDescendantZoneIds]);

  // ── Search & Jump to Position ──────────────────────────────────
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    if (!q || q.length < 1) return [];

    return positions
      .filter(p => {
        const matchCode = p.code.toUpperCase().includes(q);
        const matchStt = p.stt && p.stt.toUpperCase().includes(q);
        const matchLot = p.lot_code && p.lot_code.toUpperCase().includes(q);
        const matchProd = p.product_name && p.product_name.toUpperCase().includes(q);
        return matchCode || matchStt || matchLot || matchProd;
      })
      .slice(0, 10);
  }, [searchQuery, positions]);

  const handleSelectSearchResult = (pos: PositionItem) => {
    const leafZoneId = pos.zone_ids[0];
    if (leafZoneId) {
      const zoneMap = new Map(zones.map(z => [z.id, z]));
      let curr = zoneMap.get(leafZoneId);
      const path: ZoneItem[] = [];

      while (curr) {
        path.unshift(curr);
        curr = curr.parent_id ? zoneMap.get(curr.parent_id) : undefined;
      }

      if (path.length >= 1) setSelectedWarehouseId(path[0].id);
      if (path.length >= 2) setSelectedAisleId(path[1].id);
      if (path.length >= 3) setSelectedSlotId(path[2].id);
      if (path.length >= 4) setSelectedTierId(path[3].id);
      else setSelectedTierId(null);
    }

    setHighlightedPosId(pos.id);
    setSearchQuery('');
    setIsSearching(false);
    setSelectedPosDetail(pos);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const getZoneName = (id: string | null) =>
    zones.find(z => z.id === id)?.name || '';

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
                        <Text style={styles.dropdownItemLot} numberOfLines={1}>
                          {p.product_name || p.lot_code}
                        </Text>
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
            <TouchableOpacity
              style={styles.backLevelBtn}
              onPress={() => setSelectedAisleId(null)}
            >
              <Ionicons name="arrow-back" size={14} color="#38bdf8" />
              <Text style={styles.backLevelText}>Quay lại Dãy</Text>
            </TouchableOpacity>
            <Text style={styles.sectionCount}>{slots.length} ô kệ</Text>
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
                  <View style={styles.slotCardHeader}>
                    <Text style={styles.slotCardTitle}>📦 {slot.name}</Text>
                    <Text style={styles.slotCardPct}>{pct}%</Text>
                  </View>

                  <View style={styles.slotCardStats}>
                    <Text style={styles.slotStatsText}>{stats.occupied}/{stats.total}</Text>
                    <Text style={styles.slotEmptyText}>{stats.empty} trống</Text>
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

          {/* Positions Grid */}
          <ScrollView contentContainerStyle={styles.positionsGridPadding}>
            {currentPositions.length === 0 ? (
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
                        <Text style={styles.posCodeText}>{pos.code}</Text>
                        {isOccupied ? (
                          <View style={styles.posSttBadge}>
                            <Text style={styles.posSttBadgeText}>
                              STT: {pos.stt || 'LOT'}
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
                          <Text style={styles.posProdTitle} numberOfLines={2}>
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
                  <Text style={{ color: '#94a3b8', fontSize: 10, marginBottom: 2 }}>SẢN PHẨM:</Text>
                  <Text style={styles.modalProductName}>
                    {selectedPosDetail.product_name || 'Hàng lưu kho'}
                  </Text>

                  <View style={styles.modalGrid}>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>MÃ LOT:</Text>
                      <Text style={styles.modalVal}>{selectedPosDetail.lot_code || '---'}</Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>SKU:</Text>
                      <Text style={styles.modalVal}>{selectedPosDetail.sku || '---'}</Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>NGÀY ĐÓNG GÓI:</Text>
                      <Text style={[styles.modalVal, { color: '#fbbf24' }]}>
                        {selectedPosDetail.packaging_date || '---'}
                      </Text>
                    </View>
                    <View style={styles.modalGridCell}>
                      <Text style={styles.modalDim}>SỐ LƯỢNG:</Text>
                      <Text style={styles.modalVal}>
                        {selectedPosDetail.quantity ? `${selectedPosDetail.quantity} Thùng` : '---'}
                      </Text>
                    </View>
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
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 6
  },
  slotCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  slotCardTitle: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800'
  },
  slotCardPct: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '700'
  },
  slotCardStats: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  slotStatsText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700'
  },
  slotEmptyText: {
    color: '#34d399',
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
  positionsGridPadding: {
    padding: 12
  },
  positionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10
  },
  posCard: {
    width: '48%',
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6
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
    justifyContent: 'space-between'
  },
  posCodeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace'
  },
  posSttBadge: {
    backgroundColor: '#f59e0b22',
    borderWidth: 1,
    borderColor: '#f59e0b66',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  posSttBadgeText: {
    color: '#fbbf24',
    fontSize: 9,
    fontWeight: '900'
  },
  posEmptyBadge: {
    backgroundColor: '#10b98122',
    borderWidth: 1,
    borderColor: '#10b98166',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  posEmptyBadgeText: {
    color: '#34d399',
    fontSize: 9,
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
    paddingVertical: 8,
    alignItems: 'center'
  },
  emptySlotHintText: {
    color: '#34d39999',
    fontSize: 10,
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
  }
});
