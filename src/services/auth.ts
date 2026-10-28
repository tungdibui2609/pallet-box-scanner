import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabaseClient, resetSupabaseClient, withTimeout } from './supabase';
import { UserProfile, CompanyInfo } from '../types/auth';

const STORAGE_KEY_PROFILE = 'auth_user_profile';
const STORAGE_KEY_OFFLINE_CREDENTIALS = 'auth_offline_credentials';

export interface OfflineCredentials {
  inputIdentifier: string;
  email: string;
  username?: string;
  fullName: string;
  lastLoginAt: string;
}

export async function getOfflineCredentials(): Promise<OfflineCredentials | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_OFFLINE_CREDENTIALS);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveOfflineCredentials(creds: OfflineCredentials): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_OFFLINE_CREDENTIALS, JSON.stringify(creds));
  } catch {}
}

export async function getStoredUser(): Promise<UserProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_PROFILE);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveStoredUser(profile: UserProfile): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_PROFILE, JSON.stringify(profile));
  } catch {}
}

export async function resolveEmailFromInput(input: string, client: any): Promise<string> {
  const cleanInput = input.trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanInput);
  if (isEmail) return cleanInput;

  // Check if input is prefix.username (e.g. ctg.phuc)
  const prefixMatch = cleanInput.match(/^([a-z0-9]+)\.([a-z0-9_.-]+)$/i);
  if (prefixMatch) {
    return `${cleanInput}@system.local`;
  }

  // Try RPC get_user_email_by_username
  try {
    const { data: userEmail, error } = await client.rpc('get_user_email_by_username', {
      p_username: cleanInput
    });
    if (!error && userEmail) {
      return userEmail;
    }
  } catch {
    // Fallback if RPC fails
  }

  // Last attempt: query user_profiles directly
  try {
    const { data: found } = await client
      .from('user_profiles')
      .select('email')
      .ilike('username', cleanInput)
      .maybeSingle();

    if (found?.email) {
      return found.email;
    }
  } catch {
    // ignore
  }

  return cleanInput;
}

export async function fetchUserProfile(userId: string, client: any): Promise<UserProfile | null> {
  try {
    const { data, error } = await client
      .from('user_profiles')
      .select(`
        id,
        email,
        full_name,
        username,
        employee_code,
        department,
        phone,
        company_id,
        allowed_systems,
        companies ( id, name, code )
      `)
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) return null;

    const companyData = data.companies as any;
    let company: CompanyInfo | null = companyData ? {
      id: companyData.id,
      name: companyData.name,
      code: companyData.code
    } : null;

    if (!company && data.company_id) {
      try {
        const { data: comp } = await client
          .from('companies')
          .select('id, name, code')
          .eq('id', data.company_id)
          .maybeSingle();
        if (comp) {
          company = comp;
        } else if (data.company_id === 'b503014d-19b6-464e-91f3-f34eba4b4b05') {
          company = {
            id: data.company_id,
            name: 'Công Ty Cổ Phần Tập Đoàn XNK Trái Cây Chánh Thu',
            code: 'CTG'
          };
        }
      } catch {}
    }

    const profile: UserProfile = {
      id: data.id,
      email: data.email,
      full_name: data.full_name || 'Nhân viên',
      username: data.username,
      employee_code: data.employee_code,
      department: data.department,
      phone: data.phone,
      company_id: data.company_id,
      company,
      allowed_systems: data.allowed_systems
    };

    await saveStoredUser(profile);
    return profile;
  } catch (err) {
    console.error('Lỗi lấy thông tin người dùng:', err);
    return null;
  }
}

