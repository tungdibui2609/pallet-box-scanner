import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Image,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, AppThemeColors } from '../../contexts/ThemeContext';
import type { DeliveryShift, ShiftProductItem } from '../../services/operationsService';
import type { QuickSnapItem } from '../../services/quickSnapStore';

interface Props {
  visible: boolean;
  snaps: QuickSnapItem[];
  openShifts: DeliveryShift[];
  allProducts: ShiftProductItem[];
  recentProducts: ShiftProductItem[];
  onClose: () => void;
  onCaptureMore: () => void;
  onDeleteSnap: (id: string) => Promise<void>;
  onChangeSnapShift: (snapId: string, shift: DeliveryShift) => Promise<void>;
  onSaveToShiftAlbum: (snap: QuickSnapItem) => void;
  onAssignSnap: (
    snap: QuickSnapItem,
    payload: {
      product: ShiftProductItem;
      direction: 'in' | 'out';
      quantity: number;
      unit: string;
      note?: string;
    }
  ) => void;
}

function normalizeVi(str?: string | null): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function QuickSnapQueueModal({
  visible,
  snaps,
  openShifts,
  allProducts,
  recentProducts,
  onClose,
  onCaptureMore,
  onDeleteSnap,
  onChangeSnapShift,
  onSaveToShiftAlbum,
  onAssignSnap,
}: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [selectedProduct, setSelectedProduct] = useState<ShiftProductItem | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<string>('');
  const [qtyStr, setQtyStr] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [recentlyAssignedIds, setRecentlyAssignedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    if (snaps.length > 0 && !snaps.some(s => s.id === selectedId)) {
      setSelectedId(snaps[0].id);
    }
  }, [visible, snaps, selectedId]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setSelectedProduct(null);
      setSelectedUnit('');
      setQtyStr('');
      setNote('');
    }
  }, [visible]);

  const activeSnap = useMemo(
    () => snaps.find(s => s.id === selectedId) || snaps[0] || null,
    [snaps, selectedId]
  );

  const unitOptions = useMemo(() => {
    if (!selectedProduct) return [];
    const raw =
      selectedProduct.available_units && selectedProduct.available_units.length > 0
        ? selectedProduct.available_units
        : selectedProduct.unit
          ? [selectedProduct.unit]
          : [];
    return Array.from(new Set(raw.map(u => u.trim()).filter(Boolean))).sort((a, b) => {
      const aBox = a.toLowerCase().includes('thùng') ? 0 : 1;
      const bBox = b.toLowerCase().includes('thùng') ? 0 : 1;
      return aBox - bBox;
    });
  }, [selectedProduct]);

  useEffect(() => {
    if (!selectedProduct) {
      setSelectedUnit('');
      return;
    }
    setSelectedUnit(unitOptions[0] || selectedProduct.unit || '');
  }, [selectedProduct, unitOptions]);

  const activeShift = useMemo(
    () => (activeSnap ? openShifts.find(s => s.id === activeSnap.shiftId) || null : null),
    [openShifts, activeSnap]
  );

  const shiftPinnedProducts = useMemo(() => {
    const rawPinned: ShiftProductItem[] = Array.isArray(activeShift?.summary_data?.pinned_products)
      ? activeShift!.summary_data!.pinned_products!
      : [];
    if (rawPinned.length === 0) return [];
    const byId = new Map(allProducts.map(p => [p.id, p]));
    const bySku = new Map(
      allProducts.filter(p => p.sku).map(p => [String(p.sku).trim().toLowerCase(), p])
    );
    return rawPinned.map(p => {
      const fresh =
        byId.get(p.id) || (p.sku ? bySku.get(String(p.sku).trim().toLowerCase()) : undefined);
      return fresh ? { ...p, ...fresh } : p;
    });
  }, [activeShift, allProducts]);

  const quickPickProducts = useMemo(() => {
    const base = shiftPinnedProducts.length > 0 ? shiftPinnedProducts : recentProducts;
    const byId = new Map<string, ShiftProductItem>();
    allProducts.forEach(p => byId.set(p.id, p));
    base.forEach(p => byId.set(p.id, p));

    const recentInOrder: ShiftProductItem[] = [];
    const seen = new Set<string>();
    for (const id of recentlyAssignedIds) {
      const p = byId.get(id);
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        recentInOrder.push(p);
      }
    }
    for (const p of base) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        recentInOrder.push(p);
      }
    }
    return recentInOrder.slice(0, 12);
  }, [shiftPinnedProducts, recentProducts, allProducts, recentlyAssignedIds]);

  useEffect(() => {
    setSelectedProduct(null);
    setQuery('');
  }, [activeSnap?.id, activeSnap?.shiftId]);

  const suggestions = useMemo(() => {
    const q = normalizeVi(query);
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const rankList = (list: ShiftProductItem[]) =>
      list
        .map(p => {
          const aliasNorm = normalizeVi(p.aliases);
          const skuNorm = normalizeVi(p.sku);
          const nameNorm = normalizeVi(p.name);
          const combined = `${aliasNorm} ${skuNorm} ${nameNorm}`;
          if (!tokens.every(t => combined.includes(t))) return { p, score: 0 };
          let score = 10;
          if (aliasNorm === q) score += 100;
          else if (aliasNorm.includes(q)) score += 60;
          if (skuNorm === q) score += 90;
          else if (skuNorm.includes(q)) score += 50;
          if (nameNorm.includes(q)) score += 30;
          return { p, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(x => x.p);

    if (shiftPinnedProducts.length > 0) {
      const inShift = rankList(shiftPinnedProducts);
      if (inShift.length > 0) return inShift;
    }
    return rankList(allProducts);
  }, [query, shiftPinnedProducts, allProducts]);

  const parsedQty = parseFloat(qtyStr);
  const validQty = Number.isFinite(parsedQty) && parsedQty > 0 ? Math.round(parsedQty * 100) / 100 : 0;

  const handleSelectProduct = (prod: ShiftProductItem) => {
    Keyboard.dismiss();
    setSelectedProduct(prod);
    setQuery('');
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 120);
  };

  const handleAssign = (direction: 'in' | 'out') => {
    if (!activeSnap || !selectedProduct || validQty <= 0) return;
    Keyboard.dismiss();
    const assignedId = selectedProduct.id;
    onAssignSnap(activeSnap, {
      product: selectedProduct,
      direction,
      quantity: validQty,
      unit: selectedUnit,
      note: note.trim() || undefined,
    });
    setRecentlyAssignedIds(prev => [assignedId, ...prev.filter(id => id !== assignedId)]);
    setSelectedProduct(null);
    setQtyStr('');
    setNote('');
    setQuery('');
  };

  const scrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', e => {
      setKeyboardHeight(e.endCoordinates?.height || 260);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.headerTitle}>Ảnh Chụp Nhanh Chờ Gán</Text>
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{snaps.length}</Text>
                </View>
              </View>
              <Text style={styles.headerSub}>
                Chụp trước lúc bận — gán SP &amp; số lượng khi giãn nhịp
              </Text>
            </View>

            <TouchableOpacity onPress={onCaptureMore} style={styles.captureMoreBtn}>
              <Ionicons name="camera" size={14} color={isDark ? '#38bdf8' : '#0369a1'} />
              <Text style={styles.captureMoreText}>Chụp thêm</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={18} color={isDark ? '#cbd5e1' : '#475569'} />
            </TouchableOpacity>
          </View>

          {snaps.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>Không còn ảnh nào trong hàng chờ.</Text>
              <TouchableOpacity onPress={onCaptureMore} style={styles.emptyCaptureBtn}>
                <Ionicons name="camera" size={16} color="#fff" />
                <Text style={styles.emptyCaptureText}>Chụp Nhanh Ngay</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
            <ScrollView
              ref={scrollRef}
              style={styles.body}
              keyboardShouldPersistTaps="handled"
            >
              {/* Khi đang gõ tìm kiếm, ẩn tạm thumbnail & ảnh lớn để danh sách gợi ý hiển thị rộng rãi, thoáng đẹp */}
              {query.trim().length === 0 && (
                <>
                  {/* Dải thumbnail các ảnh chờ */}
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8, paddingBottom: 6 }}
                  >
                    {snaps.map(s => {
                      const isSel = activeSnap?.id === s.id;
                      const t = new Date(s.capturedAt).toLocaleTimeString('vi-VN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                      });
                      return (
                        <TouchableOpacity
                          key={s.id}
                          onPress={() => setSelectedId(s.id)}
                          style={[styles.thumbCard, isSel && styles.thumbCardActive]}
                        >
                          <Image source={{ uri: s.image.uri }} style={styles.thumbImg} />
                          <Text style={styles.thumbTime} numberOfLines={1}>
                            {t}
                          </Text>
                          <Text
                            style={{
                              color: isDark ? '#a5b4fc' : '#4f46e5',
                              fontSize: 9,
                              fontWeight: '800',
                              textAlign: 'center',
                              paddingHorizontal: 3,
                              paddingBottom: 2,
                            }}
                            numberOfLines={1}
                          >
                            {s.jobName || 'Công việc'}
                          </Text>
                          <TouchableOpacity
                            onPress={() => onDeleteSnap(s.id)}
                            style={styles.thumbDelete}
                          >
                            <Ionicons name="close" size={12} color="#fda4af" />
                          </TouchableOpacity>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>

                  {/* Công việc của ảnh đang chọn + Cho phép đổi CV + Lưu thẳng Album */}
                  {activeSnap && (
                    <View style={{ marginTop: 6, gap: 6 }}>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 7,
                          borderRadius: 10,
                          backgroundColor: isDark ? '#1e293b' : '#eef2ff',
                          borderWidth: 1,
                          borderColor: isDark ? 'rgba(99,102,241,0.45)' : '#c7d2fe',
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '700' }}>
                            THUỘC CÔNG VIỆC:
                          </Text>
                          <Text style={{ color: isDark ? '#e0e7ff' : '#312e81', fontSize: 12, fontWeight: '800' }} numberOfLines={1}>
                            {activeSnap.jobName || 'Công việc'}
                          </Text>
                        </View>
                        <TouchableOpacity
                          onPress={() => onSaveToShiftAlbum(activeSnap)}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 4,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 8,
                            backgroundColor: isDark ? 'rgba(56,189,248,0.16)' : '#e0f2fe',
                            borderWidth: 1,
                            borderColor: isDark ? 'rgba(56,189,248,0.45)' : '#7dd3fc',
                          }}
                        >
                          <Ionicons name="albums-outline" size={13} color={isDark ? '#38bdf8' : '#0369a1'} />
                          <Text style={{ color: isDark ? '#7dd3fc' : '#0369a1', fontSize: 11, fontWeight: '800' }}>
                            Lưu thẳng Album
                          </Text>
                        </TouchableOpacity>
                      </View>

                      {openShifts.length > 1 && (
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={{ gap: 6, alignItems: 'center' }}
                        >
                          <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '700' }}>
                            Đổi CV:
                          </Text>
                          {openShifts.map(sh => {
                            const isCur = sh.id === activeSnap.shiftId;
                            const shName = sh.summary_data?.job_name || sh.notes || 'Công việc';
                            return (
                              <TouchableOpacity
                                key={sh.id}
                                onPress={() => onChangeSnapShift(activeSnap.id, sh)}
                                style={[
                                  styles.recentChip,
                                  isCur && styles.recentChipActive,
                                  { paddingVertical: 4, paddingHorizontal: 8 },
                                ]}
                              >
                                <Text style={[styles.recentChipText, isCur && { color: '#fff' }]}>
                                  {shName}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </ScrollView>
                      )}
                    </View>
                  )}

                  {/* Preview ảnh đang chọn */}
                  {activeSnap && (
                    <View
                      style={[
                        styles.previewWrap,
                        keyboardHeight > 0
                          ? { height: 84 }
                          : selectedProduct
                            ? { height: 112 }
                            : null,
                      ]}
                    >
                      <Image
                        source={{ uri: activeSnap.image.uri }}
                        style={[
                          styles.previewImg,
                          keyboardHeight > 0
                            ? { height: 84 }
                            : selectedProduct
                              ? { height: 112 }
                              : null,
                        ]}
                        resizeMode="contain"
                      />
                    </View>
                  )}

                  {/* Chọn nhanh SP theo Công việc của ảnh */}
                  {quickPickProducts.length > 0 && (
                    <View style={{ marginTop: 10 }}>
                      <Text style={styles.sectionLabel}>
                        {shiftPinnedProducts.length > 0
                          ? `Sản phẩm của công việc (${shiftPinnedProducts.length}):`
                          : 'Chọn nhanh sản phẩm vừa làm:'}
                      </Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: 6, paddingTop: 4 }}
                      >
                        {quickPickProducts.map(rp => {
                          const active = selectedProduct?.id === rp.id;
                          return (
                            <TouchableOpacity
                              key={rp.id}
                              onPress={() => handleSelectProduct(rp)}
                              style={[styles.recentChip, active && styles.recentChipActive]}
                            >
                              <Text style={[styles.recentChipText, active && { color: '#fff' }]}>
                                {rp.aliases ? `${rp.aliases} • ` : ''}
                                {rp.name}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    </View>
                  )}
                </>
              )}

              {/* Ô tìm kiếm ở trên + Danh sách gợi ý ngay bên dưới khi đang gõ */}
              <View style={[styles.searchWrap, query.trim().length > 0 ? { marginTop: 2 } : null]}>
                <Ionicons name="search" size={16} color="#94a3b8" />
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Gõ tên viết tắt (alias), SKU, tên SP..."
                  placeholderTextColor="#64748b"
                />
                {query.length > 0 && (
                  <TouchableOpacity onPress={() => setQuery('')}>
                    <Ionicons name="close-circle" size={16} color="#64748b" />
                  </TouchableOpacity>
                )}
              </View>

              {suggestions.length > 0 && (
                <View style={styles.suggestionsBox}>
                  {suggestions.map(p => (
                    <TouchableOpacity
                      key={p.id}
                      onPress={() => handleSelectProduct(p)}
                      style={styles.suggestionRow}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.suggestionName}>
                          {p.name}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 6, marginTop: 2 }}>
                          {p.aliases ? (
                            <Text style={styles.suggestionAlias}>{p.aliases}</Text>
                          ) : null}
                          {p.sku ? (
                            <Text style={styles.suggestionSku}>{p.sku}</Text>
                          ) : null}
                        </View>
                      </View>
                      <Text style={styles.chooseTxt}>Chọn</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Form gán SL & Nhập/Xuất */}
              {selectedProduct && (
                <View style={styles.assignCard}>
                  <Text style={styles.assignProdName}>{selectedProduct.name}</Text>

                  {unitOptions.length > 0 && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ gap: 6, alignItems: 'center', marginTop: 8 }}
                    >
                      <Text style={styles.sectionLabel}>ĐVT:</Text>
                      {unitOptions.map(u => {
                        const active = selectedUnit === u;
                        return (
                          <TouchableOpacity
                            key={u}
                            onPress={() => setSelectedUnit(u)}
                            style={[styles.unitChip, active && styles.unitChipActive]}
                          >
                            <Text style={[styles.unitChipText, active && { color: '#fff' }]}>
                              {u}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  )}

                  <View style={styles.qtyRow}>
                    <TextInput
                      style={styles.qtyInput}
                      value={qtyStr}
                      onChangeText={setQtyStr}
                      keyboardType="decimal-pad"
                      placeholder="Nhập số lượng..."
                      placeholderTextColor="#64748b"
                    />
                    {[1, 5, 10, 20].map(d => (
                      <TouchableOpacity
                        key={d}
                        onPress={() => {
                          const c = parseFloat(qtyStr || '0') || 0;
                          setQtyStr(String(Math.round((c + d) * 100) / 100));
                        }}
                        style={styles.quickAddBtn}
                      >
                        <Text style={styles.quickAddText}>+{d}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <TextInput
                    style={styles.noteInput}
                    value={note}
                    onChangeText={setNote}
                    placeholder="Ghi chú (tùy chọn)..."
                    placeholderTextColor="#64748b"
                  />

                </View>
              )}
              <View style={{ height: 12 }} />
            </ScrollView>

            {/* Ghim cố định 2 nút NHẬP / XUẤT ở đáy modal để không phải cuộn */}
            {selectedProduct && (
              <View style={styles.pinnedFooter}>
                <TouchableOpacity
                  disabled={validQty <= 0}
                  onPress={() => handleAssign('in')}
                  style={[
                    styles.actionBtn,
                    validQty <= 0 ? styles.actionBtnDisabled : styles.actionBtnIn,
                  ]}
                >
                  <Ionicons name="arrow-down-circle" size={17} color="#fff" />
                  <Text style={styles.actionBtnText}>NHẬP KHO (+)</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  disabled={validQty <= 0}
                  onPress={() => handleAssign('out')}
                  style={[
                    styles.actionBtn,
                    validQty <= 0 ? styles.actionBtnDisabled : styles.actionBtnOut,
                  ]}
                >
                  <Ionicons name="arrow-up-circle" size={17} color="#fff" />
                  <Text style={styles.actionBtnText}>XUẤT KHO (-)</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (c: AppThemeColors, isDark: boolean) => StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(15,23,42,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
    maxHeight: '92%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: isDark ? '#1e293b' : '#f8fafc',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomWidth: 1,
    borderBottomColor: isDark ? '#334155' : '#e2e8f0',
    gap: 8,
  },
  headerTitle: {
    color: c.text,
    fontSize: 14,
    fontWeight: '800',
  },
  headerSub: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  countBadge: {
    backgroundColor: c.amberSoftBg,
    borderWidth: 1,
    borderColor: c.amberSoftBorder,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  countBadgeText: {
    color: c.amberSoftText,
    fontSize: 11,
    fontWeight: '900',
  },
  captureMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: isDark ? 'rgba(56,189,248,0.16)' : '#e0f2fe',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(56,189,248,0.4)' : '#7dd3fc',
  },
  captureMoreText: {
    color: isDark ? '#7dd3fc' : '#0369a1',
    fontSize: 11,
    fontWeight: '800',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: isDark ? '#334155' : '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyBox: {
    padding: 32,
    alignItems: 'center',
    gap: 12,
  },
  emptyText: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyCaptureBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#0284c7',
  },
  emptyCaptureText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
  body: {
    padding: 12,
  },
  thumbCard: {
    width: 78,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: isDark ? '#334155' : '#cbd5e1',
    backgroundColor: c.surface,
  },
  thumbCardActive: {
    borderColor: '#f59e0b',
  },
  thumbImg: {
    width: 78,
    height: 60,
  },
  thumbTime: {
    color: c.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
    paddingVertical: 2,
  },
  thumbDelete: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewWrap: {
    marginTop: 8,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: isDark ? '#000' : '#f1f5f9',
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImg: {
    width: '100%',
    height: 160,
  },
  sectionLabel: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  recentChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: isDark ? '#1e293b' : '#f8fafc',
    borderWidth: 1,
    borderColor: c.border,
  },
  recentChipActive: {
    backgroundColor: '#4f46e5',
    borderColor: '#4f46e5',
  },
  recentChipText: {
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  searchWrap: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
  },
  searchInput: {
    flex: 1,
    color: c.text,
    fontSize: 12,
    padding: 0,
  },
  suggestionsBox: {
    marginTop: 4,
    borderRadius: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(99,102,241,0.45)' : '#c7d2fe',
    overflow: 'hidden',
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
    gap: 8,
  },
  suggestionName: {
    color: c.text,
    fontSize: 12,
    fontWeight: '700',
  },
  suggestionAlias: {
    color: c.amberSoftText,
    backgroundColor: c.amberSoftBg,
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  suggestionSku: {
    color: isDark ? '#818cf8' : '#4f46e5',
    fontSize: 10,
    fontWeight: '700',
  },
  chooseTxt: {
    color: isDark ? '#94a3b8' : '#4f46e5',
    fontSize: 11,
    fontWeight: '800',
  },
  assignCard: {
    marginTop: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: isDark ? '#1e293b' : '#f8fafc',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(99,102,241,0.45)' : '#c7d2fe',
  },
  assignProdName: {
    color: c.text,
    fontSize: 13,
    fontWeight: '800',
  },
  unitChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  unitChipActive: {
    backgroundColor: '#4f46e5',
    borderColor: '#4f46e5',
  },
  unitChipText: {
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  qtyRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  qtyInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    color: c.text,
    fontSize: 14,
    fontWeight: '900',
  },
  quickAddBtn: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: isDark ? '#0f172a' : '#eef2ff',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#c7d2fe',
  },
  quickAddText: {
    color: isDark ? '#a5b4fc' : '#4338ca',
    fontSize: 12,
    fontWeight: '800',
  },
  noteInput: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    color: c.text,
    fontSize: 12,
  },
  actionRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
  },
  pinnedFooter: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionBtnDisabled: {
    backgroundColor: isDark ? '#334155' : '#cbd5e1',
    opacity: isDark ? 0.6 : 0.85,
  },
  actionBtnIn: {
    backgroundColor: '#059669',
  },
  actionBtnOut: {
    backgroundColor: '#e11d48',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
});
