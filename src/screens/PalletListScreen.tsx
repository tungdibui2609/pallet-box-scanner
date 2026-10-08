import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Alert, ActivityIndicator, Modal, ScrollView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Pallet, BoxLabel } from '../types';
import { getAllPallets, getBoxesByPallet, deletePallet, deleteBox, cloneBoxToPallet } from '../services/database';
import { syncPalletToSupabase, testConnection, pullPalletFromSupabase, unlinkBoxOnSupabase } from '../services/supabase';

export default function PalletListScreen({ onBackToScanner }: { onBackToScanner: () => void }) {
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);
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


  async function handlePullFromSupabase(pallet: Pallet) {
    setPullingId(pallet.id);
    try {
      const res = await pullPalletFromSupabase(pallet.id, pallet.code);
      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Đồng bộ từ web thành công', res.message);
        await loadPallets();
        if (selectedPallet?.id === pallet.id) {
          const updatedBoxes = await getBoxesByPallet(pallet.id);
          setSelectedBoxes(updatedBoxes);
          const updatedPallets = await getAllPallets();
          const cur = updatedPallets.find(p => p.id === pallet.id);
          if (cur) setSelectedPallet(cur);
        }
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert('Không thể đồng bộ', res.message);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
    } finally {
      setPullingId(null);
    }
  }

  async function handleDeleteBox(box: BoxLabel) {
    if (!selectedPallet) return;
    Alert.alert(
      'Xóa thùng này',
      `Bạn có chắc muốn xóa Thùng #${box.box_index} (Lô ${box.lot_code}) khỏi Pallet ${selectedPallet.code}?\n\nThao tác này sẽ cập nhật lại số lượng và tổng kg của Pallet.`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa ngay',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteBox(box.id, selectedPallet.id);
              // Nếu đang có mạng và tem đã từng sync, gỡ liên kết trên Supabase
              const cleanSku = (box.sku || 'SKU').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
              const cleanLot = (box.lot_code || 'LOT').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
              const idxStr = String(box.box_index || '0').padStart(3, '0');
              const boxCode = `BOX-${cleanLot}-${cleanSku}-${idxStr}`;
              unlinkBoxOnSupabase(boxCode).catch(() => {});

              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              // Refresh boxes & pallet
              const updatedBoxes = await getBoxesByPallet(selectedPallet.id);
              setSelectedBoxes(updatedBoxes);
              await loadPallets();
              const updatedPallets = await getAllPallets();
              const cur = updatedPallets.find(p => p.id === selectedPallet.id);
              if (cur) setSelectedPallet(cur);
            } catch (err: any) {
              Alert.alert('Lỗi khi xóa', err.message);
            }
          }
        }
      ]
    );
  }

  async function handleCloneBox(box: BoxLabel) {
    if (!selectedPallet) return;
    const remaining = Math.max(1, selectedPallet.target_qty - selectedBoxes.length);
    Alert.alert(
      'Nhân bản thùng hàng',
      `Sao chép thùng #${box.box_index} (${box.sku}) sang ${remaining} thùng tiếp theo trên Pallet ${selectedPallet.code}?\n\n(Hệ thống sẽ cấp số STT INDEX mới liên tiếp, giữ nguyên thông tin sản phẩm và ngày tháng)`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: `Nhân bản +1 thùng`,
          onPress: async () => {
            await executeClone(box, 1);
          }
        },
        {
          text: `Điền đủ +${remaining} thùng`,
          onPress: async () => {
            await executeClone(box, remaining);
          }
        }
      ]
    );
  }

  async function executeClone(box: BoxLabel, count: number) {
    if (!selectedPallet) return;
    try {
      const res = await cloneBoxToPallet(selectedPallet.id, box, count);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const updatedBoxes = await getBoxesByPallet(selectedPallet.id);
      setSelectedBoxes(updatedBoxes);
      await loadPallets();
      const updatedPallets = await getAllPallets();
      const cur = updatedPallets.find(p => p.id === selectedPallet.id);
      if (cur) setSelectedPallet(cur);
      Alert.alert('Thành công', `Đã nhân bản thêm ${res.addedCount} thùng vào Pallet ${selectedPallet.code}!`);
    } catch (e: any) {
      Alert.alert('Lỗi nhân bản', e.message);
    }
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
                    style={styles.pullBtn}
                    disabled={pullingId === item.id}
                    onPress={() => handlePullFromSupabase(item)}
                  >
                    {pullingId === item.id ? (
                      <ActivityIndicator color="#38bdf8" size="small" />
                    ) : (
                      <>
                        <Ionicons name="cloud-download-outline" size={16} color="#38bdf8" />
                        <Text style={styles.pullBtnText}>Kéo từ Web</Text>
                      </>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => handleDelete(item)}
                  >
                    <Ionicons name="trash-outline" size={16} color="#ef4444" />
                    <Text style={styles.deleteBtnText}>Xóa</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.syncSingleBtn, isSynced && styles.resyncBtn]}
                    disabled={isSyncing}
                    onPress={() => handleSyncSingle(item)}
                  >
                    {isSyncing ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <>
                        <Ionicons name={isSynced ? "refresh-outline" : "cloud-upload-outline"} size={16} color="#fff" />
                        <Text style={styles.syncSingleText}>{isSynced ? "Đẩy lại" : "Tải lên web"}</Text>
                      </>
                    )}
                  </TouchableOpacity>
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
                  <View key={b.id} style={styles.boxCardItem}>
                    {/* Header Row: Index + SKU + Weight */}
                    <View style={styles.boxCardHeader}>
                      <View style={styles.boxIndexTag}>
                        <Text style={styles.boxIndexTagText}>#{b.box_index}</Text>
                      </View>
                      <Text style={styles.boxSkuTag}>SKU: {b.sku}</Text>
                      <View style={styles.boxWeightTag}>
                        <Text style={styles.boxWeightTagText}>{b.weight} {b.unit}</Text>
                      </View>
                      <TouchableOpacity
                        style={styles.cloneBoxBtn}
                        onPress={() => handleCloneBox(b)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="copy-outline" size={16} color="#38bdf8" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.deleteBoxBtn}
                        onPress={() => handleDeleteBox(b)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="trash-outline" size={16} color="#ef4444" />
                      </TouchableOpacity>
                    </View>

                    {/* Product Name Full without truncation */}
                    <Text style={styles.boxFullTitle}>{b.product_name}</Text>

                    {/* Complete 2-Column Grid of Label Details */}
                    <View style={styles.boxMetaGrid}>
                      <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Mã Lô:</Text> {b.lot_code}</Text>
                      <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Quy cách:</Text> {b.spec || 'Thùng/túi: 20kg'}</Text>
                      <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Tổ/Nhóm:</Text> {b.shift_group || 'Nguyên'}</Text>
                      <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Vùng NL:</Text> {b.region || 'Tây Nguyên'}</Text>
                      <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Ngày SX:</Text> {b.production_date}</Text>
                      <Text style={styles.boxMetaCell}><Text style={styles.metaDim}>Ngày ĐG:</Text> {b.packaging_date || b.production_date}</Text>
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

  pullBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#0c4a6e',
    marginRight: 8,
  },
  pullBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 4,
  },
  deleteBoxBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#450a0a',
    marginLeft: 6,
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
  resyncBtn: {
    backgroundColor: '#1e3a8a',
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
  
  boxCardItem: {
    backgroundColor: '#131b2e',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  boxCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  boxIndexTag: {
    backgroundColor: '#064e3b',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  boxIndexTagText: {
    color: '#34d399',
    fontSize: 14,
    fontWeight: '900',
  },
  boxSkuTag: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
    marginLeft: 8,
  },
  boxWeightTag: {
    backgroundColor: '#0c4a6e',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  boxWeightTagText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  boxFullTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 19,
    marginBottom: 6,
  },
  boxMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  boxMetaCell: {
    width: '48%',
    color: '#cbd5e1',
    fontSize: 11,
    marginVertical: 1,
  },
  metaDim: {
    color: '#64748b',
    fontWeight: '600',
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
  cloneBoxBtn: {
    padding: 5,
    marginRight: 6,
    backgroundColor: '#0c4a6e',
    borderRadius: 6,
  },
});