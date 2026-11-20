import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  TextInput,
  Platform,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DeliveryShift,
  InterimCloseStatus,
  ConfirmInterimCloseResult,
  syncOperationsOfflineQueue,
  getInterimCloseStatus,
  confirmInterimClose,
  cancelMyInterimClose,
} from '../../services/operationsService';
import { LocalPickedImage, uploadOperationImages } from '../../services/operationImagesService';
import OperationImagePickerBar from './OperationImagePickerBar';

interface Props {
  visible: boolean;
  shift: DeliveryShift | null;
  onClose: () => void;
  onSuccess: (result?: ConfirmInterimCloseResult) => void | Promise<void>;
  onSyncedReload?: () => void | Promise<void>;
  user: any;
}

export default function InterimCloseModal({
  visible,
  shift,
  onClose,
  onSuccess,
  onSyncedReload,
  user,
}: Props) {
  const insets = useSafeAreaInsets();
  const [notes, setNotes] = useState('');
  const [images, setImages] = useState<LocalPickedImage[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [status, setStatus] = useState<InterimCloseStatus | null>(null);
  const [keepWaiting, setKeepWaiting] = useState(false);

  const currentUserId = user?.id ? String(user.id) : '';
  const currentUserName = (user?.full_name || user?.email || '').trim().toLowerCase();

  const loadStatusOnline = useCallback(async () => {
    if (!shift) return;
    setLoadingStatus(true);
    setOfflineError(null);
    try {
      const syncRes = await syncOperationsOfflineQueue();
      if (!syncRes.success) {
        throw new Error('OFFLINE_SYNC_INCOMPLETE');
      }
      const st = await getInterimCloseStatus(shift.id);
      setStatus(st);
      if (onSyncedReload) {
        await onSyncedReload();
      }
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg === 'OFFLINE_REQUIRED') {
        setOfflineError(
          'Chốt ca tạm BẮT BUỘC phải có kết nối mạng để đồng bộ số liệu của bạn và tải số liệu của mọi người. Vui lòng mở Wifi / 4G rồi bấm "Kiểm tra lại mạng".'
        );
      } else if (msg === 'OFFLINE_SYNC_INCOMPLETE') {
        setOfflineError(
          'Còn số liệu ngoại tuyến chưa đẩy được lên máy chủ do mạng yếu/mất mạng. Vui lòng ra chỗ có sóng rồi thử lại.'
        );
      } else if (msg === 'OFFLINE_SHIFT_UNSYNCED') {
        setOfflineError(
          'Công việc này được tạo lúc mất mạng và chưa đồng bộ lên máy chủ. Vui lòng bật mạng để đồng bộ trước.'
        );
      } else {
        setOfflineError(`Không thể kết nối máy chủ: ${msg}`);
      }
      setStatus(null);
    } finally {
      setLoadingStatus(false);
    }
  }, [shift, onSyncedReload]);

  useEffect(() => {
    if (!visible || !shift) return;
    setNotes('');
    setImages([]);
    setKeepWaiting(false);
    setSubmitting(false);
    void loadStatusOnline();
  }, [visible, shift, loadStatusOnline]);

  if (!shift) return null;

  const participants = status?.participants || [];
  const confirmedUsers = status?.confirmed_users || [];
  const missingUsers = status?.missing_users || [];
  const nextSubNumber = status?.next_sub_shift_number ?? 1;

  const isUserConfirmed = (uid?: string | null, uname?: string | null) => {
    const cleanUid = uid ? String(uid) : '';
    const cleanName = (uname || '').trim().toLowerCase();
    return confirmedUsers.some(c => {
      if (cleanUid && c.user_id) return String(c.user_id) === cleanUid;
      return cleanName && (c.user_name || '').trim().toLowerCase() === cleanName;
    });
  };

  const iHaveConfirmed = isUserConfirmed(currentUserId, currentUserName);
  const otherMissingNames = missingUsers
    .filter(m => {
      if (currentUserId && m.user_id) return String(m.user_id) !== currentUserId;
      return (m.user_name || '').trim().toLowerCase() !== currentUserName;
    })
    .map(m => m.user_name);

  const runConfirm = async (forceFinalize = false) => {
    if (submitting || loadingStatus) return;
    setSubmitting(true);
    setOfflineError(null);
    try {
      const result = await confirmInterimClose({
        shift,
        user,
        notes: notes.trim() || undefined,
        forceFinalize,
        keepWaiting: !forceFinalize && keepWaiting,
      });

      if (images.length > 0) {
        await uploadOperationImages({
          images,
          systemCode: shift.system_code,
          companyId: shift.company_id || user?.company_id || null,
          shiftId: shift.id,
          subShiftId: result.sub_shift?.id || null,
          scope: 'sub_shift',
          jobName: shift.summary_data?.job_name || shift.notes || 'Công việc',
          user,
          notes: notes.trim() || `Ảnh chốt ca tạm đợt #${result.sub_shift_number}`,
        });
      }

      setNotes('');
      setImages([]);
      await onSuccess(result);

      if (result.status === 'finalized') {
        Alert.alert(
          'Hoàn tất Chốt Ca Tạm',
          `Đã hoàn tất Chốt ca tạm Đợt #${result.sub_shift_number} với đầy đủ số liệu của mọi người!`
        );
        onClose();
      } else {
        const waitingNames = result.missing_users.map(m => m.user_name).join(', ');
        const st = await getInterimCloseStatus(shift.id);
        setStatus(st);
        Alert.alert(
          'Bạn đã xác nhận chốt tạm',
          waitingNames
            ? `Đã đồng bộ số liệu của bạn và tải đầy đủ lượt nhập/xuất của mọi người.\n\n⏳ Còn chưa chốt: ${waitingNames}`
            : 'Đã ghi nhận chốt tạm phần của bạn. Đang chờ đồng nghiệp khác mở mạng vào chốt tiếp.'
        );
      }
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      if (msg === 'OFFLINE_REQUIRED' || msg === 'OFFLINE_SYNC_INCOMPLETE') {
        setOfflineError(
          'Không có kết nối mạng! Vui lòng mở Wifi / 4G để đồng bộ số liệu và Chốt ca tạm.'
        );
      } else {
        Alert.alert('Lỗi chốt ca tạm', msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleForceFinalizePress = () => {
    Alert.alert(
      'Chốt hoàn tất ngay?',
      `Còn ${missingUsers.length} người chưa bấm chốt (${missingUsers.map(m => m.user_name).join(', ')}).\n\nBạn có chắc chắn muốn chốt hoàn tất Đợt #${nextSubNumber} ngay với số liệu hiện đã có trên máy chủ không?`,
      [
        { text: 'Hủy', style: 'cancel' },
        { text: 'Chốt luôn', style: 'destructive', onPress: () => void runConfirm(true) },
      ]
    );
  };

  const handleCancelMyConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await cancelMyInterimClose(shift.id, user);
      await loadStatusOnline();
      await onSuccess();
    } catch (e: any) {
      Alert.alert('Lỗi', String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View
              style={[
                styles.sheetContainer,
                { paddingBottom: Math.max(insets.bottom, 16) + 8, maxHeight: '88%' },
              ]}
            >
              <View style={styles.handle} />

              <View style={styles.header}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="time-outline" size={20} color="#f59e0b" />
                  <Text style={styles.title}>Chốt Ca Tạm (Đợt #{nextSubNumber})</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <TouchableOpacity
                    onPress={() => void loadStatusOnline()}
                    disabled={loadingStatus}
                    style={styles.closeBtn}
                  >
                    <Ionicons
                      name="refresh-outline"
                      size={18}
                      color={loadingStatus ? '#f59e0b' : '#94a3b8'}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                    <Ionicons name="close" size={20} color="#94a3b8" />
                  </TouchableOpacity>
                </View>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
                <View style={styles.infoBox}>
                  <Text style={styles.jobName} numberOfLines={1}>
                    {shift.summary_data?.job_name || shift.notes || 'Công việc'}
                  </Text>
                  <Text style={styles.hint}>
                    Chốt tạm bắt buộc có mạng để đồng bộ số liệu của từng người lên máy chủ, tổng hợp đủ lượt nhập/xuất của mọi người và xác nhận từng thành viên.
                  </Text>
                </View>

                {loadingStatus && !status && (
                  <View style={styles.loadingBox}>
                    <ActivityIndicator size="small" color="#f59e0b" />
                    <Text style={styles.loadingText}>
                      Đang kiểm tra mạng, đẩy số liệu máy bạn và tải danh sách người tham gia...
                    </Text>
                  </View>
                )}

                {offlineError && (
                  <View style={styles.offlineBox}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                      <Ionicons name="cloud-offline-outline" size={20} color="#fb7185" />
                      <Text style={styles.offlineText}>{offlineError}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => void loadStatusOnline()}
                      disabled={loadingStatus}
                      style={styles.retryBtn}
                    >
                      <Ionicons name="refresh" size={16} color="#fff" />
                      <Text style={styles.retryBtnText}>Kiểm Tra Lại Mạng & Đồng Bộ</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {status && !offlineError && (
                  <>
                    {/* Bảng người tham gia & trạng thái chốt */}
                    <View style={styles.participantsBox}>
                      <View style={styles.participantsHeader}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Ionicons name="people-outline" size={16} color="#fbbf24" />
                          <Text style={styles.participantsTitle}>
                            Tham gia: {status.total_participants} người
                          </Text>
                        </View>
                        <View style={styles.progressBadge}>
                          <Text style={styles.progressBadgeText}>
                            Đã chốt {status.confirmed_count}/{status.total_participants}
                          </Text>
                        </View>
                      </View>

                      <Text style={styles.batchCountText}>
                        Tổng số liệu đợt #{nextSubNumber} (của mọi người):{' '}
                        <Text style={{ color: '#f8fafc', fontWeight: '800' }}>
                          {status.current_batch_count} lượt nhập/xuất
                        </Text>
                      </Text>

                      <View style={{ gap: 6, marginTop: 8 }}>
                        {participants.map((p, idx) => {
                          const done = isUserConfirmed(p.user_id, p.user_name);
                          const isMe =
                            (currentUserId && p.user_id && String(p.user_id) === currentUserId) ||
                            (currentUserName &&
                              (p.user_name || '').trim().toLowerCase() === currentUserName);
                          const uKey = p.user_id || (p.user_name || '').trim().toLowerCase();
                          const uCount = status.per_user_counts?.[uKey] || 0;
                          return (
                            <View
                              key={`${p.user_id || p.user_name}_${idx}`}
                              style={[
                                styles.participantRow,
                                done ? styles.participantRowDone : styles.participantRowPending,
                              ]}
                            >
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={styles.participantName} numberOfLines={1}>
                                  {p.user_name}
                                  {isMe ? ' (Bạn)' : ''}
                                </Text>
                                <Text style={styles.participantSub}>{uCount} lượt nhập/xuất</Text>
                              </View>
                              <Text
                                style={[
                                  styles.participantStatus,
                                  { color: done ? '#34d399' : '#fbbf24' },
                                ]}
                              >
                                {done ? '✅ Đã chốt' : '⏳ Chưa chốt'}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>

                    {iHaveConfirmed ? (
                      <View style={styles.waitingBanner}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Ionicons name="checkmark-circle" size={18} color="#34d399" />
                          <Text style={styles.waitingTitle}>
                            Bạn đã chốt Đợt #{nextSubNumber}!
                          </Text>
                        </View>
                        <Text style={styles.waitingSub}>
                          {missingUsers.length > 0
                            ? `⏳ Đang đợi: ${missingUsers.map(m => m.user_name).join(', ')} mở mạng và bấm Chốt ca tạm.`
                            : '⏳ Đang giữ trạng thái chờ đồng nghiệp khác mở mạng vào chốt cùng đợt này.'}
                        </Text>
                      </View>
                    ) : (
                      <>
                        {otherMissingNames.length > 0 && (
                          <View style={styles.noticeBox}>
                            <Text style={styles.noticeText}>
                              Sau khi bạn chốt, hệ thống sẽ giữ trạng thái chờ:{' '}
                              <Text style={{ fontWeight: '800', color: '#fde68a' }}>
                                {otherMissingNames.join(', ')}
                              </Text>
                            </Text>
                          </View>
                        )}

                        {status.total_participants <= 1 && (
                          <TouchableOpacity
                            onPress={() => setKeepWaiting(v => !v)}
                            style={styles.checkboxRow}
                            activeOpacity={0.7}
                          >
                            <Ionicons
                              name={keepWaiting ? 'checkbox' : 'square-outline'}
                              size={20}
                              color={keepWaiting ? '#f59e0b' : '#64748b'}
                            />
                            <Text style={styles.checkboxText}>
                              Đợi thêm đồng nghiệp trong kho (nếu có người làm chung nhưng chưa mở mạng đồng bộ)
                            </Text>
                          </TouchableOpacity>
                        )}

                        <View style={styles.formGroup}>
                          <Text style={styles.label}>Ghi chú đợt chốt tạm</Text>
                          <TextInput
                            style={styles.input}
                            placeholder="Ví dụ: Chốt xe 01, Hết ca sáng, Tổ 2..."
                            placeholderTextColor="#64748b"
                            value={notes}
                            onChangeText={setNotes}
                          />
                        </View>

                        <OperationImagePickerBar
                          images={images}
                          onChange={setImages}
                          label="Ảnh chứng minh đợt chốt tạm"
                        />
                      </>
                    )}

                    {/* Các nút hành động */}
                    {iHaveConfirmed ? (
                      <View style={{ gap: 8, marginTop: 8 }}>
                        <View style={styles.btnRow}>
                          <TouchableOpacity
                            onPress={() => void handleCancelMyConfirm()}
                            disabled={submitting}
                            style={styles.cancelBtn}
                          >
                            <Text style={styles.cancelBtnText}>Rút xác nhận</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={onClose}
                            style={[styles.submitBtn, { backgroundColor: '#059669' }]}
                          >
                            <Text style={styles.submitBtnText}>Đóng (Đợi người kia)</Text>
                          </TouchableOpacity>
                        </View>
                        <TouchableOpacity
                          onPress={handleForceFinalizePress}
                          disabled={submitting}
                          style={styles.forceBtn}
                        >
                          <Text style={styles.forceBtnText}>
                            Chốt hoàn tất ngay (không đợi người chưa chốt)
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={[styles.btnRow, { marginTop: 8 }]}>
                        <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
                          <Text style={styles.cancelBtnText}>Hủy</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() => void runConfirm(false)}
                          disabled={submitting || loadingStatus}
                          style={styles.submitBtn}
                        >
                          {submitting ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <>
                              <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                              <Text style={styles.submitBtnText}>
                                {otherMissingNames.length > 0 || keepWaiting
                                  ? `Xác Nhận Chốt (${status.confirmed_count + 1}/${Math.max(status.total_participants, 1)})`
                                  : `Hoàn Tất Chốt Đợt #${nextSubNumber}`}
                              </Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                )}
              </ScrollView>
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
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    marginBottom: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc',
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
  },
  body: {
    paddingVertical: 4,
    gap: 10,
  },
  infoBox: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  jobName: {
    fontSize: 14,
    fontWeight: '800',
    color: '#818cf8',
    marginBottom: 4,
  },
  hint: {
    fontSize: 11,
    color: '#94a3b8',
    lineHeight: 16,
  },
  loadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  loadingText: {
    flex: 1,
    fontSize: 12,
    color: '#cbd5e1',
    lineHeight: 17,
  },
  offlineBox: {
    backgroundColor: 'rgba(244, 63, 94, 0.12)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.4)',
    gap: 10,
  },
  offlineText: {
    flex: 1,
    fontSize: 12,
    color: '#fecdd3',
    fontWeight: '600',
    lineHeight: 18,
  },
  retryBtn: {
    height: 40,
    borderRadius: 10,
    backgroundColor: '#e11d48',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  participantsBox: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  participantsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  participantsTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fbbf24',
  },
  progressBadge: {
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 99,
  },
  progressBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#fde68a',
  },
  batchCountText: {
    fontSize: 11,
    color: '#94a3b8',
  },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  participantRowDone: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.35)',
  },
  participantRowPending: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
  },
  participantName: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f8fafc',
  },
  participantSub: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 1,
  },
  participantStatus: {
    fontSize: 11,
    fontWeight: '800',
  },
  waitingBanner: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
    gap: 4,
  },
  waitingTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#34d399',
  },
  waitingSub: {
    fontSize: 12,
    color: '#fde68a',
    lineHeight: 17,
  },
  noticeBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  noticeText: {
    fontSize: 11,
    color: '#fcd34d',
    lineHeight: 16,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  checkboxText: {
    flex: 1,
    fontSize: 11,
    color: '#cbd5e1',
    lineHeight: 16,
  },
  formGroup: {
    marginBottom: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
    marginBottom: 6,
  },
  input: {
    height: 44,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    color: '#f8fafc',
    fontSize: 13,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    backgroundColor: '#334155',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    color: '#cbd5e1',
    fontWeight: '700',
    fontSize: 13,
  },
  submitBtn: {
    flex: 2,
    height: 44,
    backgroundColor: '#d97706',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  submitBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },
  forceBtn: {
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  forceBtnText: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '700',
  },
});
