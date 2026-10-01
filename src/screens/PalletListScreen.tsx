import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Alert, ActivityIndicator, Modal, ScrollView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Pallet, BoxLabel } from '../types';
import { getAllPallets, getBoxesByPallet, deletePallet } from '../services/database';
import { syncPalletToSupabase, testConnection } from '../services/supabase';

export default function PalletListScreen({ onBackToScanner }: { onBackToScanner: () => void }) {
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [isSyncingAll, setIsSyncingAll] = useState(false);

  // Connection status
  const [connectionStatus, setConnectionStatus] = useState<string>('Đang kiểm tra...');
  const [isOnline, setIsOnline] = useState<boolean>(false);

  // Detail Modal
  const [selectedPallet, setSelectedPallet] = useState<Pallet | null>(null);
  const [selectedBoxes, setSelectedBoxes] = useState<BoxLabel[]>([]);
  const [isLoadingBoxes, setIsLoadingBoxes] = useState(false);

  useEffect(() => {
    loadPallets();
    checkNetwork();
  }, []);

  async function checkNetwork() {
    const res = await testConnection();
    setIsOnline(res.success);
    setConnectionStatus(res.success ? '🟢 api.chanhthu.click (Đã kết nối)' : '🔴 Mất kết nối máy chủ');
  }

  async function loadPallets() {
    setLoading(true);
    try {
      const data = await getAllPallets();
      setPallets(data);
    } catch (e: any) {
      Alert.alert('Lỗi', e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSyncSingle(pallet: Pallet) {
    setSyncingId(pallet.id);
    try {
      const boxes = await getBoxesByPallet(pallet.id);
      if (boxes.length === 0) {
        Alert.alert('Cảnh báo', 'Pallet này chưa có thùng nào để đồng bộ');
        return;
      }
      const res = await syncPalletToSupabase(pallet, boxes);
      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Thành công', res.message);
        loadPallets();
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Lỗi đồng bộ', res.message);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setSyncingId(null);
    }
  }

  async function handleSyncAll() {
    const pending = pallets.filter(p => p.sync_status !== 'synced');
    if (pending.length === 0) {
      Alert.alert('Thông báo', 'Tất cả Pallet đều đã được đồng bộ!');
      return;
    }

    setIsSyncingAll(true);
    let successCount = 0;
    for (const p of pending) {
      const boxes = await getBoxesByPallet(p.id);
      const res = await syncPalletToSupabase(p, boxes);
      if (res.success) successCount++;
    }
    setIsSyncingAll(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Đồng bộ xong', `Đã đồng bộ thành công ${successCount} / ${pending.length} Pallet lên Anywarehouse!`);
    loadPallets();
  }

  async function handleOpenDetail(pallet: Pallet) {
    setSelectedPallet(pallet);
    setIsLoadingBoxes(true);
    try {
      const boxList = await getBoxesByPallet(pallet.id);
      setSelectedBoxes(boxList);
    } finally {
      setIsLoadingBoxes(false);
    }
  }

  async function handleDelete(pallet: Pallet) {
    Alert.alert(
      'Xóa Pallet',
      `Bạn có chắc muốn xóa Pallet ${pallet.code} cùng toàn bộ ${pallet.scanned_qty} thùng bên trong?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa vĩnh viễn',
          style: 'destructive',
          onPress: async () => {
            await deletePallet(pallet.id);
            loadPallets();
          }
        }
      ]
    );
  }

  const pendingCount = pallets.filter(p => p.sync_status !== 'synced').length;

  return (
    <View style={styles.container}>
      {/* ── TOP BAR ───────────────────────────────── */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={onBackToScanner}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
          <Text style={styles.backBtnText}>Quét Thùng</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>DANH SÁCH PALLET</Text>
        <TouchableOpacity onPress={loadPallets}>
          <Ionicons name="refresh" size={20} color="#38bdf8" />
        </TouchableOpacity>
      </View>

      {/* ── CONNECTION BANNER ─────────────────────── */}
      <View style={styles.connectionBanner}>
        <Text style={styles.connectionText}>{connectionStatus}</Text>
        <TouchableOpacity onPress={checkNetwork}>
          <Text style={styles.pingBtnText}>Kiểm tra</Text>
        </TouchableOpacity>
      </View>

      {/* ── SYNC ALL CTA ──────────────────────────── */}
      {pendingCount > 0 && (
        <View style={styles.syncAllCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.syncAllTitle}>Có {pendingCount} Pallet chờ đồng bộ</Text>
            <Text style={styles.syncAllSub}>Dữ liệu đang lưu an toàn trong máy</Text>
          </View>
          <TouchableOpacity
            style={styles.syncAllBtn}
            disabled={isSyncingAll}
            onPress={handleSyncAll}
          >
            {isSyncingAll ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name="cloud-upload" size={18} color="#fff" />
                <Text style={styles.syncAllBtnText}>ĐỒNG BỘ TẤT CẢ</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* ── PALLET LIST ───────────────────────────── */}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#38bdf8" />
      ) : (
        <FlatList
          data={pallets}
          keyExtractor={item => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => {
            const isSynced = item.sync_status === 'synced';
            const isSyncing = syncingId === item.id;

            return (
              <TouchableOpacity
                style={styles.palletCard}
                onPress={() => handleOpenDetail(item)}
              >
                <View style={styles.palletCardHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="cube" size={20} color="#fbbf24" style={{ marginRight: 8 }} />
                    <Text style={styles.palletCode}>{item.code}</Text>
                  </View>
                  <View style={[
                    styles.syncBadge,
                    { backgroundColor: isSynced ? '#064e3b' : '#7c2d12' }
                  ]}>
                    <Text style={[
                      styles.syncBadgeText,
                      { color: isSynced ? '#34d399' : '#fdba74' }
                    ]}>
                      {isSynced ? '✓ Đã đồng bộ' : '⏳ Chờ đồng bộ'}
                    </Text>
                  </View>
                </View>

                <View style={styles.palletCardBody}>
                  <Text style={styles.palletMeta}>
                    Số lượng: <Text style={{ color: '#22c55e', fontWeight: '900' }}>{item.scanned_qty}</Text> / {item.target_qty} thùng
                  </Text>
                  <Text style={styles.palletMeta}>
                    Tổng khối lượng: <Text style={{ color: '#38bdf8', fontWeight: '900' }}>{item.total_weight}</Text> Kg
                  </Text>
                  <Text style={styles.palletDate}>
                    Ngày tạo: {item.created_at.slice(0, 16).replace('T', ' ')}
                  </Text>
                </View>

                <View style={styles.palletCardFooter}>
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => handleDelete(item)}
                  >
                    <Ionicons name="trash-outline" size={16} color="#ef4444" />
                    <Text style={styles.deleteBtnText}>Xóa</Text>
                  </TouchableOpacity>

                  {!isSynced && (
                    <TouchableOpacity
                      style={styles.syncSingleBtn}
                      disabled={isSyncing}
                      onPress={() => handleSyncSingle(item)}
                    >
                      {isSyncing ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <>
                          <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
                          <Text style={styles.syncSingleText}>Tải lên web</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* ── MODAL CHI TIẾT PALLET ─────────────────── */}
      <Modal visible={!!selectedPallet} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Chi tiết Pallet: {selectedPallet?.code}</Text>
              <TouchableOpacity onPress={() => setSelectedPallet(null)}>
                <Ionicons name="close" size={24} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSub}>
              Tổng cộng {selectedBoxes.length} thùng · {selectedPallet?.total_weight} Kg
            </Text>

            {isLoadingBoxes ? (
              <ActivityIndicator style={{ marginVertical: 30 }} color="#38bdf8" />
            ) : (
              <ScrollView style={{ maxHeight: 400, marginTop: 10 }}>
                {selectedBoxes.map((b, idx) => (
                  <View key={b.id} style={styles.boxRow}>
                    <Text style={styles.boxRowIdx}>#{b.box_index}</Text>
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.boxRowTitle} numberOfLines={1}>{b.product_name}</Text>
                      <Text style={styles.boxRowMeta}>
                        Lô: {b.lot_code} | {b.weight} Kg | NSX: {b.production_date} | Tổ: {b.shift_group}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}

            <TouchableOpacity
              style={styles.closeDetailBtn}
              onPress={() => setSelectedPallet(null)}
            >
              <Text style={styles.closeDetailText}>Đóng</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  topBarTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '900',
  },
  connectionBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  connectionText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
  },
  pingBtnText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  syncAllCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e3a8a',
    margin: 16,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  syncAllTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  syncAllSub: {
    color: '#93c5fd',
    fontSize: 11,
    marginTop: 2,
  },
  syncAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  syncAllBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  palletCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  palletCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  palletCode: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '900',
  },
  syncBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  syncBadgeText: {
    fontSize: 11,
    fontWeight: '800',
  },
  palletCardBody: {
    marginTop: 10,
    gap: 4,
  },
  palletMeta: {
    color: '#cbd5e1',
    fontSize: 13,
  },
  palletDate: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 4,
  },
  palletCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 6,
  },
  deleteBtnText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '700',
  },
  syncSingleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2563eb',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 6,
  },
  syncSingleText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    width: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
  },
  modalSub: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 4,
  },
  boxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
  },
  boxRowIdx: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '900',
    width: 44,
  },
  boxRowTitle: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
  },
  boxRowMeta: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  closeDetailBtn: {
    backgroundColor: '#334155',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 14,
  },
  closeDetailText: {
    color: '#fff',
    fontWeight: '700',
  },
});