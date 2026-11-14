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
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [productImages, setProductImages] = useState<OperationImageRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'history' | 'images'>('history');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'in' | 'out'>('all');
  const [previewImage, setPreviewImage] = useState<OperationImageRecord | null>(null);

  useEffect(() => {
    if (visible && product && shiftId) {
      setActiveTab('history');
      setDirectionFilter('all');
      setPreviewImage(null);
      loadHistory();
    }
  }, [visible, product, shiftId]);

  const loadHistory = async () => {
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
  };

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
                  <Ionicons name="close" size={20} color="#94a3b8" />
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
                    return (
                      <View style={styles.recordItem}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={[styles.typeBadge, isImport ? styles.typeIn : styles.typeOut]}>
                            <Ionicons name={isImport ? 'arrow-down' : 'arrow-up'} size={12} color="#fff" />
                          </View>
                          <View>
                            <Text style={styles.recordTime}>
                              Đợt #{filteredRecords.length - index} • {timeStr}
                            </Text>
                            <Text style={styles.recordUser}>Bởi: {item.sent_by_name || 'Nhân viên'}</Text>
                          </View>
                        </View>
                        <Text style={[styles.recordQty, isImport ? { color: '#22c55e' } : { color: '#f43f5e' }]}>
                          {isImport ? '+' : '-'}{item.quantity_sent} {item.unit}
                        </Text>
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

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  handle: {
    width: 44,
    height: 5,
    backgroundColor: '#475569',
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
    borderBottomColor: '#334155',
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
  },
  statsBanner: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
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
    color: '#64748b',
    fontWeight: '600',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#f8fafc',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#334155',
  },
  recordItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
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
    color: '#f8fafc',
  },
  recordUser: {
    fontSize: 10,
    color: '#64748b',
  },
  recordQty: {
    fontSize: 14,
    fontWeight: '800',
  },
  doneBtn: {
    height: 42,
    backgroundColor: '#334155',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  doneBtnText: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
  },
  tabRow: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#0f172a',
    padding: 4,
    borderRadius: 10,
    marginBottom: 8,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 7,
    borderRadius: 8,
  },
  tabBtnActive: {
    backgroundColor: '#1e293b',
  },
  tabText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
  },
  tabTextActive: {
    color: '#38bdf8',
  },
  filterRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  filterBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  filterAllActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  filterInActive: {
    backgroundColor: '#059669',
    borderColor: '#34d399',
  },
  filterOutActive: {
    backgroundColor: '#e11d48',
    borderColor: '#fb7185',
  },
  filterText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
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
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
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

