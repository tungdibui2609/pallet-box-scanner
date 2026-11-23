import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  FlatList,
  ActivityIndicator,
  Platform,
  Image,
  ScrollView,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, AppThemeColors } from '../../contexts/ThemeContext';
import { ShiftProductItem, JournalRecord, getShiftJournals } from '../../services/operationsService';
import {
  getShiftOperationImages,
  getOperationImageDisplayUrl,
  OperationImageRecord,
} from '../../services/operationImagesService';

const THUMB_SIZE = Math.floor((Dimensions.get('window').width - 56) / 3);

interface Props {
  visible: boolean;
  product: ShiftProductItem | null;
  shiftId: string | null;
  onClose: () => void;
}

export default function ProductHistoryModal({ visible, product, shiftId, onClose }: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [productImages, setProductImages] = useState<OperationImageRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'history' | 'images'>('history');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'in' | 'out'>('all');
  const [previewImage, setPreviewImage] = useState<OperationImageRecord | null>(null);

  const loadHistory = React.useCallback(async () => {
    if (!shiftId || !product) return;
    setLoading(true);
    try {
      const [all, imgs] = await Promise.all([
        getShiftJournals(shiftId),
        getShiftOperationImages(shiftId).catch(() => [] as OperationImageRecord[]),
      ]);
      const filtered = all.filter((r: JournalRecord) => r.item_name === product.name);
      setRecords(filtered);

      const pSku = (product.sku || '').trim().toLowerCase();
      const pName = (product.name || '').trim().toLowerCase();
      const matchedImgs = (imgs || []).filter((img: OperationImageRecord) => {
        const iSku = (img.item_sku || '').trim().toLowerCase();
        const iName = (img.item_name || '').trim().toLowerCase();
        if (pSku && iSku && pSku === iSku) return true;
        if (pName && iName && pName === iName) return true;
        return false;
      });
      setProductImages(matchedImgs);
    } catch (e) {
      console.warn('Lỗi lấy lịch sử SP:', e);
    } finally {
      setLoading(false);
    }
  }, [shiftId, product]);

  useEffect(() => {
    if (!visible || !product || !shiftId) return;
    const timer = setTimeout(() => {
      setActiveTab('history');
      setDirectionFilter('all');
      setPreviewImage(null);
      void loadHistory();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, product, shiftId, loadHistory]);

  const inRecords = useMemo(() => records.filter(r => r.to_department === 'Kho'), [records]);
  const outRecords = useMemo(() => records.filter(r => r.to_department !== 'Kho'), [records]);
  const filteredRecords = useMemo(() => {
    if (directionFilter === 'in') return inRecords;
    if (directionFilter === 'out') return outRecords;
    return records;
  }, [records, inRecords, outRecords, directionFilter]);

  const inImages = useMemo(() => productImages.filter(i => i.direction === 'in'), [productImages]);
  const outImages = useMemo(() => productImages.filter(i => i.direction === 'out'), [productImages]);
  const filteredImages = useMemo(() => {
    if (directionFilter === 'in') return inImages;
    if (directionFilter === 'out') return outImages;
    return productImages;
  }, [productImages, inImages, outImages, directionFilter]);

  // Ghép ảnh kèm theo cho từng dòng đợt nhập/xuất
  const getImagesForRecord = React.useCallback(
    (item: JournalRecord): OperationImageRecord[] => {
      if (!productImages.length) return [];
      const exact = productImages.filter(img => img.journal_id && img.journal_id === item.id);
      if (exact.length > 0) return exact;
      // Fallback: khớp ảnh không gắn journal_id nhưng cùng chiều + số lượng + thời gian sát nhau (±3 phút)
      const isImport = item.to_department === 'Kho';
      const dir = isImport ? 'in' : 'out';
      const recTs = item.sent_at ? new Date(item.sent_at).getTime() : 0;
      return productImages.filter(img => {
        if (img.journal_id) return false;
        if (img.direction && img.direction !== dir) return false;
        if (img.quantity != null && Number(img.quantity) !== Number(item.quantity_sent)) return false;
        if (recTs > 0 && img.captured_at) {
          const imgTs = new Date(img.captured_at).getTime();
          if (Math.abs(imgTs - recTs) > 3 * 60 * 1000) return false;
        }
        return true;
      });
    },
    [productImages]
  );

  if (!product) return null;

  const totalIn = inRecords.reduce((acc, r) => acc + (r.quantity_sent || 0), 0);
  const totalOut = outRecords.reduce((acc, r) => acc + (r.quantity_sent || 0), 0);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
              <View style={styles.handle} />

              <View style={styles.header}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title} numberOfLines={2}>{product.name}</Text>
                  <Text style={styles.subtitle}>Lịch sử các đợt phát sinh trong ca này</Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color={isDark ? '#94a3b8' : '#475569'} />
                </TouchableOpacity>
              </View>

              {/* Thống kê nhanh */}
              <View style={styles.statsBanner}>
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Đã Nhập</Text>
                  <Text style={[styles.statValue, { color: '#22c55e' }]}>+{totalIn}</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Đã Xuất</Text>
                  <Text style={[styles.statValue, { color: '#f43f5e' }]}>-{totalOut}</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statBox}>
                  <Text style={styles.statLabel}>Tổng Đợt</Text>
                  <Text style={styles.statValue}>{records.length}</Text>
                </View>
              </View>

              {/* Tab Lịch sử đợt / Hình ảnh */}
              <View style={styles.tabRow}>
                <TouchableOpacity
                  style={[styles.tabBtn, activeTab === 'history' && styles.tabBtnActive]}
                  onPress={() => setActiveTab('history')}
                >
                  <Ionicons name="time-outline" size={14} color={activeTab === 'history' ? '#38bdf8' : '#94a3b8'} />
                  <Text style={[styles.tabText, activeTab === 'history' && styles.tabTextActive]}>
                    Lịch sử đợt ({records.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tabBtn, activeTab === 'images' && styles.tabBtnActive]}
                  onPress={() => setActiveTab('images')}
                >
                  <Ionicons name="images-outline" size={14} color={activeTab === 'images' ? '#38bdf8' : '#94a3b8'} />
                  <Text style={[styles.tabText, activeTab === 'images' && styles.tabTextActive]}>
                    Hình ảnh ({productImages.length})
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Bộ lọc Tất cả / Nhập / Xuất */}
              <View style={styles.filterRow}>
                {[
                  {
                    key: 'all' as const,
                    label: `Tất cả (${activeTab === 'images' ? productImages.length : records.length})`,
                  },
                  {
                    key: 'in' as const,
                    label: `Nhập (${activeTab === 'images' ? inImages.length : inRecords.length})`,
                  },
                  {
                    key: 'out' as const,
                    label: `Xuất (${activeTab === 'images' ? outImages.length : outRecords.length})`,
                  },
                ].map((f) => {
                  const active = directionFilter === f.key;
                  return (
                    <TouchableOpacity
                      key={f.key}
                      style={[
                        styles.filterBtn,
                        active && (f.key === 'in' ? styles.filterInActive : f.key === 'out' ? styles.filterOutActive : styles.filterAllActive),
                      ]}
                      onPress={() => setDirectionFilter(f.key)}
                    >
                      <Text style={[styles.filterText, active && { color: '#ffffff' }]}>{f.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Nội dung theo Tab */}
              {loading ? (
                <View style={{ padding: 40, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color="#38bdf8" />
                </View>
              ) : activeTab === 'images' ? (
                filteredImages.length === 0 ? (
                  <View style={{ padding: 40, alignItems: 'center' }}>
                    <Ionicons name="images-outline" size={34} color="#475569" />
                    <Text style={{ color: '#64748b', fontSize: 13, marginTop: 8 }}>
                      Chưa có hình ảnh {directionFilter === 'in' ? 'nhập' : directionFilter === 'out' ? 'xuất' : ''} nào cho sản phẩm này.
                    </Text>
                  </View>
                ) : (
                  <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={styles.gridWrap}>
                    {filteredImages.map((img) => {
                      const timeStr = img.captured_at
                        ? new Date(img.captured_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
                        : '';
                      return (
                        <TouchableOpacity
                          key={img.id}
                          style={styles.gridItem}
                          onPress={() => setPreviewImage(img)}
                          activeOpacity={0.85}
                        >
                          <Image source={{ uri: getOperationImageDisplayUrl(img) }} style={styles.gridImage} />
                          <View style={styles.gridFooter}>
                            {img.direction === 'in' && (
                              <View style={[styles.dirPill, { backgroundColor: '#10b981' }]}>
                                <Text style={styles.dirPillText}>NHẬP</Text>
                              </View>
                            )}
                            {img.direction === 'out' && (
                              <View style={[styles.dirPill, { backgroundColor: '#f43f5e' }]}>
                                <Text style={styles.dirPillText}>XUẤT</Text>
                              </View>
                            )}
                            <Text style={styles.gridTime} numberOfLines={1}>
                              {img.quantity != null ? `${img.quantity}${img.unit || ''} • ` : ''}
                              {timeStr}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )
              ) : filteredRecords.length === 0 ? (
                <View style={{ padding: 40, alignItems: 'center' }}>
                  <Text style={{ color: '#64748b', fontSize: 13 }}>
                    Chưa có lượt {directionFilter === 'in' ? 'nhập' : directionFilter === 'out' ? 'xuất' : 'ghi nhận'} nào trong ca này.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={filteredRecords}
                  keyExtractor={item => item.id}
                  style={{ maxHeight: 320 }}
                  showsVerticalScrollIndicator={false}
                  renderItem={({ item, index }) => {
                    const isImport = item.to_department === 'Kho';
                    const timeStr = item.sent_at ? new Date(item.sent_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
                    const rowImages = getImagesForRecord(item);
                    return (
                      <View style={styles.recordItem}>
                        <View style={styles.recordTopRow}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                            <View style={[styles.typeBadge, isImport ? styles.typeIn : styles.typeOut]}>
                              <Ionicons name={isImport ? 'arrow-down' : 'arrow-up'} size={12} color="#fff" />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.recordTime}>
                                Đợt #{filteredRecords.length - index} • {timeStr}
                              </Text>
                              <Text style={styles.recordUser}>Bởi: {item.sent_by_name || 'Nhân viên'}</Text>
                            </View>
                          </View>
                          <Text style={[styles.recordQty, isImport ? { color: colors.success } : { color: colors.danger }]}>
                            {isImport ? '+' : '-'}{item.quantity_sent} {item.unit}
                          </Text>
                        </View>

                        {rowImages.length > 0 && (
                          <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            contentContainerStyle={styles.recordThumbRow}
                          >
                            {rowImages.map(img => (
                              <TouchableOpacity
                                key={img.id}
                                activeOpacity={0.85}
                                onPress={() => setPreviewImage(img)}
                                style={styles.recordThumbWrap}
                              >
                                <Image
                                  source={{ uri: getOperationImageDisplayUrl(img) }}
                                  style={styles.recordThumbImg}
                                />
                              </TouchableOpacity>
                            ))}
                          </ScrollView>
                        )}
                      </View>
                    );
                  }}
                />
              )}

              <TouchableOpacity onPress={onClose} style={styles.doneBtn}>
                <Text style={styles.doneBtnText}>Đóng</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>

      {/* Lightbox xem phóng to ảnh */}
      <Modal visible={!!previewImage} transparent animationType="fade" onRequestClose={() => setPreviewImage(null)}>
        <View style={styles.lightboxOverlay}>
          <TouchableOpacity style={styles.lightboxClose} onPress={() => setPreviewImage(null)}>
            <Ionicons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
          {previewImage && (
            <>
              <Image
                source={{ uri: getOperationImageDisplayUrl(previewImage) }}
                style={styles.lightboxImage}
                resizeMode="contain"
              />
              <Text style={styles.lightboxCaption}>
                {previewImage.direction === 'in' ? 'NHẬP' : previewImage.direction === 'out' ? 'XUẤT' : ''}
                {previewImage.quantity != null ? ` • ${previewImage.quantity} ${previewImage.unit || ''}` : ''}
                {` • ${new Date(previewImage.captured_at).toLocaleString('vi-VN')}`}
              </Text>
            </>
          )}
        </View>
      </Modal>
    </Modal>
  );
}

const createStyles = (c: AppThemeColors, isDark: boolean) => StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(0,0,0,0.65)' : 'rgba(15,23,42,0.5)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
  },
  handle: {
    width: 44,
    height: 5,
    backgroundColor: isDark ? '#475569' : '#cbd5e1',
    borderRadius: 3,
    alignSelf: 'center',
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: isDark ? '#334155' : '#e2e8f0',
  },
  title: {
    fontSize: 15,
    fontWeight: '800',
    color: c.text,
  },
  subtitle: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 999,
    backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
  },
  statsBanner: {
    flexDirection: 'row',
    backgroundColor: isDark ? '#0f172a' : '#f8fafc',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
    marginVertical: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 10,
    color: c.textMuted,
    fontWeight: '700',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '800',
    color: c.text,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: isDark ? '#334155' : '#e2e8f0',
  },
  recordItem: {
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: isDark ? '#334155' : '#f1f5f9',
    gap: 8,
  },
  recordTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  recordThumbRow: {
    paddingLeft: 30,
    gap: 8,
  },
  recordThumbWrap: {
    width: 54,
    height: 54,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: isDark ? '#475569' : '#cbd5e1',
    backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
  },
  recordThumbImg: {
    width: '100%',
    height: '100%',
  },
  typeBadge: {
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeIn: {
    backgroundColor: '#16a34a',
  },
  typeOut: {
    backgroundColor: '#e11d48',
  },
  recordTime: {
    fontSize: 12,
    fontWeight: '700',
    color: c.text,
  },
  recordUser: {
    fontSize: 10,
    color: c.textMuted,
  },
  recordQty: {
    fontSize: 14,
    fontWeight: '800',
  },
  doneBtn: {
    height: 42,
    backgroundColor: isDark ? '#334155' : '#f1f5f9',
    borderWidth: 1,
    borderColor: isDark ? '#475569' : '#cbd5e1',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  doneBtnText: {
    color: isDark ? '#cbd5e1' : '#334155',
    fontSize: 13,
    fontWeight: '700',
  },
  tabRow: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
    padding: 4,
    borderRadius: 12,
    marginBottom: 8,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 7,
    borderRadius: 9,
  },
  tabBtnActive: {
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    elevation: isDark ? 0 : 1,
  },
  tabText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
  },
  tabTextActive: {
    color: isDark ? '#38bdf8' : '#0284c7',
  },
  filterRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  filterBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 9,
    backgroundColor: isDark ? '#0f172a' : '#f8fafc',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#cbd5e1',
  },
  filterAllActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  filterInActive: {
    backgroundColor: '#059669',
    borderColor: '#059669',
  },
  filterOutActive: {
    backgroundColor: '#e11d48',
    borderColor: '#e11d48',
  },
  filterText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textSecondary,
  },
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 8,
  },
  gridItem: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#cbd5e1',
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  gridFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 4,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  dirPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    marginBottom: 2,
  },
  dirPillText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '800',
  },
  gridTime: {
    color: '#e2e8f0',
    fontSize: 9,
    fontWeight: '600',
  },
  lightboxOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.94)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  lightboxClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxImage: {
    width: '100%',
    height: '78%',
  },
  lightboxCaption: {
    color: '#cbd5e1',
    fontSize: 12,
    marginTop: 12,
    textAlign: 'center',
  },
});

