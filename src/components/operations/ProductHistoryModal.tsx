import React, { useState, useEffect } from 'react';
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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShiftProductItem, JournalRecord, getShiftJournals } from '../../services/operationsService';

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

  useEffect(() => {
    if (visible && product && shiftId) {
      loadHistory();
    }
  }, [visible, product, shiftId]);

  const loadHistory = async () => {
    if (!shiftId || !product) return;
    setLoading(true);
    try {
      const all = await getShiftJournals(shiftId);
      const filtered = all.filter(r => r.item_name === product.name);
      setRecords(filtered);
    } catch (e) {
      console.warn('Lỗi lấy lịch sử SP:', e);
    } finally {
      setLoading(false);
    }
  };

  if (!product) return null;

  const totalIn = records.filter(r => r.to_department === 'Kho').reduce((acc, r) => acc + (r.quantity_sent || 0), 0);
  const totalOut = records.filter(r => r.from_department === 'Kho').reduce((acc, r) => acc + (r.quantity_sent || 0), 0);

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

              {/* Danh sách các lần ghi nhận */}
              {loading ? (
                <View style={{ padding: 40, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color="#38bdf8" />
                </View>
              ) : records.length === 0 ? (
                <View style={{ padding: 40, alignItems: 'center' }}>
                  <Text style={{ color: '#64748b', fontSize: 13 }}>Chưa có lượt ghi nhận nào trong ca này.</Text>
                </View>
              ) : (
                <FlatList
                  data={records}
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
                              Đợt #{records.length - index} • {timeStr}
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
});