export async function loginUser(
  usernameOrEmail: string,
  pass: string
): Promise<{ success: boolean; user?: UserProfile; message?: string; isOffline?: boolean }> {
  const cleanInput = usernameOrEmail.trim().toLowerCase();
  const storedUser = await getStoredUser();
  const offlineCreds = await getOfflineCredentials();

  try {
    const client = await getSupabaseClient();
    const resolvedEmail = await withTimeout(
      resolveEmailFromInput(usernameOrEmail, client),
      6000,
      'Timeout phân giải email'
    );

    const { data: authData, error: authErr } = await withTimeout(
      client.auth.signInWithPassword({
        email: resolvedEmail,
        password: pass
      }),
      8000,
      'Quá thời gian xác thực tài khoản'
    );

    if (authErr) {
      if (authErr.message.includes('Invalid login credentials')) {
        return { success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' };
      }
      throw authErr;
    }

    if (!authData?.user) {
      return { success: false, message: 'Không thể xác thực tài khoản' };
    }

    let profile = await fetchUserProfile(authData.user.id, client);
    if (!profile) {
      // Fallback profile if user_profiles row isn't yet created
      profile = {
        id: authData.user.id,
        email: authData.user.email || resolvedEmail,
        full_name: authData.user.user_metadata?.full_name || authData.user.email || 'Nhân viên',
      };
    }

    // Lưu hẳn tài khoản vào máy vĩnh viễn (lần 2 vào app không cần mạng)
    await saveStoredUser(profile);
    await saveOfflineCredentials({
      inputIdentifier: cleanInput,
      email: (profile.email || resolvedEmail).toLowerCase(),
      username: (profile.username || '').toLowerCase(),
      fullName: profile.full_name,
      lastLoginAt: new Date().toISOString()
    });

    return { success: true, user: profile };
  } catch (err: any) {
    const errMsg = err?.message || '';
    const isNetworkError =
      errMsg.includes('Network') ||
      errMsg.includes('timeout') ||
      errMsg.includes('Failed to fetch') ||
      errMsg.includes('Quá thời gian') ||
      errMsg.includes('offline');

    // NẾU KHÔNG CÓ MẠNG: Cho phép đăng nhập ngoại tuyến nếu thông tin khớp với tài khoản đã lưu
    if (isNetworkError && storedUser) {
      const matchEmail = storedUser.email?.toLowerCase() === cleanInput;
      const matchUsername = storedUser.username?.toLowerCase() === cleanInput;
      const matchIdentifier = offlineCreds?.inputIdentifier === cleanInput;
      const matchResolved = offlineCreds?.email === cleanInput;

      if (matchEmail || matchUsername || matchIdentifier || matchResolved) {
        return {
          success: true,
          user: storedUser,
          isOffline: true,
          message: 'Đăng nhập ngoại tuyến thành công'
        };
      }
    }

    return {
      success: false,
      message: isNetworkError
        ? 'Không có kết nối mạng tới máy chủ. Vui lòng kết nối Internet lần đầu hoặc sử dụng tài khoản đã lưu trên máy.'
        : errMsg || 'Lỗi kết nối máy chủ'
    };
  }
}

export async function logoutUser(): Promise<void> {
  try {
    const client = await getSupabaseClient();
    await withTimeout(client.auth.signOut(), 3000, 'Signout timeout');
  } catch (err) {
    console.warn('Lỗi đăng xuất:', err);
  } finally {
    // Chỉ xóa tài khoản khỏi máy khi người dùng chủ động bấm Đăng Xuất!
    await AsyncStorage.removeItem(STORAGE_KEY_PROFILE);
    await AsyncStorage.removeItem(STORAGE_KEY_OFFLINE_CREDENTIALS);
    resetSupabaseClient();
  }
}

export async function checkSessionUser(): Promise<UserProfile | null> {
  const stored = await getStoredUser();

  try {
    const client = await getSupabaseClient();
    // Bọc timeout 4s để nếu thiết bị không có mạng thì không làm đơ app
    const sessionRes = await withTimeout(client.auth.getSession(), 4000, 'Offline timeout');
    const session = sessionRes?.data?.session;

    if (session?.user) {
      // Có mạng và session còn hiệu lực: cập nhật profile mới nhất từ cloud
      const freshProfile = await fetchUserProfile(session.user.id, client);
      if (freshProfile) {
        await saveStoredUser(freshProfile);
        return freshProfile;
      }
    }

    // Nếu không lấy được session cloud (do offline / token refresh chậm):
    // TUYỆT ĐỐI KHÔNG XÓA PROFILE ĐÃ LƯU, GIỮ NGUYÊN TÀI KHOẢN CHO NGƯỜI DÙNG!
    return stored;
  } catch {
    // Hoàn toàn ngoại tuyến: giữ nguyên tài khoản đã lưu trên máy
    return stored;
  }
}
