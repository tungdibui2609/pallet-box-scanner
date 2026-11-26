import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { TouchableOpacity, View, Text, Alert, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Network from 'expo-network';
import {
  useAudioRecorder,
  useAudioPlayer,
  useAudioPlayerStatus,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';
import {
  processSingleVoiceOnlineApp,
  resolvePlayableAudioUrlForApp,
} from '../../services/inventoryVoiceService';
import { getAutoTranscribeVoiceOnStop } from '../../services/appSettings';

export interface AppOfflineVoicePayload {
  localUri: string;
  mimeType: string;
  durationSec: number;
}

export interface VoiceMicStopResult {
  wasRecording: boolean;
  savedOffline?: boolean;
  text?: string;
  voiceUrl?: string | null;
}

export interface VoiceMicButtonHandle {
  isRecording: () => boolean;
  stopAndFinalize: () => Promise<VoiceMicStopResult>;
}

/**
 * Registry toàn cục theo dõi nút Micro đang ghi âm hiện tại:
 * - Khi bấm Micro ở ô khác -> tự động dừng & lưu ghi âm của ô trước đó.
 * - Khi bấm "HOÀN TẤT" / đóng modal -> gọi `stopAnyActiveVoiceRecording()` để tự dừng & lưu.
 */
let activeVoiceRecorder: {
  id: string;
  stopAndFinalize: () => Promise<VoiceMicStopResult>;
} | null = null;

export async function stopAnyActiveVoiceRecording(): Promise<VoiceMicStopResult> {
  if (!activeVoiceRecorder) return { wasRecording: false };
  const current = activeVoiceRecorder;
  return await current.stopAndFinalize();
}

interface VoiceMicButtonProps {
  /** Callback khi dịch AI thành công online (trả về text + voiceUrl đã lưu trên Google Drive) */
  onResult: (normalizedText: string, voiceUrl?: string | null) => void;
  /** Callback khi đang mất mạng (hoặc gọi API lỗi) -> lưu ghi âm offline chờ đồng bộ & AI dịch */
  onOfflineAudio?: (payload: AppOfflineVoicePayload) => void | Promise<void>;
  systemCode?: string;
  companyId?: string | null;
  sessionId?: string | null;
  sessionName?: string | null;
  positionId?: string | null;
  positionCode?: string | null;
  vocabulary?: string[];
  size?: number;
  skipDriveUpload?: boolean;
  rootFolderOverride?: string | null;
}

export const VoiceMicButton = forwardRef<VoiceMicButtonHandle, VoiceMicButtonProps>(function VoiceMicButton({
  onResult,
  onOfflineAudio,
  systemCode = 'KHO_DONG_LANH',
  companyId,
  sessionId,
  sessionName,
  positionId,
  positionCode,
  vocabulary,
  size = 15,
  skipDriveUpload = false,
  rootFolderOverride = null,
}, ref) {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [status, setStatus] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const statusRef = useRef<'idle' | 'recording' | 'transcribing'>('idle');
  const instanceIdRef = useRef<string>(`app_mic_${Math.random().toString(36).slice(2, 10)}`);
  const stoppingPromiseRef = useRef<Promise<VoiceMicStopResult> | null>(null);
  const startedAtRef = useRef<number>(0);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateStatus = (next: 'idle' | 'recording' | 'transcribing') => {
    statusRef.current = next;
    setStatus(next);
  };

  const clearTimer = () => {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  };

  useEffect(() => {
    const myId = instanceIdRef.current;
    return () => {
      clearTimer();
      if (activeVoiceRecorder?.id === myId) {
        activeVoiceRecorder = null;
      }
      try {
        if (audioRecorder.isRecording) {
          void audioRecorder.stop();
        }
      } catch {}
    };
  }, [audioRecorder]);

  const stopAndProcess = (): Promise<VoiceMicStopResult> => {
    if (stoppingPromiseRef.current) {
      return stoppingPromiseRef.current;
    }
    const run = (async (): Promise<VoiceMicStopResult> => {
      clearTimer();
      if (activeVoiceRecorder?.id === instanceIdRef.current) {
        activeVoiceRecorder = null;
      }
      try {
        await audioRecorder.stop();
        const uri = audioRecorder.uri;
        const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));

        try {
          await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        } catch {}

        if (!uri) {
          updateStatus('idle');
          return { wasRecording: true };
        }

        // Kiểm tra chế độ tự động gửi AI trong Cài đặt (mặc định TẮT -> luôn lưu local để nghe lại trước)
        const autoSendOnStop = await getAutoTranscribeVoiceOnStop();
        if (!autoSendOnStop && onOfflineAudio) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          await onOfflineAudio({ localUri: uri, mimeType: 'audio/mp4', durationSec });
          updateStatus('idle');
          return { wasRecording: true, savedOffline: true };
        }

        // Kiểm tra trạng thái mạng
        let isOnline = false;
        try {
          const net = await Network.getNetworkStateAsync();
          isOnline = Boolean(net.isConnected && net.isInternetReachable !== false);
        } catch {
          isOnline = false;
        }

        if (!isOnline || (!skipDriveUpload && !sessionId) || !positionId) {
          if (onOfflineAudio) {
            await onOfflineAudio({ localUri: uri, mimeType: 'audio/mp4', durationSec });
            updateStatus('idle');
            return { wasRecording: true, savedOffline: true };
          }
          updateStatus('idle');
          return { wasRecording: true };
        }

        // Có mạng -> upload Google Drive (trừ khi skipDriveUpload) + dịch Gemini AI ngay
        updateStatus('transcribing');
        try {
          const res = await processSingleVoiceOnlineApp({
            localUri: uri,
            mimeType: 'audio/mp4',
            systemCode,
            companyId,
            sessionId: sessionId || 'warehouse_draft',
            sessionName,
            positionId,
            positionCode,
            vocabulary,
            skipDriveUpload,
            rootFolderOverride,
          });

          if (res.text || res.voiceUrl) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            onResult(res.text, res.voiceUrl);
            return { wasRecording: true, text: res.text, voiceUrl: res.voiceUrl };
          } else if (onOfflineAudio) {
            // Không dịch & không upload được -> cứu file lưu vào hàng chờ offline
            await onOfflineAudio({ localUri: uri, mimeType: 'audio/mp4', durationSec });
            return { wasRecording: true, savedOffline: true };
          }
          return { wasRecording: true };
        } catch {
          if (onOfflineAudio) {
            await onOfflineAudio({ localUri: uri, mimeType: 'audio/mp4', durationSec });
            return { wasRecording: true, savedOffline: true };
          }
          return { wasRecording: true };
        } finally {
          updateStatus('idle');
        }
      } catch (e: any) {
        updateStatus('idle');
        Alert.alert('Lỗi ghi âm', e?.message || 'Không thể dừng ghi âm.');
        return { wasRecording: true };
      } finally {
        stoppingPromiseRef.current = null;
      }
    })();

    stoppingPromiseRef.current = run;
    return run;
  };

  useImperativeHandle(ref, () => ({
    isRecording: () => statusRef.current === 'recording',
    stopAndFinalize: async () => {
      if (statusRef.current !== 'recording') {
        return { wasRecording: false };
      }
      return await stopAndProcess();
    },
  }));

  const handlePress = async () => {
    if (statusRef.current === 'transcribing') return;
    if (statusRef.current === 'recording') {
      await stopAndProcess();
      return;
    }

    // Nếu ô khác đang ghi âm mà chưa bấm dừng -> tự động dừng & lưu ô trước đó rồi mới ghi ô mới
    if (activeVoiceRecorder && activeVoiceRecorder.id !== instanceIdRef.current) {
      await activeVoiceRecorder.stopAndFinalize();
    }

    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          'Cần quyền Micro',
          'Vui lòng cấp quyền Microphone trong Cài đặt ứng dụng để ghi âm ghi chú kiểm kê.'
        );
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      startedAtRef.current = Date.now();
      updateStatus('recording');
      activeVoiceRecorder = {
        id: instanceIdRef.current,
        stopAndFinalize: async () => {
          if (statusRef.current !== 'recording') return { wasRecording: false };
          return await stopAndProcess();
        },
      };
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

      // Tự dừng sau 15 giây nếu nhân viên quên bấm dừng
      autoStopTimerRef.current = setTimeout(() => {
        void stopAndProcess();
      }, 15000);
    } catch (e: any) {
      if (activeVoiceRecorder?.id === instanceIdRef.current) {
        activeVoiceRecorder = null;
      }
      updateStatus('idle');
      Alert.alert('Không thể bật Micro', e?.message || 'Thiết bị không hỗ trợ ghi âm.');
    }
  };

  return (
    <TouchableOpacity
      onPress={() => void handlePress()}
      disabled={status === 'transcribing'}
      activeOpacity={0.7}
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor:
          status === 'recording'
            ? '#f43f5e'
            : status === 'transcribing'
              ? 'rgba(245, 158, 11, 0.2)'
              : 'rgba(56, 189, 248, 0.16)',
        borderWidth: 1,
        borderColor:
          status === 'recording'
            ? '#fda4af'
            : status === 'transcribing'
              ? '#fbbf24'
              : 'rgba(56, 189, 248, 0.4)',
      }}
    >
      {status === 'transcribing' ? (
        <ActivityIndicator size="small" color="#fbbf24" />
      ) : status === 'recording' ? (
        <Feather name="square" size={12} color="#ffffff" />
      ) : (
        <Feather name="mic" size={size} color="#38bdf8" />
      )}
    </TouchableOpacity>
  );
});

