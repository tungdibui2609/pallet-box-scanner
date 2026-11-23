import React, { useEffect, useRef, useState } from 'react';
import { TouchableOpacity, Alert, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  normalizeWarehouseVoiceText,
  WAREHOUSE_VOICE_CONTEXT_STRINGS,
} from '../../utils/voiceTextNormalizer';

// Nạp an toàn để không crash khi chạy thử trên Expo Go (chỉ kích hoạt native khi cài bản APK)
let SpeechModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('expo-speech-recognition');
  SpeechModule = pkg?.ExpoSpeechRecognitionModule || null;
} catch {
  SpeechModule = null;
}

interface VoiceMicButtonProps {
  /** Callback khi nhận xong câu nói (đã chuẩn hóa số lượng & thuật ngữ kho) */
  onResult: (normalizedText: string) => void;
  /** Optional: hiển thị chữ đang nghe dở */
  onInterim?: (text: string) => void;
  size?: number;
}

// Đảm bảo chỉ có 1 nút Micro active tại một thời điểm trên màn hình
let activeMicId: string | null = null;

export function VoiceMicButton({ onResult, onInterim, size = 15 }: VoiceMicButtonProps) {
  const idRef = useRef(`mic_${Math.random().toString(36).slice(2, 9)}`);
  const [listening, setListening] = useState(false);
  const onResultRef = useRef(onResult);
  const onInterimRef = useRef(onInterim);
  const retriedOfflineRef = useRef(false);

  useEffect(() => {
    onResultRef.current = onResult;
    onInterimRef.current = onInterim;
  }, [onResult, onInterim]);

  useEffect(() => {
    if (!SpeechModule?.addListener) return;

    const subStart = SpeechModule.addListener('start', () => {
      if (activeMicId === idRef.current) {
        setListening(true);
      }
    });

    const subEnd = SpeechModule.addListener('end', () => {
      if (activeMicId === idRef.current) {
        setListening(false);
        activeMicId = null;
        onInterimRef.current?.('');
      }
    });

    const subResult = SpeechModule.addListener('result', (event: any) => {
      if (activeMicId !== idRef.current) return;
      const transcript = event?.results?.[0]?.transcript || '';
      if (!transcript) return;

      if (event.isFinal) {
        const normalized = normalizeWarehouseVoiceText(transcript);
        onInterimRef.current?.('');
        if (normalized) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          onResultRef.current(normalized);
        }
      } else {
        onInterimRef.current?.(transcript);
      }
    });

    const subError = SpeechModule.addListener('error', (event: any) => {
      if (activeMicId !== idRef.current) return;
      const code = String(event?.error || '');

      // Nếu lỗi mạng trên Android và chưa thử chế độ Offline trên máy -> tự động chuyển sang on-device
      if (
        Platform.OS === 'android' &&
        (code === 'network' || code === 'network-timeout') &&
        !retriedOfflineRef.current
      ) {
        retriedOfflineRef.current = true;
        try {
          SpeechModule.start({
            lang: 'vi-VN',
            interimResults: true,
            continuous: false,
            requiresOnDeviceRecognition: true,
            contextualStrings: WAREHOUSE_VOICE_CONTEXT_STRINGS,
          });
          return;
        } catch {}
      }

      setListening(false);
      activeMicId = null;
      onInterimRef.current?.('');

      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed') {
        Alert.alert(
          'Cần quyền Micro',
          'Vui lòng cấp quyền Microphone trong Cài đặt ứng dụng để nhập ghi chú bằng giọng nói.'
        );
      } else if (code === 'network' || code === 'network-timeout' || code === 'service-not-allowed') {
        Alert.alert(
          'Chưa có gói giọng nói Offline',
          'Máy đang không có mạng. Để nói chuyển thành chữ khi mất mạng, hãy vào Cài đặt điện thoại → Google → Nhận dạng giọng nói ngoại tuyến → tải gói Tiếng Việt.'
        );
      }
    });

    return () => {
      subStart?.remove?.();
      subEnd?.remove?.();
      subResult?.remove?.();
      subError?.remove?.();
      if (activeMicId === idRef.current) {
        activeMicId = null;
        try {
          SpeechModule.abort();
        } catch {}
      }
    };
  }, []);

  const handlePress = async () => {
    try {
      if (listening && SpeechModule) {
        SpeechModule.stop();
        return;
      }

      if (!SpeechModule || !SpeechModule.isRecognitionAvailable?.()) {
        Alert.alert(
          'Cần bản cài APK để dùng Micro',
          'Expo Go không hỗ trợ module nhận dạng giọng nói native. Hãy build & cài bản APK mới để sử dụng tính năng này.'
        );
        return;
      }

      const perm = await SpeechModule.requestPermissionsAsync();
      if (!perm?.granted) {
        Alert.alert(
          'Cần quyền Micro',
          'Vui lòng cho phép ứng dụng sử dụng Microphone để nói ghi chú.'
        );
        return;
      }

      if (activeMicId && activeMicId !== idRef.current) {
        try {
          SpeechModule.abort();
        } catch {}
      }

      activeMicId = idRef.current;
      retriedOfflineRef.current = false;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

      SpeechModule.start({
        lang: 'vi-VN',
        interimResults: true,
        continuous: false,
        addsPunctuation: false,
        contextualStrings: WAREHOUSE_VOICE_CONTEXT_STRINGS,
      });
    } catch (e: any) {
      setListening(false);
      activeMicId = null;
      Alert.alert('Lỗi Micro', e?.message || 'Không thể khởi động nhận dạng giọng nói.');
    }
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.7}
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: listening ? '#f43f5e' : 'rgba(56, 189, 248, 0.16)',
        borderWidth: 1,
        borderColor: listening ? '#fda4af' : 'rgba(56, 189, 248, 0.4)',
      }}
    >
      <Feather
        name={listening ? 'mic-off' : 'mic'}
        size={size}
        color={listening ? '#ffffff' : '#38bdf8'}
      />
    </TouchableOpacity>
  );
}
