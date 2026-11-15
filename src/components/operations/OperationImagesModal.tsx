import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  FlatList,
  ScrollView,
  TextInput,
  Image,
  ActivityIndicator,
  Alert,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DeliveryShift, syncOperationsOfflineQueue } from '../../services/operationsService';
import {
  OperationImageRecord,
  capturePhotoWithCamera,
  pickPhotosFromLibrary,
  uploadOperationImages,
  getShiftOperationImages,
  deleteOperationImage,
  getOperationImageDisplayUrl,
  syncOfflineOperationImages,
  cleanupExpiredLocalOriginals,
  getLocalAutoDeleteDays,
  setLocalAutoDeleteDays,
  parseRefPhase,
} from '../../services/operationImagesService';
import {
  getWatermarkEnabled,
  setWatermarkEnabled,
} from '../../services/watermarkService';
import {
  OperationFolder,
  OperationDriveSettings,
  listOperationFolders,
  createOperationFolder,
  deleteOperationFolder,
  getDriveSettings,
  saveDriveSettings,
  syncImagesToGoogleDrive,
} from '../../services/operationDriveService';

export interface JournalImageTarget {
  id: string;
  itemName: string;
  itemSku?: string | null;
  quantity: number;
  unit: string;
  direction: 'in' | 'out';
}