/**
 * Thanh phát lại file ghi âm nhỏ gọn (hỗ trợ cả file offline trên máy lẫn file đã lưu trên Google Drive).
 */
export function VoiceAudioPlayerBar({
  localUri,
  voiceNoteUrl,
  durationSec,
  label,
  onDeleteOffline,
  onTranscribeOffline,
  isTranscribing = false,
}: {
  localUri?: string | null;
  voiceNoteUrl?: string | null;
  durationSec?: number;
  label?: string;
  onDeleteOffline?: () => void;
  onTranscribeOffline?: () => void;
  isTranscribing?: boolean;
}) {
  const isOffline = Boolean(localUri);
  const playableSource = localUri || resolvePlayableAudioUrlForApp(voiceNoteUrl) || null;
  const player = useAudioPlayer(playableSource ? { uri: playableSource } : null);
  const playerStatus = useAudioPlayerStatus(player);

  if (!playableSource) return null;

  const isPlaying = Boolean(playerStatus?.playing);

  const handleTogglePlay = () => {
    try {
      if (isPlaying) {
        player.pause();
      } else {
        void player.seekTo(0);
        player.play();
      }
    } catch {}
  };

  return (
    <View
      style={{
        marginTop: 6,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 10,
        backgroundColor: isOffline ? 'rgba(245, 158, 11, 0.12)' : 'rgba(56, 189, 248, 0.12)',
        borderWidth: 1,
        borderColor: isOffline ? 'rgba(245, 158, 11, 0.35)' : 'rgba(56, 189, 248, 0.35)',
        gap: 8,
      }}
    >
      <TouchableOpacity
        onPress={handleTogglePlay}
        activeOpacity={0.7}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}
      >
        <Feather
          name={isPlaying ? 'pause-circle' : 'volume-2'}
          size={15}
          color={isOffline ? '#fbbf24' : '#38bdf8'}
        />
        <Text
          style={{
            color: isOffline ? '#fcd34d' : '#7dd3fc',
            fontSize: 11,
            fontWeight: '800',
            flex: 1,
          }}
          numberOfLines={1}
        >
          {isPlaying
            ? 'Đang phát... (chạm dừng)'
            : label
              ? label
              : isOffline
                ? `Nghe lại (${durationSec || 1}s)`
                : 'Nghe lại ghi âm đã lưu'}
        </Text>
      </TouchableOpacity>

      {isOffline && onTranscribeOffline && (
        <TouchableOpacity
          onPress={onTranscribeOffline}
          disabled={isTranscribing}
          activeOpacity={0.75}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 9,
            paddingVertical: 4,
            borderRadius: 8,
            backgroundColor: isTranscribing
              ? 'rgba(139, 92, 246, 0.18)'
              : 'rgba(139, 92, 246, 0.28)',
            borderWidth: 1,
            borderColor: 'rgba(167, 139, 250, 0.55)',
          }}
        >
          {isTranscribing ? (
            <ActivityIndicator size="small" color="#c4b5fd" />
          ) : (
            <Feather name="cpu" size={12} color="#ddd6fe" />
          )}
          <Text style={{ color: '#ede9fe', fontSize: 11, fontWeight: '800' }}>
            {isTranscribing ? 'Đang dịch...' : 'Dịch'}
          </Text>
        </TouchableOpacity>
      )}

      {isOffline && onDeleteOffline && !isTranscribing && (
        <TouchableOpacity onPress={onDeleteOffline} hitSlop={8}>
          <Feather name="trash-2" size={14} color="#fb7185" />
        </TouchableOpacity>
      )}
    </View>
  );
}