interface Props {
  visible: boolean;
  shift: DeliveryShift | null;
  user: any;
  journalTarget?: JournalImageTarget | null;
  onClose: () => void;
  onChanged?: (count: number) => void;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const GRID_ITEM_SIZE = Math.floor((SCREEN_WIDTH - 48) / 3);

export default function OperationImagesModal({ visible, shift, user, journalTarget, onClose, onChanged }: Props) {
  const insets = useSafeAreaInsets();
  const [images, setImages] = useState<OperationImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'journal' | 'ref' | 'in' | 'out' | 'shift'>('all');
  const [selectedImage, setSelectedImage] = useState<OperationImageRecord | null>(null);

  // Folders & Google Drive
  const [folders, setFolders] = useState<OperationFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [syncingDrive, setSyncingDrive] = useState(false);
  const [driveSettingsModal, setDriveSettingsModal] = useState(false);
  const [driveSettings, setDriveSettings] = useState<OperationDriveSettings>({
    system_code: '',
    webhook_url: '',
    root_folder_name: 'WMS_HinhAnh_Kho',
    auto_sync_enabled: false,
  });
  const [savingDrive, setSavingDrive] = useState(false);
  const [localAutoDeleteDays, setLocalAutoDeleteDaysState] = useState<number | null>(null);
  const [watermarkEnabled, setWatermarkEnabledState] = useState<boolean>(true);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const shiftId = shift?.id || null;
  const shiftSystemCode = shift?.system_code || '';
  const shiftCompanyId = shift?.company_id || null;

  const loadData = useCallback(async () => {
    if (!shiftId) return;
    setLoading(true);
    try {
      await syncOperationsOfflineQueue().catch(() => {});
      await syncOfflineOperationImages().catch(() => {});
      const [list, folderList, cfg, localDays, wmEnabled] = await Promise.all([
        getShiftOperationImages(shiftId),
        listOperationFolders(shiftSystemCode, shiftCompanyId || user?.company_id || null).catch(() => []),
        getDriveSettings(shiftSystemCode).catch(() => ({
          system_code: shiftSystemCode,
          webhook_url: '',
          root_folder_name: 'WMS_HinhAnh_Kho',
          auto_sync_enabled: false,
          auto_delete_local_days: null,
        })),
        getLocalAutoDeleteDays().catch(() => null),
        getWatermarkEnabled().catch(() => true),
      ]);
      setImages(list);
      setFolders(folderList);
      setDriveSettings(cfg);
      setLocalAutoDeleteDaysState(localDays);
      setWatermarkEnabledState(wmEnabled);
      onChangedRef.current?.(list.length);
      cleanupExpiredLocalOriginals(shiftSystemCode, localDays).catch(() => {});
    } finally {
      setLoading(false);
    }
  }, [shiftId, shiftSystemCode, shiftCompanyId, user?.company_id]);

  useEffect(() => {
    if (!visible || !shiftId) return;
    const timer = setTimeout(() => {
      void loadData();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, shiftId, loadData]);

  const childFolders = useMemo(
    () => folders.filter((f) => (f.parent_id || null) === selectedFolderId),
    [folders, selectedFolderId]
  );

  const selectedFolderObj = useMemo(
    () => folders.find((f) => f.id === selectedFolderId) || null,
    [folders, selectedFolderId]
  );

  const baseImages = useMemo(() => {
    return images.filter((img) => {
      if (journalTarget && img.journal_id !== journalTarget.id) return false;
      if (selectedFolderId && img.folder_id !== selectedFolderId) return false;
      return true;
    });
  }, [images, journalTarget, selectedFolderId]);

  const filteredImages = useMemo(() => {
    return baseImages.filter((img) => {
      const refPhase = parseRefPhase(img.notes);
      if (filter === 'all') return true;
      if (filter === 'ref') return refPhase !== null;
      if (filter === 'journal') {
        return !refPhase && (img.scope === 'journal' || img.direction === 'in' || img.direction === 'out');
      }
      if (filter === 'in') return !refPhase && img.direction === 'in';
      if (filter === 'out') return !refPhase && img.direction === 'out';
      return !refPhase && img.scope !== 'journal' && !img.direction && (img.scope === 'shift' || img.scope === 'sub_shift');
    });
  }, [baseImages, filter]);

  const unsyncedImages = useMemo(
    () => filteredImages.filter((img) => !img.is_offline && !img.drive_file_id),
    [filteredImages]
  );

  if (!shift) return null;

  const jobName = shift.summary_data?.job_name || shift.notes || 'Công việc';

  const handleAddFromCamera = async () => {
    if (uploading) return;
    const photo = await capturePhotoWithCamera();
    if (!photo) return;
    setUploading(true);
    try {
      await uploadOperationImages({
        images: [photo],
        systemCode: shift.system_code,
        companyId: shift.company_id || user?.company_id || null,
        shiftId: shift.id,
        journalId: journalTarget?.id || null,
        folderId: selectedFolderId,
        scope: journalTarget ? 'journal' : 'shift',
        direction: journalTarget?.direction || null,
        jobName,
        itemName: journalTarget?.itemName || null,
        itemSku: journalTarget?.itemSku || null,
        quantity: journalTarget?.quantity ?? null,
        unit: journalTarget?.unit || null,
        user,
      });
      await loadData();
    } finally {
      setUploading(false);
    }
  };

  const handleAddFromLibrary = async () => {
    if (uploading) return;
    const picked = await pickPhotosFromLibrary(8);
    if (picked.length === 0) return;
    setUploading(true);
    try {
      await uploadOperationImages({
        images: picked,
        systemCode: shift.system_code,
        companyId: shift.company_id || user?.company_id || null,
        shiftId: shift.id,
        journalId: journalTarget?.id || null,
        folderId: selectedFolderId,
        scope: journalTarget ? 'journal' : 'shift',
        direction: journalTarget?.direction || null,
        jobName,
        itemName: journalTarget?.itemName || null,
        itemSku: journalTarget?.itemSku || null,
        quantity: journalTarget?.quantity ?? null,
        unit: journalTarget?.unit || null,
        user,
      });
      await loadData();
    } finally {
      setUploading(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      const created = await createOperationFolder({
        systemCode: shift.system_code,
        companyId: shift.company_id || user?.company_id || null,
        parentId: selectedFolderId,
        name: newFolderName.trim(),
        user,
      });
      setNewFolderName('');
      setShowNewFolderInput(false);
      await loadData();
      setSelectedFolderId(created.id);
    } catch (e: any) {
      alert('Lỗi tạo thư mục: ' + (e?.message || e));
    }
  };

  const handleDeleteFolder = (folder: OperationFolder) => {
    Alert.alert('Xóa thư mục', `Xóa thư mục "${folder.name}"? (Ảnh bên trong vẫn được giữ lại)`, [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteOperationFolder(folder.id);
            if (selectedFolderId === folder.id) {
              setSelectedFolderId(folder.parent_id || null);
            }
            await loadData();
          } catch (e: any) {
            alert('Lỗi xóa thư mục: ' + (e?.message || e));
          }
        },
      },
    ]);
  };

  const handleSyncDrive = async (targetImages: OperationImageRecord[]) => {
    if (syncingDrive || targetImages.length === 0) return;
    if (!driveSettings.webhook_url?.trim()) {
      setDriveSettingsModal(true);
      return;
    }
    setSyncingDrive(true);
    try {
      const res = await syncImagesToGoogleDrive({
        images: targetImages,
        systemCode: shift.system_code,
        folders,
      });
      await loadData();
      if (res.failedCount > 0) {
        Alert.alert('Đồng bộ Google Drive', `Thành công: ${res.syncedCount}, Lỗi: ${res.failedCount}\n${res.errors[0] || ''}`);
      } else {
        Alert.alert('Thành công', `Đã đẩy ${res.syncedCount} ảnh lên Google Drive!`);
      }
    } catch (e: any) {
      Alert.alert('Lỗi Google Drive', e?.message || 'Không thể đồng bộ lên Drive');
    } finally {
      setSyncingDrive(false);
    }
  };

  const handleSaveDrive = async () => {
    setSavingDrive(true);
    try {
      await setLocalAutoDeleteDays(localAutoDeleteDays);
      await setWatermarkEnabled(watermarkEnabled);
      if (driveSettings.webhook_url?.trim()) {
        await saveDriveSettings({
          ...driveSettings,
          system_code: shift.system_code,
          company_id: shift.company_id || user?.company_id || null,
          userId: user?.id || null,
        });
      }
      setDriveSettingsModal(false);
      await syncOfflineOperationImages().catch(() => {});
      await cleanupExpiredLocalOriginals(shift.system_code, localAutoDeleteDays).catch(() => {});
      await loadData();
      Alert.alert('Đã lưu', 'Đã lưu tùy chọn trên máy này và cấu hình đồng bộ Google Drive.');
    } catch (e: any) {
      Alert.alert('Lỗi', e?.message || 'Không thể lưu cấu hình');
    } finally {
      setSavingDrive(false);
    }
  };

  const handleDelete = (img: OperationImageRecord) => {
    Alert.alert('Xóa hình ảnh', 'Bạn chắc chắn muốn xóa hình ảnh chứng minh này?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteOperationImage(img);
            if (selectedImage?.id === img.id) setSelectedImage(null);
            await loadData();
          } catch (e: any) {
            alert('Lỗi xóa ảnh: ' + (e?.message || e));
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: Math.max(insets.top, 12), paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              {journalTarget ? 'Ảnh Đợt Nhập / Xuất' : 'Album & Thư Mục Ảnh'}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {journalTarget
                ? `${journalTarget.itemName} (${journalTarget.direction === 'in' ? '+' : '-'}${journalTarget.quantity} ${journalTarget.unit})`
                : jobName}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => handleSyncDrive(unsyncedImages)}
            disabled={syncingDrive || unsyncedImages.length === 0}
            style={[styles.driveBtn, unsyncedImages.length === 0 && { opacity: 0.45 }]}
          >
            {syncingDrive ? (
              <ActivityIndicator size="small" color="#34d399" />
            ) : (
              <>
                <Ionicons name="cloud-upload-outline" size={16} color="#34d399" />
                <Text style={styles.driveBtnText}>{unsyncedImages.length}</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDriveSettingsModal(true)} style={styles.iconBtn}>
            <Ionicons name="settings-outline" size={18} color="#94a3b8" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color="#cbd5e1" />
          </TouchableOpacity>
        </View>

        <View style={styles.actionBar}>
          <TouchableOpacity
            onPress={handleAddFromCamera}
            disabled={uploading}
            style={[styles.addBtn, styles.addBtnCamera]}
          >
            {uploading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="camera" size={18} color="#fff" />
                <Text style={styles.addBtnText}>{journalTarget ? 'Chụp ảnh đợt này' : 'Chụp ảnh'}</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleAddFromLibrary}
            disabled={uploading}
            style={[styles.addBtn, styles.addBtnLibrary]}
          >
            <Ionicons name="images" size={18} color="#fff" />
            <Text style={styles.addBtnText}>Chọn thư viện</Text>
          </TouchableOpacity>
        </View>

        {/* Thanh Thư mục đa cấp */}
        {!journalTarget && (
          <View style={styles.folderSection}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderScroll}>
              <TouchableOpacity
                onPress={() => setSelectedFolderId(null)}
                style={[styles.folderChip, !selectedFolderId && styles.folderChipActive]}
              >
                <Ionicons name="folder-open-outline" size={14} color={!selectedFolderId ? '#fff' : '#fbbf24'} />
                <Text style={[styles.folderChipText, !selectedFolderId && { color: '#fff' }]}>Tất cả</Text>
              </TouchableOpacity>

              {selectedFolderObj && (
                <TouchableOpacity
                  onPress={() => setSelectedFolderId(selectedFolderObj.parent_id || null)}
                  style={styles.folderBackChip}
                >
                  <Ionicons name="arrow-up" size={13} color="#cbd5e1" />
                  <Text style={styles.folderChipText}>{selectedFolderObj.name}</Text>
                </TouchableOpacity>
              )}

              {childFolders.map((folder) => (
                <TouchableOpacity
                  key={folder.id}
                  onPress={() => setSelectedFolderId(folder.id)}
                  onLongPress={() => handleDeleteFolder(folder)}
                  style={styles.folderChip}
                >
                  <Ionicons name="folder" size={14} color="#fbbf24" />
                  <Text style={styles.folderChipText}>{folder.name}</Text>
                </TouchableOpacity>
              ))}

              <TouchableOpacity
                onPress={() => setShowNewFolderInput(!showNewFolderInput)}
                style={styles.newFolderBtn}
              >
                <Ionicons name="add" size={15} color="#38bdf8" />
                <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: '700' }}>Thư mục</Text>
              </TouchableOpacity>
            </ScrollView>

            {showNewFolderInput && (
              <View style={styles.newFolderRow}>
                <TextInput
                  style={styles.newFolderInput}
                  placeholder={selectedFolderObj ? `Thư mục con trong "${selectedFolderObj.name}"...` : 'Tên thư mục mới...'}
                  placeholderTextColor="#64748b"
                  value={newFolderName}
                  onChangeText={setNewFolderName}
                />
                <TouchableOpacity onPress={handleCreateFolder} style={styles.newFolderSave}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Tạo</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={styles.filterRow}
        >
          {[
            { key: 'all', label: `Tất cả (${baseImages.length})` },
            { key: 'journal', label: 'Số liệu N/X' },
            { key: 'ref', label: 'Tham chiếu' },
            { key: 'in', label: 'Nhập' },
            { key: 'out', label: 'Xuất' },
            { key: 'shift', label: 'Chung CV/Đợt' },
          ].map((f) => {
            const active = filter === f.key;
            const activeStyle =
              active && f.key === 'ref'
                ? { backgroundColor: '#d97706', borderColor: '#fbbf24' }
                : active && f.key === 'journal'
                  ? { backgroundColor: '#059669', borderColor: '#34d399' }
                  : active
                    ? styles.filterChipActive
                    : null;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key as any)}
                style={[styles.filterChip, activeStyle]}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color="#38bdf8" />
          </View>
        ) : filteredImages.length === 0 ? (
          <View style={styles.centerBox}>
            <Ionicons name="images-outline" size={48} color="#475569" />
            <Text style={styles.emptyText}>Chưa có hình ảnh chứng minh nào</Text>
            <Text style={styles.emptyHint}>Bấm Chụp ảnh hoặc Chọn thư viện để thêm</Text>
          </View>
        ) : (
          <FlatList
            data={filteredImages}
            keyExtractor={(item) => item.id}
            numColumns={3}
            contentContainerStyle={styles.gridContent}
            columnWrapperStyle={{ gap: 8 }}
            renderItem={({ item }) => {
              const refPhase = parseRefPhase(item.notes);
              return (
              <TouchableOpacity
                style={styles.gridItem}
                onPress={() => setSelectedImage(item)}
                activeOpacity={0.85}
              >
                <Image source={{ uri: getOperationImageDisplayUrl(item) }} style={styles.gridImage} />
                <View style={styles.gridBadgeRow}>
                  {refPhase ? (
                    <View style={[styles.badge, { backgroundColor: '#d97706' }]}>
                      <Text style={styles.badgeText}>
                        {refPhase === 'start' ? 'TC ĐẦU' : refPhase === 'end' ? 'TC CUỐI' : 'THAM CHIẾU'}
                      </Text>
                    </View>
                  ) : (
                    <>
                      {item.direction === 'in' && (
                        <View style={[styles.badge, { backgroundColor: '#10b981' }]}>
                          <Text style={styles.badgeText}>NHẬP</Text>
                        </View>
                      )}
                      {item.direction === 'out' && (
                        <View style={[styles.badge, { backgroundColor: '#f43f5e' }]}>
                          <Text style={styles.badgeText}>XUẤT</Text>
                        </View>
                      )}
                      {item.scope !== 'journal' && (
                        <View style={[styles.badge, { backgroundColor: '#6366f1' }]}>
                          <Text style={styles.badgeText}>{item.scope === 'sub_shift' ? 'ĐỢT' : 'CV'}</Text>
                        </View>
                      )}
                    </>
                  )}
                </View>
                {item.drive_file_id ? (
                  <View style={[styles.offlineTag, { backgroundColor: 'rgba(16,185,129,0.88)' }]}>
                    <Ionicons name="cloud-done" size={11} color="#fff" />
                  </View>
                ) : item.is_offline ? (
                  <View style={styles.offlineTag}>
                    <Ionicons name="cloud-upload-outline" size={11} color="#fbbf24" />
                  </View>
                ) : null}
              </TouchableOpacity>
              );
            }}
          />
        )}

        {/* Viewer phóng to */}
        <Modal
          visible={!!selectedImage}
          transparent
          animationType="fade"
          onRequestClose={() => setSelectedImage(null)}
        >
          {selectedImage && (() => {
            const navList = filteredImages;
            const curIdx = navList.findIndex(x => x.id === selectedImage.id);
            const hasPrev = curIdx > 0;
            const hasNext = curIdx >= 0 && curIdx < navList.length - 1;
            return (
            <View style={styles.viewerOverlay}>
              <View style={[styles.viewerHeader, { justifyContent: 'space-between', alignItems: 'center', width: '100%' }]}>
                <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: 'rgba(30,41,59,0.85)' }}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>
                    {curIdx >= 0 ? `${curIdx + 1} / ${navList.length}` : '1 / 1'}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  {!selectedImage.drive_file_id && !selectedImage.is_offline && (
                    <TouchableOpacity
                      onPress={() => handleSyncDrive([selectedImage])}
                      disabled={syncingDrive}
                      style={styles.viewerDriveBtn}
                    >
                      <Ionicons name="cloud-upload-outline" size={18} color="#34d399" />
                      <Text style={{ color: '#34d399', fontSize: 12, fontWeight: '700' }}>Đẩy Drive</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => handleDelete(selectedImage)} style={styles.viewerDeleteBtn}>
                    <Ionicons name="trash-outline" size={20} color="#fda4af" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSelectedImage(null)} style={styles.viewerCloseBtn}>
                    <Ionicons name="close" size={24} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>
              <View style={{ flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
                {hasPrev && (
                  <TouchableOpacity
                    onPress={() => setSelectedImage(navList[curIdx - 1])}
                    style={{
                      position: 'absolute',
                      left: 6,
                      zIndex: 10,
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      backgroundColor: 'rgba(15,23,42,0.8)',
                      borderWidth: 1,
                      borderColor: 'rgba(255,255,255,0.25)',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Ionicons name="chevron-back" size={26} color="#fff" />
                  </TouchableOpacity>
                )}
                <Image
                  source={{ uri: getOperationImageDisplayUrl(selectedImage) }}
                  style={styles.viewerImage}
                  resizeMode="contain"
                />
                {hasNext && (
                  <TouchableOpacity
                    onPress={() => setSelectedImage(navList[curIdx + 1])}
                    style={{
                      position: 'absolute',
                      right: 6,
                      zIndex: 10,
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      backgroundColor: 'rgba(15,23,42,0.8)',
                      borderWidth: 1,
                      borderColor: 'rgba(255,255,255,0.25)',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Ionicons name="chevron-forward" size={26} color="#fff" />
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.viewerMeta}>
                {selectedImage.item_name ? (
                  <Text style={styles.viewerTitle}>
                    {selectedImage.item_name} — {selectedImage.quantity} {selectedImage.unit || ''}
                  </Text>
                ) : (
                  <Text style={styles.viewerTitle}>
                    {selectedImage.scope === 'sub_shift' ? 'Ảnh Đợt Chốt Tạm' : 'Ảnh Công Việc'}
                  </Text>
                )}
                <Text style={styles.viewerSub}>
                  {selectedImage.captured_by_name || 'Nhân viên'} •{' '}
                  {new Date(selectedImage.captured_at).toLocaleString('vi-VN')}
                  {selectedImage.drive_file_id ? ' • Đã lưu Drive' : ''}
                </Text>
                {selectedImage.notes ? (
                  <Text style={styles.viewerNote}>{selectedImage.notes}</Text>
                ) : null}
              </View>
            </View>
            );
          })()}
        </Modal>

        {/* Modal Cài đặt Google Drive */}
        <Modal
          visible={driveSettingsModal}
          transparent
          animationType="slide"
          onRequestClose={() => setDriveSettingsModal(false)}
        >
          <View style={styles.settingsOverlay}>
            <View style={styles.settingsSheet}>
              <Text style={styles.settingsTitle}>Cài Đặt Google Drive ({shift.system_code})</Text>
              <Text style={styles.settingsLabel}>Google Apps Script Webhook URL</Text>
              <TextInput
                style={styles.settingsInput}
                placeholder="https://script.google.com/macros/s/.../exec"
                placeholderTextColor="#64748b"
                value={driveSettings.webhook_url}
                onChangeText={(t) => setDriveSettings((prev) => ({ ...prev, webhook_url: t }))}
                autoCapitalize="none"
              />
              <Text style={styles.settingsLabel}>Tên thư mục gốc trên Drive</Text>
              <TextInput
                style={styles.settingsInput}
                placeholder="WMS_HinhAnh_Kho"
                placeholderTextColor="#64748b"
                value={driveSettings.root_folder_name}
                onChangeText={(t) => setDriveSettings((prev) => ({ ...prev, root_folder_name: t }))}
              />
              <Text style={styles.settingsLabel}>
                Tự động xóa ảnh gốc trên máy này (khi đã đồng bộ Drive)
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {[
                  { label: 'Không xóa', value: null },
                  { label: '1 ngày', value: 1 },
                  { label: '3 ngày', value: 3 },
                  { label: '7 ngày', value: 7 },
                  { label: '14 ngày', value: 14 },
                  { label: '30 ngày', value: 30 },
                ].map((opt) => {
                  const active = (localAutoDeleteDays ?? null) === opt.value;
                  return (
                    <TouchableOpacity
                      key={String(opt.value)}
                      onPress={() => setLocalAutoDeleteDaysState(opt.value)}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: active ? '#10b981' : '#334155',
                        backgroundColor: active ? 'rgba(16,185,129,0.18)' : '#0f172a',
                      }}
                    >
                      <Text style={{ color: active ? '#34d399' : '#cbd5e1', fontSize: 12, fontWeight: '700' }}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>
                * Chỉ áp dụng cho điện thoại này. File nén tạm luôn tự xóa ngay sau khi đẩy lên Drive thành công.
              </Text>
              <TouchableOpacity
                onPress={() => setWatermarkEnabledState((v) => !v)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: watermarkEnabled ? 'rgba(245,158,11,0.12)' : '#0f172a',
                  borderWidth: 1,
                  borderColor: watermarkEnabled ? '#f59e0b' : '#334155',
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  marginTop: 6,
                }}
              >
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={{ color: '#f8fafc', fontSize: 12, fontWeight: '700' }}>
                    Đóng dấu thông tin lên ảnh (Timemark)
                  </Text>
                  <Text style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
                    Tự ghi ngày giờ, kho, tên hàng, số lượng &amp; người chụp vào ảnh
                  </Text>
                </View>
                <Ionicons
                  name={watermarkEnabled ? 'checkmark-circle' : 'ellipse-outline'}
                  size={22}
                  color={watermarkEnabled ? '#fbbf24' : '#64748b'}
                />
              </TouchableOpacity>
              <View style={{ backgroundColor: 'rgba(99,102,241,0.12)', borderColor: 'rgba(99,102,241,0.35)', borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 4 }}>
                <Text style={{ color: '#c7d2fe', fontSize: 11, lineHeight: 16 }}>
                  💡 Chỉ cần cài đặt 1 lần trên Web (mục Số Liệu → Album Hình Ảnh → Cài đặt Google Drive) hoặc dán URL vào đây, toàn bộ thiết bị trong kho sẽ tự động dùng chung. Ảnh giữ trên máy khi mất mạng và tự đẩy lên Google Drive khi có mạng.
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                <TouchableOpacity onPress={() => setDriveSettingsModal(false)} style={styles.settingsCancelBtn}>
                  <Text style={{ color: '#cbd5e1', fontWeight: '700' }}>Đóng</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleSaveDrive} disabled={savingDrive} style={styles.settingsSaveBtn}>
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{savingDrive ? 'Đang lưu...' : 'Lưu'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 12,
  },
  title: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 13,
    marginTop: 2,
  },
  driveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  driveBtnText: {
    color: '#34d399',
    fontSize: 12,
    fontWeight: '800',
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBar: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  addBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 12,
  },
  addBtnCamera: {
    backgroundColor: '#0284c7',
  },
  addBtnLibrary: {
    backgroundColor: '#6366f1',
  },
  addBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  folderSection: {
    marginBottom: 10,
    gap: 8,
  },
  folderScroll: {
    gap: 6,
    alignItems: 'center',
  },
  folderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  folderChipActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  folderBackChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#334155',
  },
  folderChipText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '700',
  },
  newFolderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#38bdf8',
  },
  newFolderRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  newFolderInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    color: '#f8fafc',
    fontSize: 13,
  },
  newFolderSave: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  filterChipActive: {
    backgroundColor: '#0ea5e9',
    borderColor: '#38bdf8',
  },
  filterText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  filterTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyText: {
    color: '#cbd5e1',
    fontSize: 15,
    fontWeight: '700',
  },
  emptyHint: {
    color: '#64748b',
    fontSize: 13,
  },
  gridContent: {
    gap: 8,
    paddingBottom: 24,
  },
  gridItem: {
    width: GRID_ITEM_SIZE,
    height: GRID_ITEM_SIZE,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#1e293b',
    position: 'relative',
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  gridBadgeRow: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    flexDirection: 'row',
    gap: 4,
  },
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
  },
  offlineTag: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(15,23,42,0.8)',
    borderRadius: 10,
    padding: 3,
  },
  viewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'space-between',
    paddingVertical: 40,
  },
  viewerHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
  },
  viewerDriveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(16,185,129,0.2)',
  },
  viewerDeleteBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(244,63,94,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerCloseBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: {
    width: '100%',
    flex: 1,
  },
  viewerMeta: {
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 4,
  },
  viewerTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  viewerSub: {
    color: '#94a3b8',
    fontSize: 12,
  },
  viewerNote: {
    color: '#cbd5e1',
    fontSize: 13,
    marginTop: 2,
  },
  settingsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  settingsSheet: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 10,
  },
  settingsTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 4,
  },
  settingsLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  settingsInput: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f8fafc',
    fontSize: 13,
  },
  settingsCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#334155',
    alignItems: 'center',
  },
  settingsSaveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
  },
});
